'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyPlatformWindowType } = require('../src/window-options');

// ---------------------------------------------------------------------------
// Helper: build a fresh base options object (mirrors the real winOptions in
// main.js so tests stay coupled to what the app actually constructs).
// ---------------------------------------------------------------------------
function baseOptions() {
  return {
    width: 340,
    height: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: '/fake/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
test('win32: sets type to toolbar so Electron uses WS_EX_TOOLWINDOW', () => {
  const opts = baseOptions();
  const result = applyPlatformWindowType('win32', opts);

  assert.equal(result.type, 'toolbar',
    'Windows must have type:toolbar to exclude from taskbar and screen-share pickers');
});

test('win32: returns the same options object (mutates in place)', () => {
  const opts = baseOptions();
  const result = applyPlatformWindowType('win32', opts);
  assert.strictEqual(result, opts, 'applyPlatformWindowType must return the same object reference');
});

test('win32: does not touch any other option', () => {
  const opts = baseOptions();
  applyPlatformWindowType('win32', opts);

  assert.equal(opts.transparent, true);
  assert.equal(opts.skipTaskbar, true);
  assert.equal(opts.alwaysOnTop, true);
  assert.equal(opts.frame, false);
  assert.equal(opts.backgroundColor, '#00000000');
});

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------
test('linux: sets type to toolbar so Electron writes _NET_WM_WINDOW_TYPE_UTILITY', () => {
  const opts = baseOptions();
  const result = applyPlatformWindowType('linux', opts);

  assert.equal(result.type, 'toolbar',
    'Linux must have type:toolbar to write _NET_WM_WINDOW_TYPE_UTILITY and be ' +
    'excluded from Chrome/Zoom/Teams X11 window pickers');
});

test('linux: returns the same options object (mutates in place)', () => {
  const opts = baseOptions();
  const result = applyPlatformWindowType('linux', opts);
  assert.strictEqual(result, opts);
});

test('linux: does not touch any other option', () => {
  const opts = baseOptions();
  applyPlatformWindowType('linux', opts);

  assert.equal(opts.transparent, true);
  assert.equal(opts.skipTaskbar, true);
  assert.equal(opts.alwaysOnTop, true);
  assert.equal(opts.frame, false);
  assert.equal(opts.backgroundColor, '#00000000');
});

// ---------------------------------------------------------------------------
// macOS — must NOT set type, or keyboard focus breaks
// ---------------------------------------------------------------------------
test('darwin: does NOT set type so keyboard focus is preserved', () => {
  const opts = baseOptions();
  applyPlatformWindowType('darwin', opts);

  assert.equal(opts.type, undefined,
    'macOS must NOT receive type:toolbar — it would create a Panel that ' +
    'cannot receive keyboard focus. setContentProtection handles exclusion.');
});

test('darwin: leaves all other options untouched', () => {
  const opts = baseOptions();
  applyPlatformWindowType('darwin', opts);

  assert.equal(opts.transparent, true);
  assert.equal(opts.skipTaskbar, true);
  assert.equal(opts.alwaysOnTop, true);
  assert.equal(opts.frame, false);
  assert.equal(opts.backgroundColor, '#00000000');
});

// ---------------------------------------------------------------------------
// Unknown / future platforms
// ---------------------------------------------------------------------------
test('unknown platform: does not set type (safe default)', () => {
  const opts = baseOptions();
  applyPlatformWindowType('freebsd', opts);
  assert.equal(opts.type, undefined,
    'Unknown platforms must not receive a type override');
});

test('unknown platform: does not modify any other option', () => {
  const opts = baseOptions();
  applyPlatformWindowType('freebsd', opts);

  assert.equal(opts.transparent, true);
  assert.equal(opts.skipTaskbar, true);
});

// ---------------------------------------------------------------------------
// Cross-platform symmetry
// ---------------------------------------------------------------------------
test('win32 and linux produce identical type values', () => {
  const win32 = applyPlatformWindowType('win32', baseOptions());
  const linux = applyPlatformWindowType('linux', baseOptions());
  assert.equal(win32.type, linux.type,
    'Both platforms must request the same Electron window type');
});

test('darwin and unknown platforms produce no type override', () => {
  const darwin = applyPlatformWindowType('darwin', baseOptions());
  const freebsd = applyPlatformWindowType('freebsd', baseOptions());
  assert.equal(darwin.type, undefined);
  assert.equal(freebsd.type, undefined);
});
