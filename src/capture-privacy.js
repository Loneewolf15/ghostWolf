'use strict';

/**
 * Capture privacy for GhostWolf's own window.
 *
 * Windows/macOS:
 *   Electron provides native content protection via setContentProtection(true).
 *   - Windows: maps to SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE),
 *     supported on Windows 10 build 19041+ and Windows 11.
 *   - macOS:   maps to NSWindow sharingType = NSWindowSharingNone.
 *     Note: Newer macOS ScreenCaptureKit behavior can sometimes bypass this.
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

  function isWindows10() {
    if (platform !== 'win32') return false;
    const os = require('os');
    const release = os.release();
    const parts = release.split('.');
    if (parts.length >= 3) {
      const build = parseInt(parts[2], 10);
      return build < 22000; // Windows 11 starts at 22000
    }
    return false;
  }

  function applyNativeWin32Affinity(hwndBuffer, enable) {
    const WDA_NONE             = 0x00000000;
    const WDA_EXCLUDEFROMCAPTURE = 0x00000011;
    const affinity = enable ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE;

    // --- Read the raw HWND value out of the Buffer. ---
    // win.getNativeWindowHandle() returns a Buffer whose *contents* are the
    // numeric HWND value encoded as little-endian bytes (8 bytes on x64 Windows).
    // We must NOT pass the Buffer directly as void* — that passes a pointer TO
    // the buffer memory, not the HWND value itself.  We use uintptr_t so koffi
    // treats the argument as an integer wide enough to hold a pointer.
    let hwndValue;
    try {
      hwndValue = process.arch === 'x64'
        ? hwndBuffer.readBigUInt64LE(0)   // 8-byte HWND on 64-bit Windows
        : BigInt(hwndBuffer.readUInt32LE(0)); // 4-byte HWND on 32-bit Windows
    } catch (readErr) {
      console.error('[GhostWolf] Failed to read HWND from buffer:', readErr.message);
      return false;
    }

    // --- koffi path (pure-JS, no native compilation needed) ---
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      // uintptr_t is an integer type sized to hold a pointer — correct for HWND
      const SetWindowDisplayAffinity = user32.func(
        '__stdcall', 'SetWindowDisplayAffinity', 'bool', ['uintptr_t', 'uint32']
      );
      const ok = SetWindowDisplayAffinity(hwndValue, affinity);
      console.log(`[GhostWolf] koffi SetWindowDisplayAffinity(${hwndValue}, 0x${affinity.toString(16)}) => ${ok}`);
      if (win && win.webContents) {
        win.webContents.send('status', {
          message: `[Win32] SetWindowDisplayAffinity(HWND=0x${hwndValue.toString(16)}, affinity=0x${affinity.toString(16)}) => ${ok}`
        });
      }
      return ok;
    } catch (koffiErr) {
      console.error('[GhostWolf] koffi SetWindowDisplayAffinity failed:', koffiErr.message);
      if (win && win.webContents) {
        win.webContents.send('status', { message: `[Win32] koffi error: ${koffiErr.message}` });
      }
      return false;
    }
  }

  /**
   * Enable native content protection on Windows/macOS.
   * On Linux, returns a renderer-only descriptor without modifying the system.
   *
   * @returns {{ supported: boolean, native: boolean, platform: string, enabled: boolean, mode: string, reason?: string, error?: string }}
   */
  function enable() {
    if (!isNative) {
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
    try {
      if (isWindows10()) {
        // On Windows 10, Electron's setContentProtection is broken due to a
        // Chromium DirectComposition regression. We bypass it entirely and call
        // SetWindowDisplayAffinity directly through koffi (no native compilation).
        // We also call setContentProtection(true) as belt-and-suspenders in case
        // the disable-direct-composition switch makes it work in this build.
        const hwnd = win.getNativeWindowHandle();
        const ffiOk = applyNativeWin32Affinity(hwnd, true);
        if (ffiOk) {
          console.log('[GhostWolf] Applied Windows 10 native FFI display affinity hack');
          if (win && win.webContents) win.webContents.send('status', { message: '[Win32] FFI affinity applied successfully via koffi' });
        } else {
          console.warn('[GhostWolf] koffi affinity call returned false — falling back to Electron setContentProtection');
          if (win && win.webContents) win.webContents.send('status', { message: '[Win32] koffi returned false, trying Electron setContentProtection as fallback' });
        }
        // Belt-and-suspenders: also call Electron's API (may now work with disable-direct-composition)
        try { win.setContentProtection(true); } catch (_) {}
      } else {
        win.setContentProtection(true);
      }
      const enabled =
        typeof win.isContentProtected === 'function'
          ? win.isContentProtected()
          : false;
      const result = {
        supported: true,
        native: enabled,
        platform,
        enabled,
        mode: enabled ? 'native' : 'unavailable',
        ...(enabled
          ? {}
          : { error: 'Electron did not report native content protection as enabled.' }),
      };
      if (win && win.webContents) {
        win.webContents.send('status', { message: `[Privacy] enable() result: ${JSON.stringify(result)}` });
      }
      return result;
    } catch (error) {
      return {
        supported: true,
        native: false,
        platform,
        enabled: false,
        mode: 'unavailable',
        error: error.message,
      };
    }
  }

  /**
   * Disable native content protection on Windows/macOS.
   * On Linux, this is a no-op that returns the renderer-only descriptor.
   *
   * @returns {{ supported: boolean, native: boolean, platform: string, enabled: boolean, mode: string, error?: string }}
   */
  function disable() {
    if (!isNative) {
      return {
        supported: false,
        native: false,
        platform,
        enabled: false,
        mode: 'renderer-only',
      };
    }
    try {
      if (isWindows10()) {
        const hwnd = win.getNativeWindowHandle();
        applyNativeWin32Affinity(hwnd, false);
      } else {
        win.setContentProtection(false);
      }
      const enabled =
        typeof win.isContentProtected === 'function'
          ? win.isContentProtected()
          : false;
      return {
        supported: true,
        native: !enabled,
        platform,
        enabled,
        mode: 'native',
      };
    } catch (error) {
      return {
        supported: true,
        native: false,
        platform,
        enabled: false,
        mode: 'unavailable',
        error: error.message,
      };
    }
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
