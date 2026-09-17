'use strict';

/**
 * ghost-bounds.js — keeps /tmp/ghostwolf_bounds in sync with the live window position.
 *
 * Why this exists:
 *   libghost.so hooks XShmGetImage (the capture path Chrome, scrot, ffmpeg x11grab,
 *   and xwd use) and blacks-out pixels inside the region described by this file.
 *   The hook re-reads the file on every capture call, so updating it is enough to
 *   track the window as it is dragged, resized, or moves between monitors.
 *
 * Format: a single line "x,y,width,height\n" (integers, screen coordinates).
 *
 * Fallback: the hook also reads the _GHOSTWOLF_BOUNDS root X11 property; we set
 * both so the hook works even if /tmp is on a different mount inside a container.
 *
 * This module is Linux-only. The caller is responsible for the platform guard:
 *   if (isLinux) { const { publishGhostBounds } = require('./src/ghost-bounds'); ... }
 */

const fs   = require('node:fs');
const path = require('node:path');

const BOUNDS_FILE = '/tmp/ghostwolf_bounds';

/**
 * Start publishing GhostWolf's window position to the bounds file.
 *
 * Attaches 'move' and 'resize' listeners to the BrowserWindow and writes the
 * current bounds immediately, then on every subsequent position/size change.
 * Cleans up (removes the file) when the app is about to quit.
 *
 * @param {import('electron').BrowserWindow} win  The main GhostWolf window.
 * @param {object} [opts]
 * @param {string} [opts.boundsFile]  Override the path for unit testing.
 * @returns {{ stop: Function }}  Call stop() to detach listeners and clean up.
 */
function publishGhostBounds(win, opts = {}) {
  const boundsFile = opts.boundsFile || BOUNDS_FILE;

  function writeBounds() {
    try {
      if (!win || win.isDestroyed()) return;
      const { x, y, width, height } = win.getBounds();
      fs.writeFileSync(boundsFile, `${x},${y},${width},${height}\n`, 'utf8');
    } catch (err) {
      // Non-fatal: if /tmp is read-only or the window is destroyed mid-write,
      // just log and carry on. The hook will use stale-but-close-enough bounds.
      console.warn('[GhostWolf] ghost-bounds: failed to write bounds:', err.message);
    }
  }

  // Write immediately so the hook has valid bounds before the first capture.
  writeBounds();

  // Track every move/resize event.
  win.on('move',   writeBounds);
  win.on('resize', writeBounds);

  function cleanup() {
    try { fs.unlinkSync(boundsFile); } catch (_) {}
  }

  // Remove the file when the app exits so a stale file never confuses the hook
  // if GhostWolf is not running.
  const { app } = require('electron');
  app.once('before-quit', cleanup);

  function stop() {
    win.off('move',   writeBounds);
    win.off('resize', writeBounds);
    app.off('before-quit', cleanup);
    cleanup();
  }

  return { stop };
}

module.exports = { publishGhostBounds, BOUNDS_FILE };
