// linux-cloak.js — Auto-inject libghost.so into screen-sharing apps on Linux.
//
// Strategy:
//   1. Binary wrapper  (~/.local/bin/<app>) — intercepts ALL launch paths
//      (terminal, other scripts, app menu) by sitting earlier in PATH than
//      /usr/bin.  The wrapper sets LD_PRELOAD and --disable-features=
//      WebRtcPipeWireCapturer so Chrome is forced onto the X11 XGetImage
//      capture path where libghost.so hooks live.
//
//   2. .desktop patch (~/.local/share/applications/<app>.desktop) — belt +
//      suspenders for GNOME/KDE application-menu launches, and for apps that
//      do NOT have a simple binary name in PATH (e.g. Zoom, Teams).
//
//   3. Snap/Flatpak detection — sandboxes block LD_PRELOAD entirely.  We
//      detect these and skip injection, returning a 'snap'/'flatpak' status
//      so the UI can show a targeted help message instead of a silent failure.
//
// Called from main.js on EVERY Linux start (not just first run) because the
// AppImage mount path changes on every launch — the wrapper must be rewritten
// with the current libghost.so path each time.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync, spawn } = require('child_process');

// Apps we attempt to auto-cloak. Order matters: Chrome first (most common).
const TARGET_APPS = [
  {
    name: 'google-chrome',
    binary: 'google-chrome',
    desktopFiles: ['google-chrome.desktop', 'google-chrome-stable.desktop'],
    extraFlags: ['--disable-features=WebRtcPipeWireCapturer'],
    snapId: 'google-chrome',
    flatpakId: 'com.google.Chrome',
  },
  {
    name: 'chromium',
    binary: 'chromium-browser',
    desktopFiles: ['chromium-browser.desktop', 'chromium.desktop'],
    extraFlags: ['--disable-features=WebRtcPipeWireCapturer'],
    snapId: 'chromium',
    flatpakId: 'org.chromium.Chromium',
  },
  {
    name: 'zoom',
    binary: 'zoom',
    desktopFiles: ['zoom.desktop', 'Zoom.desktop'],
    extraFlags: [],
    snapId: 'zoom-client',
    flatpakId: 'us.zoom.Zoom',
  },
  {
    name: 'teams',
    binary: 'teams',
    desktopFiles: ['teams.desktop', 'teams-for-linux.desktop', 'com.microsoft.Teams.desktop'],
    extraFlags: [],
    snapId: 'teams',
    flatpakId: 'com.microsoft.Teams',
  },
];

// Canonical system binary search paths we look in (NOT ~/.local/bin which is ours).
const SYSTEM_BIN_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/google/chrome', '/usr/share/zoom/bin'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function localBinDir() {
  return path.join(os.homedir(), '.local', 'bin');
}

function localAppsDir() {
  return path.join(os.homedir(), '.local', 'share', 'applications');
}

/**
 * Find the real binary for an app, ignoring our own wrapper in ~/.local/bin.
 * Returns the absolute path, or null if not found.
 */
