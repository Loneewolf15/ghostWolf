'use strict';

/**
 * Apply platform-specific BrowserWindow type overrides to a window-options object.
 *
 * Why this is a separate module:
 *   The `type` property controls which X11 _NET_WM_WINDOW_TYPE atom Electron writes,
 *   which in turn controls whether screen-sharing pickers (Chrome, Zoom, Teams, OBS)
 *   include the window as a capturable source.
 *
 * Platform behaviour:
 *
 *   Windows ('win32'):
 *     Sets type:'toolbar'.  Electron maps this to WS_EX_TOOLWINDOW + calls
 *     SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) via setContentProtection().
 *     The window disappears from the Alt+Tab list and the taskbar.
 *
 *   Linux ('linux'):
 *     Sets type:'toolbar'.  Electron's GTK backend maps this to
 *     _NET_WM_WINDOW_TYPE_UTILITY on X11.  Chromium's X11 window-picker
 *     (WindowCapturerX11::GetWindowList) explicitly excludes windows whose
 *     _NET_WM_WINDOW_TYPE is not _NET_WM_WINDOW_TYPE_NORMAL, so GhostWolf
 *     will not appear as a capturable "window" source in Chrome, Zoom, Teams,
 *     or any other tool that follows EWMH.
 *
 *     Note: "Share entire screen" grabs the root drawable directly and is not
 *     affected by _NET_WM_WINDOW_TYPE — that path is handled separately by
 *     the renderer-level privacy mode (CSS class) and, historically, by
 *     libghost.c (now removed).
 *
 *   macOS ('darwin'):
 *     No type override.  Electron's setContentProtection(true) sets
 *     NSWindowSharingNone, which is the correct exclusion mechanism on macOS.
 *     Adding type:'toolbar' on macOS creates a Panel-style window that cannot
 *     receive keyboard focus — we must not set it here.
 *
 * @param {string}  platform  The target platform string (process.platform).
 * @param {object}  options   The BrowserWindow options object to mutate.
 * @returns {object} The same options object, with `type` set if applicable.
 */
function applyPlatformWindowType(platform, options) {
  if (platform === 'win32' || platform === 'linux') {
    options.type = 'toolbar';
  }
  // macOS: no type override — keyboard focus must be preserved.
  return options;
}

module.exports = { applyPlatformWindowType };
