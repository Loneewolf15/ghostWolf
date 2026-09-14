#!/bin/bash
# Ghost-Cloak: Dynamic LD_PRELOAD injector for Linux Desktop files

if [ -z "$1" ]; then
    echo "Usage: $0 <app_name>"
    echo "Example: $0 zoom"
    echo "This script finds the .desktop file for the app, copies it to ~/.local/share/applications,"
    echo "and injects LD_PRELOAD=libghost.so so it becomes invisible to GhostWolf automatically."
    exit 1
fi

APP_NAME="$1"
LOCAL_DIR="$HOME/.local/share/applications"
GHOST_LIB="$(realpath "$(dirname "$0")/../libghost.so")"

if [ ! -f "$GHOST_LIB" ]; then
    echo "Error: Cannot find libghost.so at $GHOST_LIB"
    echo "Please build the project first."
    exit 1
fi

# Find the desktop file
DESKTOP_FILE=$(find /usr/share/applications /var/lib/snapd/desktop/applications /var/lib/flatpak/exports/share/applications "$HOME/.local/share/flatpak/exports/share/applications" -type f -iname "*${APP_NAME}*.desktop" 2>/dev/null | head -n 1)

if [ -z "$DESKTOP_FILE" ]; then
    echo "Error: Could not find a .desktop file for $APP_NAME"
    exit 1
fi

echo "Found: $DESKTOP_FILE"
mkdir -p "$LOCAL_DIR"

BASENAME=$(basename "$DESKTOP_FILE")
TARGET_FILE="$LOCAL_DIR/$BASENAME"

cp "$DESKTOP_FILE" "$TARGET_FILE"

# Patch the Exec line
# Replaces: Exec=/usr/bin/zoom %U
# With: Exec=env LD_PRELOAD=/path/to/libghost.so /usr/bin/zoom %U
sed -i -e "s|^Exec=\\(.*\\)|Exec=env LD_PRELOAD=${GHOST_LIB} \\1|g" "$TARGET_FILE"

# Also remove DBus activation to force it to use the Exec line
sed -i '/^DBusActivatable=/d' "$TARGET_FILE"

chmod +x "$TARGET_FILE"

echo "Successfully cloaked $APP_NAME!"
echo "The patched shortcut is located at: $TARGET_FILE"
echo "You can now launch $APP_NAME from your application menu and it will be invisible to GhostWolf."