function findRealBinary(appDef) {
  // 1. If the binary name resolves to a path outside ~/.local/bin, use it.
  try {
    const resolved = execFileSync('which', [appDef.binary], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (resolved && !resolved.startsWith(localBinDir())) {
      return resolved;
    }
  } catch (_) {}

  // 2. Scan SYSTEM_BIN_DIRS explicitly.
  for (const dir of SYSTEM_BIN_DIRS) {
    const full = path.join(dir, appDef.binary);
    if (fs.existsSync(full)) return full;
  }

  // 3. Also try google-chrome-stable (deb installs use this name).
  if (appDef.binary === 'google-chrome') {
    const stable = '/usr/bin/google-chrome-stable';
    if (fs.existsSync(stable)) return stable;
  }

  return null;
}

/**
 * Detect whether an app is installed via Snap, Flatpak, or native deb/rpm.
 * Returns: 'snap' | 'flatpak' | 'deb' | 'not-installed'
 */
function detectInstallType(appDef) {
  // Snap: binary lives at /snap/bin/<name>
  const snapBin = path.join('/snap/bin', appDef.binary);
  const snapBinAlt = path.join('/snap/bin', appDef.name);
  if (fs.existsSync(snapBin) || fs.existsSync(snapBinAlt)) return 'snap';

  // Flatpak: check flatpak list output (suppress errors — flatpak may not be installed)
  try {
    const flatpakOut = execFileSync('flatpak', ['list', '--app', '--columns=application'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 });
    if (flatpakOut.includes(appDef.flatpakId)) return 'flatpak';
  } catch (_) {}

  // Check if a real binary exists at all
  if (findRealBinary(appDef)) return 'deb';

  return 'not-installed';
}

/**
 * Check whether our wrapper is already written with the correct libPath.
 * We embed a magic comment with the lib path so we can detect stale wrappers.
 */
function isCloaked(appDef, libPath) {
  const wrapperPath = path.join(localBinDir(), appDef.binary);
  if (!fs.existsSync(wrapperPath)) return false;
  try {
    const content = fs.readFileSync(wrapperPath, 'utf8');
    // Check both that it's our wrapper AND that it points to the current libPath.
    return content.includes('# ghostwolf-cloak') && content.includes(libPath);
  } catch (_) {
    return false;
  }
}

/**
 * Check whether ~/.local/bin appears before /usr/bin in PATH.
 * Returns { ok: boolean, localBin: string, pathValue: string }
 */
function checkPathOrder() {
  const pathValue = process.env.PATH || '';
  const entries = pathValue.split(':').map(p => p.trim());
  const localBin = localBinDir();

  const localIdx  = entries.findIndex(e => e === localBin || e === '$HOME/.local/bin' || e === path.join('$HOME', '.local', 'bin'));
  const usrBinIdx = entries.findIndex(e => e === '/usr/bin');

  // ~/.local/bin is "before" /usr/bin when it has a lower index, or when
  // /usr/bin is absent (unusual but means we're fine).
  const ok = localIdx !== -1 && (usrBinIdx === -1 || localIdx < usrBinIdx);

  return { ok, localBin, pathValue };
}

// ─── Writers ──────────────────────────────────────────────────────────────────

/**
 * Write the binary wrapper for one app.
 * The wrapper prepends LD_PRELOAD and --disable-features and exec's the real binary.
 */
function writeBinaryWrapper(appDef, libPath) {
  const realBin = findRealBinary(appDef);
  if (!realBin) return { ok: false, reason: 'binary-not-found' };

  const extraFlags = appDef.extraFlags.length > 0
    ? ' \\\n  ' + appDef.extraFlags.join(' \\\n  ')
    : '';

  const wrapperContent = [
    '#!/bin/bash',
    '# ghostwolf-cloak — managed by GhostWolf, do not edit by hand.',
    `# libghost=${libPath}`,
    `exec env LD_PRELOAD="${libPath}" \\`,
    `  "${realBin}"${extraFlags} \\`,
    '  "$@"',
    '',
  ].join('\n');

  const dir = localBinDir();
  fs.mkdirSync(dir, { recursive: true });

  const wrapperPath = path.join(dir, appDef.binary);
  fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });

  // For google-chrome, also write google-chrome-stable wrapper so both names work.
  if (appDef.binary === 'google-chrome') {
    const stablePath = path.join(dir, 'google-chrome-stable');
    fs.writeFileSync(stablePath, wrapperContent, { mode: 0o755 });
  }

  return { ok: true, wrapperPath, realBin };
}

/**
 * Find and patch the .desktop file for an app into ~/.local/share/applications/.
 * This covers GNOME/KDE application-menu launches.
 */
function writeDesktopPatch(appDef, libPath) {
  const systemDesktopDirs = [
    '/usr/share/applications',
    '/var/lib/snapd/desktop/applications',
    '/var/lib/flatpak/exports/share/applications',
    path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
  ];

  let sourceFile = null;
  for (const desktopName of appDef.desktopFiles) {
    for (const dir of systemDesktopDirs) {
      const candidate = path.join(dir, desktopName);
      if (fs.existsSync(candidate)) { sourceFile = candidate; break; }
    }
    if (sourceFile) break;
  }

  if (!sourceFile) return { ok: false, reason: 'desktop-file-not-found' };

  let content = fs.readFileSync(sourceFile, 'utf8');

  // Remove DBus activation so the Exec= line is always used.
  content = content.replace(/^DBusActivatable=.*$/m, '');

  // Inject LD_PRELOAD and extra flags into every Exec= line.
  // Before: Exec=/usr/bin/google-chrome-stable %U
  // After:  Exec=env LD_PRELOAD=/path/to/libghost.so /usr/bin/google-chrome-stable --disable-features=... %U
  const flags = appDef.extraFlags.join(' ');
  content = content.replace(
    /^(Exec=)(.+)$/mg,
    (_, prefix, rest) => {
      // Don't double-inject if we already did.
      if (rest.includes('ghostwolf')) return prefix + rest;
      return `${prefix}env LD_PRELOAD="${libPath}" ${rest}${flags ? ' ' + flags : ''}`;
    }
  );

  const targetDir = localAppsDir();
  fs.mkdirSync(targetDir, { recursive: true });

  const targetFile = path.join(targetDir, path.basename(sourceFile));
  fs.writeFileSync(targetFile, content, { mode: 0o644 });

  return { ok: true, targetFile };
}

