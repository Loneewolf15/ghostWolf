'use strict';

const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const test   = require('node:test');
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------------------
// Stub for Electron's BrowserWindow - mirrors only what ghost-bounds.js uses.
// ---------------------------------------------------------------------------
class FakeWin extends EventEmitter {
  constructor(bounds = { x: 100, y: 200, width: 340, height: 600 }) {
    super();
    this._bounds  = { ...bounds };
    this._destroyed = false;
  }
  getBounds()     { return { ...this._bounds }; }
  isDestroyed()   { return this._destroyed; }
  destroy()       { this._destroyed = true; }
  moveTo(x, y)    { this._bounds.x = x; this._bounds.y = y; this.emit('move'); }
  resizeTo(w, h)  { this._bounds.width = w; this._bounds.height = h; this.emit('resize'); }
}

// Stub for Electron's app - ghost-bounds.js calls app.once('before-quit').
class FakeApp extends EventEmitter {}

// ---------------------------------------------------------------------------
// Module factory: load ghost-bounds.js with electron stubbed out.
// Using require() with the module cache cleared so each test gets a clean copy.
// ---------------------------------------------------------------------------
function loadModule() {
  // Purge any cached version so each test starts fresh.
  delete require.cache[require.resolve('../src/ghost-bounds')];

  // Stub 'electron' before requiring the module.
  const fakeApp = new FakeApp();
  require.cache[require.resolve('electron')] = {
    id: 'electron', filename: 'electron', loaded: true,
    exports: { app: fakeApp },
    children: [], paths: [],
    require: require,
  };

  const mod = require('../src/ghost-bounds');

  return { mod, fakeApp };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tmpFile(dir) {
  return path.join(dir, 'ghostwolf_bounds_test.txt');
}

function readBounds(file) {
  return fs.readFileSync(file, 'utf8').trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('writes initial bounds to file immediately on start', (ctx) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-test-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { mod } = loadModule();
  const win = new FakeWin({ x: 50, y: 80, width: 340, height: 600 });
  const file = tmpFile(dir);

  mod.publishGhostBounds(win, { boundsFile: file });

  assert.ok(fs.existsSync(file), 'bounds file must exist after publishGhostBounds()');
  assert.equal(readBounds(file), '50,80,340,600');
});

test('updates file when window moves', (ctx) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-move-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { mod } = loadModule();
  const win = new FakeWin({ x: 100, y: 200, width: 340, height: 600 });
  const file = tmpFile(dir);

  mod.publishGhostBounds(win, { boundsFile: file });
  assert.equal(readBounds(file), '100,200,340,600', 'initial position');

  win.moveTo(400, 150);
  assert.equal(readBounds(file), '400,150,340,600', 'after move');

  win.moveTo(10, 30);
  assert.equal(readBounds(file), '10,30,340,600', 'after second move');
});

test('updates file when window is resized', (ctx) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-resize-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { mod } = loadModule();
  const win = new FakeWin({ x: 100, y: 200, width: 340, height: 600 });
  const file = tmpFile(dir);

  mod.publishGhostBounds(win, { boundsFile: file });
  win.resizeTo(500, 800);
  assert.equal(readBounds(file), '100,200,500,800');
});

test('tracks a full drag sequence - each intermediate position is written', (ctx) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-drag-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { mod } = loadModule();
  const win = new FakeWin({ x: 0, y: 0, width: 340, height: 600 });
  const file = tmpFile(dir);

  mod.publishGhostBounds(win, { boundsFile: file });

  // Simulate dragging across 10 positions (like a real mouse drag at ~60fps)
  const dragPath = [
    [100, 50], [150, 75], [200, 100], [250, 125], [300, 150],
    [350, 175], [400, 200], [450, 225], [500, 250], [550, 275],
  ];

  for (const [x, y] of dragPath) {
    win.moveTo(x, y);
    const written = readBounds(file);
    assert.equal(written, `${x},${y},340,600`,
      `bounds file must reflect position (${x},${y}) immediately after 'move' event`);
  }
});

test('stop() detaches listeners - subsequent moves do NOT update the file', (ctx) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-stop-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { mod } = loadModule();
  const win = new FakeWin({ x: 100, y: 200, width: 340, height: 600 });
  const file = tmpFile(dir);

  const { stop } = mod.publishGhostBounds(win, { boundsFile: file });
  win.moveTo(300, 300);

  // Read content BEFORE stop() (which deletes the file).
  const contentBeforeStop = readBounds(file);
  assert.equal(contentBeforeStop, '300,300,340,600', 'sanity: move works before stop');

  stop(); // deletes the file

  // After stop(), the file is gone and moves must not recreate it.
  win.moveTo(999, 999);
  assert.ok(!fs.existsSync(file),
    'file must NOT be recreated after stop() - listeners must be detached');
});

test('stop() deletes the bounds file', (ctx) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cleanup-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { mod } = loadModule();
  const win  = new FakeWin();
  const file = tmpFile(dir);

  const { stop } = mod.publishGhostBounds(win, { boundsFile: file });
  assert.ok(fs.existsSync(file), 'file exists before stop()');

  stop();
  assert.ok(!fs.existsSync(file), 'file must be deleted after stop()');
});

test('before-quit event triggers cleanup and deletes the bounds file', (ctx) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-quit-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { mod, fakeApp } = loadModule();
  const win  = new FakeWin();
  const file = tmpFile(dir);

  mod.publishGhostBounds(win, { boundsFile: file });
  assert.ok(fs.existsSync(file), 'file exists before quit');

  fakeApp.emit('before-quit');
  assert.ok(!fs.existsSync(file), 'file must be deleted on before-quit');
});

test('does not throw when window is destroyed before move fires', (ctx) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-destroy-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { mod } = loadModule();
  const win  = new FakeWin();
  const file = tmpFile(dir);

  mod.publishGhostBounds(win, { boundsFile: file });
  win.destroy();

  // Emitting 'move' on a destroyed window must not throw.
  assert.doesNotThrow(() => win.emit('move'),
    'writeBounds must guard against destroyed window');
});

test('bounds file format is exactly "x,y,width,height\\n"', (ctx) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-format-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { mod } = loadModule();
  const win  = new FakeWin({ x: 661, y: 257, width: 700, height: 600 });
  const file = tmpFile(dir);

  mod.publishGhostBounds(win, { boundsFile: file });
  const raw = fs.readFileSync(file, 'utf8');

  // The hook reads with sscanf("%d,%d,%d,%d") - must be comma-separated integers.
  assert.match(raw, /^\d+,\d+,\d+,\d+\n$/,
    'format must be "x,y,w,h\\n" - exactly what libghost.c\'s sscanf expects');
  assert.equal(raw.trim(), '661,257,700,600');
});
