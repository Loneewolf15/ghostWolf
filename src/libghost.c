#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <sys/stat.h>
#include <time.h>

// Function pointers for the real X11 functions
static XImage *(*real_XGetImage)(Display *display, Drawable d, int x, int y, unsigned int width, unsigned int height, unsigned long plane_mask, int format) = NULL;
static Bool (*real_XShmGetImage)(Display *display, Drawable d, XImage *image, int x, int y, unsigned long plane_mask) = NULL;

typedef void *(*dlsym_t)(void *, const char *);
static dlsym_t get_real_dlsym() {
    static dlsym_t real = NULL;
    if (!real) {
        real = (dlsym_t)dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.2.5");
        if (!real) real = (dlsym_t)dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.34");
    }
    return real;
}

// Helper to read the bounds of GhostWolf from /tmp/ghostwolf_bounds
static void get_ghostwolf_bounds(Display *display, int *gx, int *gy, int *gw, int *gh) {
    *gx = 0; *gy = 0; *gw = 0; *gh = 0;
    FILE *f = fopen("/tmp/ghostwolf_bounds", "r");
    if (f) {
        fscanf(f, "%d,%d,%d,%d", gx, gy, gw, gh);
        fclose(f);
    }
    if (*gw == 0 || *gh == 0) {
        Atom prop = XInternAtom(display, "_GHOSTWOLF_BOUNDS", True);
        if (prop != None) {
            Atom actual_type;
            int actual_format;
            unsigned long nitems, bytes_after;
            unsigned char *prop_data = NULL;
            if (XGetWindowProperty(display, DefaultRootWindow(display), prop, 0, 32, False, AnyPropertyType, &actual_type, &actual_format, &nitems, &bytes_after, &prop_data) == Success && prop_data) {
                sscanf((char *)prop_data, "%d,%d,%d,%d", gx, gy, gw, gh);
                XFree(prop_data);
            }
        }
    }
}

// Applies a solid black mask over the target region in an XImage
static void mask_ximage(Display *display, XImage *image, int x_offset, int y_offset) {
    if (!image || !image->data) return;

    int gx, gy, gw, gh;
    get_ghostwolf_bounds(display, &gx, &gy, &gw, &gh);
    
    if (gw == 0 || gh == 0) return; // GhostWolf not running or bounds invalid

    // Calculate intersection of the requested image region and GhostWolf bounds
    int img_x1 = x_offset;
    int img_y1 = y_offset;
    int img_x2 = x_offset + image->width;
    int img_y2 = y_offset + image->height;

    int gw_x2 = gx + gw;
    int gw_y2 = gy + gh;

    // Bounds of intersection relative to the image buffer
    int inter_x1 = (gx > img_x1) ? (gx - img_x1) : 0;
    int inter_y1 = (gy > img_y1) ? (gy - img_y1) : 0;
    int inter_x2 = (gw_x2 < img_x2) ? (gw_x2 - img_x1) : image->width;
    int inter_y2 = (gw_y2 < img_y2) ? (gw_y2 - img_y1) : image->height;

    if (inter_x1 >= inter_x2 || inter_y1 >= inter_y2) return; // No intersection

    // Attempt to load camouflage background
    static uint32_t *camo_bg = NULL;
    static size_t camo_bg_size = 0;
    static time_t camo_last_mtime = 0;
    
    struct stat st;
    if (stat("/tmp/ghostwolf_bg.raw", &st) == 0) {
        if (st.st_mtime != camo_last_mtime || camo_bg == NULL) {
            FILE *f = fopen("/tmp/ghostwolf_bg.raw", "rb");
            if (f) {
                if (camo_bg) free(camo_bg);
                camo_bg_size = st.st_size;
                camo_bg = (uint32_t *)malloc(camo_bg_size);
                fread(camo_bg, 1, camo_bg_size, f);
                fclose(f);
                camo_last_mtime = st.st_mtime;
            }
        }
    }

    int expected_size = gw * gh * 4;

    // Apply camouflage or fallback to black
    if (image->bits_per_pixel == 32) {
        for (int y = inter_y1; y < inter_y2; y++) {
            uint32_t *row = (uint32_t *)(image->data + (y * image->bytes_per_line));
            for (int x = inter_x1; x < inter_x2; x++) {
                if (camo_bg != NULL && camo_bg_size >= expected_size) {
                    int camo_x = (x_offset + x) - gx;
                    int camo_y = (y_offset + y) - gy;
                    if (camo_x >= 0 && camo_x < gw && camo_y >= 0 && camo_y < gh) {
                        row[x] = camo_bg[camo_y * gw + camo_x];
                        continue;
                    }
                }
                row[x] = 0xFF000000; // Black fallback
            }
        }
    }
}

XImage *XGetImage(Display *display, Drawable d, int x, int y, unsigned int width, unsigned int height, unsigned long plane_mask, int format) {
    if (!real_XGetImage) {
        real_XGetImage = get_real_dlsym()(RTLD_NEXT, "XGetImage");
    }
    
    XImage *image = real_XGetImage(display, d, x, y, width, height, plane_mask, format);
    
    // Check if the drawable is the root window (usually what screen sharers capture)
    Window root;
    int rx, ry;
    unsigned int rw, rh, bw, depth;
    if (XGetGeometry(display, d, &root, &rx, &ry, &rw, &rh, &bw, &depth)) {
        if (d == root) {
            mask_ximage(display, image, x, y);
        }
    }
    
    return image;
}

Bool XShmGetImage(Display *display, Drawable d, XImage *image, int x, int y, unsigned long plane_mask) {
    if (!real_XShmGetImage) {
        real_XShmGetImage = get_real_dlsym()(RTLD_NEXT, "XShmGetImage");
    }
    
    Bool result = real_XShmGetImage(display, d, image, x, y, plane_mask);
    
    if (result) {
        Window root;
        int rx, ry;
        unsigned int rw, rh, bw, depth;
        if (XGetGeometry(display, d, &root, &rx, &ry, &rw, &rh, &bw, &depth)) {
            if (d == root) {
                mask_ximage(display, image, x, y);
            }
        }
    }
    
    return result;
}

void *dlsym(void *handle, const char *symbol) {
    if (strcmp(symbol, "XGetImage") == 0) return (void *)XGetImage;
    if (strcmp(symbol, "XShmGetImage") == 0) return (void *)XShmGetImage;
    return get_real_dlsym()(handle, symbol);
}
