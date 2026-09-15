const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { autoCloak, detectInstallType, isCloaked, checkPathOrder, writeBinaryWrapper, TARGET_APPS } = require('../src/linux-cloak');

test('detectInstallType returns deb for a standard bin path', (t) => {
  const res = detectInstallType({ binary: 'ls', name: 'ls', flatpakId: 'invalid' });
  assert.strictEqual(res, 'deb');
});

test('checkPathOrder verifies ~/.local/bin precedence', (t) => {
  const originalPath = process.env.PATH;
  
  // Case 1: missing entirely
  process.env.PATH = '/usr/bin:/bin';
  assert.strictEqual(checkPathOrder().ok, false);

  // Case 2: exists but after /usr/bin
  process.env.PATH = '/usr/bin:/bin:' + path.join(os.homedir(), '.local', 'bin');
  assert.strictEqual(checkPathOrder().ok, false);

  // Case 3: exists before /usr/bin
  process.env.PATH = path.join(os.homedir(), '.local', 'bin') + ':/usr/bin:/bin';
  assert.strictEqual(checkPathOrder().ok, true);

  // Case 4: uses $HOME env var substitution (some distros)
  process.env.PATH = '$HOME/.local/bin:/usr/bin:/bin';
  assert.strictEqual(checkPathOrder().ok, true);

  process.env.PATH = originalPath;
});

test('writeBinaryWrapper generates correct bash script', (t) => {
  const fakeApp = { binary: 'ls', extraFlags: ['--foo=bar', '--baz'] };
  const libPath = '/fake/path/libghost.so';
  
  const res = writeBinaryWrapper(fakeApp, libPath);
  assert.strictEqual(res.ok, true);
  
  const content = fs.readFileSync(res.wrapperPath, 'utf8');
  assert.ok(content.includes('#!/bin/bash'));
  assert.ok(content.includes('LD_PRELOAD="/fake/path/libghost.so"'));
  assert.ok(content.includes('--foo=bar \\'));
  assert.ok(content.includes('--baz \\'));
  
  // Clean up
  fs.unlinkSync(res.wrapperPath);
});

test('isCloaked returns true only for matching wrapper', (t) => {
  const fakeApp = { binary: 'ghost-test-app', name: 'ghost-test' };
  const libPath = '/fake/path/libghost.so';
  const wrapperDir = path.join(os.homedir(), '.local', 'bin');
  const wrapperPath = path.join(wrapperDir, 'ghost-test-app');
  
  fs.mkdirSync(wrapperDir, { recursive: true });
  
  // 1. Doesn't exist
  if (fs.existsSync(wrapperPath)) fs.unlinkSync(wrapperPath);
  assert.strictEqual(isCloaked(fakeApp, libPath), false);
  
  // 2. Exists but wrong content (not ours)
  fs.writeFileSync(wrapperPath, '#!/bin/bash\necho test\n');
  assert.strictEqual(isCloaked(fakeApp, libPath), false);
  
  // 3. Exists, ours, but old lib path
  fs.writeFileSync(wrapperPath, '#!/bin/bash\n# ghostwolf-cloak\n# libghost=/old/path.so\n');
  assert.strictEqual(isCloaked(fakeApp, libPath), false);
  
  // 4. Exists, ours, correct lib path
  fs.writeFileSync(wrapperPath, `#!/bin/bash\n# ghostwolf-cloak\n# libghost=${libPath}\n`);
  assert.strictEqual(isCloaked(fakeApp, libPath), true);
  
  fs.unlinkSync(wrapperPath);
});

test('autoCloak is idempotent', async (t) => {
  // Use a fake lib path and override the first app to be 'ls' so it finds it.
  const libPath = path.join(os.homedir(), 'fake-libghost.so');
  fs.writeFileSync(libPath, 'dummy'); // Must exist for autoCloak to proceed
  
  const originalApps = [...TARGET_APPS];
  TARGET_APPS.length = 0;
  TARGET_APPS.push({
    name: 'test-app',
    binary: 'ls',
    desktopFiles: [],
    extraFlags: [],
    snapId: 'test-app',
    flatpakId: 'test.App'
  });

  // First run: should cloak
  const res1 = await autoCloak(libPath);
  assert.ok(res1.cloaked.includes('test-app'));
  assert.ok(!res1.skipped.includes('test-app'));

  // Second run: should skip
  const res2 = await autoCloak(libPath);
  assert.ok(!res2.cloaked.includes('test-app'));
  assert.ok(res2.skipped.includes('test-app'));

  // Clean up
  const wrapperPath = path.join(os.homedir(), '.local', 'bin', 'ls');
  if (fs.existsSync(wrapperPath)) fs.unlinkSync(wrapperPath);
  fs.unlinkSync(libPath);
  
  TARGET_APPS.push(...originalApps);
});
