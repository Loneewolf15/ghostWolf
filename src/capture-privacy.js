'use strict';

/**
 * Capture privacy for GhostWolf's own window.
 *
 * Windows/macOS:
 *   Electron provides native content protection via setContentProtection(true).
 *   - Windows: maps to SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE),
 *     supported on Windows 10 build 19041+ and Windows 11.
 *   - macOS:   maps to NSWindow sharingType = NSWindowSharingNone.
 *   Electron itself gates these internally; no manual version check is needed.
 *
 * Linux:
 *   Electron does not currently expose an equivalent native content-protection
 *   API for Linux (neither X11 nor Wayland). We therefore do NOT modify or
 *   inject into third-party applications (Chrome, Zoom, Teams, etc.).
 *
 *   A renderer-level privacy mode (toggling CSS classes that hide sensitive
 *   content) is available as a future enhancement.  That changes what GhostWolf
 *   itself renders — it does not claim to make a native Linux window invisible
 *   to OBS, Meet, or other compositor capture systems.
 *
 * IMPORTANT:
 *   This module only controls GhostWolf's own BrowserWindow.  It never reads
 *   or writes files outside GhostWolf, modifies PATH, sets LD_PRELOAD, or
 *   restarts third-party processes.
 *
 * Reference:
 *   https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable
 */

/**
 * @param {import('electron').BrowserWindow} win
 * @returns {{ enable: Function, disable: Function, status: Function }}
 */
function createCapturePrivacy(win) {
  if (!win) {
    throw new Error('createCapturePrivacy requires a BrowserWindow instance');
  }

  const platform = process.platform;
  const isNative = platform === 'win32' || platform === 'darwin';

  /**
   * Enable native content protection on Windows/macOS.
   * On Linux, returns a renderer-only descriptor without modifying the system.
   *
   * @returns {{ supported: boolean, native: boolean, platform: string, enabled: boolean, mode: string, reason?: string, error?: string }}
   */
  function enable() {
    if (isNative) {
      try {
        win.setContentProtection(true);
        return {
          supported: true,
          native: true,
          platform,
          enabled: true,
          mode: 'native',
        };
      } catch (error) {
        return {
          supported: false,
          native: false,
          platform,
          enabled: false,
          mode: 'unavailable',
          error: error.message,
        };
      }
    }

    // Linux: do not attempt LD_PRELOAD, window-manager hacks,
    // browser modification, or third-party process injection.
    return {
      supported: false,
      native: false,
      platform,
      enabled: false,
      mode: 'renderer-only',
      reason:
        'Electron does not currently expose native content protection for Linux. ' +
        'GhostWolf uses renderer-level privacy mode only.',
    };
  }

  /**
   * Disable native content protection on Windows/macOS.
   * On Linux, this is a no-op that returns the renderer-only descriptor.
   *
   * @returns {{ supported: boolean, native: boolean, platform: string, enabled: boolean, mode: string, error?: string }}
   */
  function disable() {
    if (isNative) {
      try {
        win.setContentProtection(false);
        return {
          supported: true,
          native: true,
          platform,
          enabled: false,
          mode: 'native',
        };
      } catch (error) {
        return {
          supported: false,
          native: false,
          platform,
          enabled: false,
          mode: 'unavailable',
          error: error.message,
        };
      }
    }

    return {
      supported: false,
      native: false,
      platform,
      enabled: false,
      mode: 'renderer-only',
    };
  }

  /**
   * Return the current content-protection status.
   * On Linux, always reports supported: false, enabled: false.
   *
   * @returns {{ supported: boolean, native: boolean, enabled: boolean, platform: string, mode: string, reason?: string }}
   */
  function status() {
    if (isNative) {
      let enabled = false;
      // isContentProtected() was added in Electron 32; guard gracefully.
      if (typeof win.isContentProtected === 'function') {
        try { enabled = win.isContentProtected(); } catch (_) {}
      }
      return {
        supported: true,
        native: true,
        enabled,
        platform,
        mode: 'native',
      };
    }

    return {
      supported: false,
      native: false,
      enabled: false,
      platform,
      mode: 'renderer-only',
      reason: 'Linux capture exclusion is not currently exposed by Electron.',
    };
  }

  return { enable, disable, status };
}

module.exports = { createCapturePrivacy };