// ─── Re-launch helper ─────────────────────────────────────────────────────────

/**
 * Find and soft-restart a running Chrome instance so it picks up LD_PRELOAD
 * immediately without the user needing to close it manually.
 *
 * Uses a very specific pgrep pattern to target only the root browser process
 * (never GPU workers, renderer, or extension processes).
 *
 * Returns: { found: boolean, relaunched: boolean, error?: string }
 */
async function recloakChrome(libPath) {
  let pid = null;

  // Pattern must match the browser root process only.
  // Chrome's root process has --type=browser in its cmdline; worker processes have
  // --type=renderer, --type=gpu-process, --type=utility, etc.
  const patterns = [
    'google-chrome-stable --type=browser',
    'google-chrome --type=browser',
    'chromium-browser --type=browser',
  ];

  for (const pat of patterns) {
    try {
      const out = execFileSync('pgrep', ['-f', pat], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (out) {
        // pgrep may return multiple PIDs; take the first (oldest = parent).
        pid = parseInt(out.split('\n')[0], 10);
        if (!isNaN(pid)) break;
      }
    } catch (_) {}
  }

  if (!pid) return { found: false, relaunched: false };

  // Find the real binary (from /proc/<pid>/exe) so we re-launch the same one.
  let realBin = '/usr/bin/google-chrome-stable';
  try {
    realBin = fs.readlinkSync(`/proc/${pid}/exe`);
  } catch (_) {}

  // Graceful shutdown.
  try { process.kill(pid, 'SIGTERM'); } catch (e) {
    return { found: true, relaunched: false, error: `Could not signal Chrome PID ${pid}: ${e.message}` };
  }

  // Wait up to 2 seconds for Chrome to exit.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    try { process.kill(pid, 0); } catch (_) { break; } // PID gone → exited
  }

  // Re-launch with LD_PRELOAD.
  spawn(realBin, ['--disable-features=WebRtcPipeWireCapturer'], {
    env: { ...process.env, LD_PRELOAD: libPath },
    detached: true,
    stdio: 'ignore',
  }).unref();

  return { found: true, relaunched: true };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Main entry point.  Called on every Linux start from main.js.
 *
 * Returns:
 * {
 *   cloaked:      string[],  // app names successfully wrapped
 *   skipped:      string[],  // already cloaked with the same libPath
 *   snap:         string[],  // detected as Snap — cannot inject
 *   flatpak:      string[],  // detected as Flatpak — cannot inject
 *   notInstalled: string[],  // not found on this system
 *   pathOk:       boolean,   // ~/.local/bin is before /usr/bin in PATH
 *   libPath:      string,
 *   errors:       { app: string, message: string }[],
 * }
 */
async function autoCloak(libPath) {
  const result = {
    cloaked: [],
    skipped: [],
    snap: [],
    flatpak: [],
    notInstalled: [],
    pathOk: false,
    libPath,
    errors: [],
  };

  // Verify libghost.so actually exists at the given path before writing wrappers.
  if (!fs.existsSync(libPath)) {
    result.errors.push({ app: 'libghost.so', message: `Library not found at ${libPath}` });
    return result;
  }

  const pathCheck = checkPathOrder();
  result.pathOk = pathCheck.ok;

  for (const appDef of TARGET_APPS) {
    try {
      const installType = detectInstallType(appDef);

      if (installType === 'not-installed') {
        result.notInstalled.push(appDef.name);
        continue;
      }

      if (installType === 'snap') {
        result.snap.push(appDef.name);
        continue;
      }

      if (installType === 'flatpak') {
        result.flatpak.push(appDef.name);
        continue;
      }

      // Already cloaked with the exact same libPath → skip (idempotent).
      if (isCloaked(appDef, libPath)) {
        result.skipped.push(appDef.name);
        // Still rewrite .desktop patch to keep it in sync.
        writeDesktopPatch(appDef, libPath);
        continue;
      }

      // Write binary wrapper (primary mechanism).
      const wrapResult = writeBinaryWrapper(appDef, libPath);
      if (!wrapResult.ok) {
        result.errors.push({ app: appDef.name, message: `Binary wrapper: ${wrapResult.reason}` });
        continue;
      }

      // Write .desktop patch (belt + suspenders).
      writeDesktopPatch(appDef, libPath); // Failures here are non-fatal.

      result.cloaked.push(appDef.name);
    } catch (err) {
      result.errors.push({ app: appDef.name, message: err && err.message ? err.message : String(err) });
    }
  }

  return result;
}

module.exports = {
  autoCloak,
  recloakChrome,
  detectInstallType,
  isCloaked,
  checkPathOrder,
  writeBinaryWrapper,
  writeDesktopPatch,
  findRealBinary,
  TARGET_APPS,
};
