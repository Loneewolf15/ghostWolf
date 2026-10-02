const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const store = require('./src/store');
const license = require('./src/license');
const { captureScreenshot } = require('./src/screen');
const { createSTT, looksLikeHallucination } = require('./src/stt');
const { UtteranceSegmenter } = require('./src/utterance-segmenter');
const { parseDocumentFile } = require('./src/resume');
const { createLLM } = require('./src/llm');
const { extractEntities, searchDuckDuckGoLite, researchJobDescription } = require('./src/research.js');
const { MODES, buildMemoryExtractionPrompt } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');
const { createMeetingStore } = require('./src/meetings');
const { buildNotesPrompt, parseNotes } = require('./src/notes');
const { createCapturePrivacy } = require('./src/capture-privacy');
const { RealtimeNoiseFilter } = require('./src/noise-filter');
const { applyPlatformWindowType } = require('./src/window-options');
const { AudioSourceGate } = require('./src/audio-source-gate');
const { publishGhostBounds } = process.platform === 'linux' ? require('./src/ghost-bounds') : {};

// macOS system-audio loopback (the "them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and meeting audio
// silently never works. Electron 39+ wires this up itself, where this is a
// harmless no-op. Must run before app is ready.
// On Windows 10 (build < 22000), Chromium's modern DirectComposition swap-chain causes
// the Desktop Window Manager to lose track of the SetWindowDisplayAffinity flag set by
// Electron's setContentProtection(true). Forcing the legacy GDI presentation path makes
// DWM reliably honour the exclusion flag. This is a no-op on Windows 11 and non-Windows.
// Must run before app is ready.
if (process.platform === 'win32') {
  const os = require('os');
  const buildNum = parseInt((os.release().split('.')[2] || '0'), 10);
  if (buildNum < 22000) {
    app.commandLine.appendSwitch('disable-direct-composition');
    app.commandLine.appendSwitch('disable-direct-composition-layers');
  }
}
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}
// Default GPU settings
const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');
const { LocalWhisperTranscriber } = require('./src/local-whisper-transcriber');

let win = null;
let capturePrivacy = null; // set in createWindow(), read by IPC handlers
// Which global shortcuts ghostwolf actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, quit: false };
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// (Windows version detection removed — Electron's setContentProtection() handles
//  its own platform/build gates internally on Windows 10 build 19041+ and macOS.)

let permWin = null;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
let sttProviderKeyIndex = {}; // tracks which key index we're using for each provider (for multi-key rotation)
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
let activeMeetingContext = []; // Stores background research results for current meeting
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
const STREAM_INACTIVITY_MS = 600000; // abort a stalled LLM stream so state.busy can't wedge forever
const MIN_BYTES = Math.floor(16000 * 2 * 0.12); // ~0.12s
let batchSegmenters = { you: null, them: null };
let batchQueueTail = Promise.resolve();
let pendingBatchJobs = 0;
let whisperModelManager = null;
let localWhisperTranscriber = null;
let activeWhisperModelId = null;
let desiredCaptureState = false;
let captureTransition = Promise.resolve(false);

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => {
      send('vad:state', { channel: 'them', speaking: false, durationMs: dur });
      // Feed speech event into the audio gate for meeting auto-detection
      const changed = audioSourceGate.recordSpeechEvent('them', dur);
      if (changed) {
        const status = audioSourceGate.getStatus();
        send('meeting:mode', status);
        console.log('[AudioGate] Meeting detection state changed:', status.mode);
      }
    }
  })
};

// Smart audio source gate — detects meetings and blocks notification audio
const audioSourceGate = new AudioSourceGate();
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

function pushTranscript(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}



let autoAssistTimer = null;

function publishTranscript(channel, text) {
  if (!text || !text.trim()) return;
  if (looksLikeHallucination(text)) return;
  const turn = { channel, text: text.trim(), ts: Date.now() };
  pushTranscript(turn);
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text });

  // Auto-assist hook: Trigger 'say' if 'them' finishes speaking and 2500ms passes without interruption.
  if (autoAssistTimer) { clearTimeout(autoAssistTimer); autoAssistTimer = null; }
  if (channel === 'them') {
    autoAssistTimer = setTimeout(() => {
      autoAssistTimer = null;
      if (!state.busy) runFeature('say', '');
    }, 2500);
  }

  // Speculative Search hook: Debounced background extraction of entities
  scheduleBackgroundResearch();
}

let researchTimer = null;
let lastResearchedTs = 0;
function scheduleBackgroundResearch() {
  if (researchTimer) clearTimeout(researchTimer);
  researchTimer = setTimeout(async () => {
    researchTimer = null;
    const recent = transcript.filter(t => t.ts > lastResearchedTs);
    if (recent.length === 0) return;
    lastResearchedTs = Date.now();
    
    try {
      const settings = store.getSettings();
      const entities = await extractEntities(recent, settings);
      for (const entity of entities) {
        if (!activeMeetingContext.some(c => c.includes(entity))) {
          send('research:status', { active: true, query: entity, message: `Searching web: ${entity}…` });
          const result = await searchDuckDuckGoLite(entity, settings);
          if (result) {
            activeMeetingContext.push(result);
            if (activeMeetingContext.length > 8) activeMeetingContext.shift(); // Keep latest 8
            send('research:status', { active: false, done: true, query: entity, snippet: result, totalCount: activeMeetingContext.length });
            send('status', { message: `🌐 Live web research: Found context on ${entity}` });
          } else {
            send('research:status', { active: false, query: entity });
          }
        }
      }
    } catch (e) {
      console.error('Background research error:', e);
      send('research:status', { active: false, error: e.message });
    }
  }, 10000); // 10 seconds of debounce before checking
}

async function startLocalWhisper(settings) {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const localSettings = settings.localWhisper || {};
  const model = requireWhisperModel(localSettings.modelId || 'base.en');
  const runtime = getWhisperRuntime();
  if (!runtime.available) throw new Error(runtime.message);
  activeWhisperModelId = model.id;
  let transcriber = null;
  try {
    const modelPath = await whisperModelManager.verifyInstalledModel(model.id).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Download the ${model.id} model in Settings → Audio before listening.`);
      }
      throw error;
    });

    transcriber = new LocalWhisperTranscriber({
      sessionOptions: {
        executablePath: runtime.executablePath,
        runtimeDirectory: runtime.runtimeDirectory,
        modelPath,
        language: model.englishOnly ? 'en' : (localSettings.language || 'auto'),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: model.tinydiarize
      },
      onTranscript: publishTranscript,
      onSpeechState: (channel, speaking, durationMs) => {
        send('vad:state', { channel, speaking, durationMs });
      },
      onStatus: (status) => send('stt:status', { provider: 'local', ...status }),
      onError: (error) => {
        sttDisabled = true;
        console.log('[local-whisper] error', error && error.message);
        if (localWhisperTranscriber) localWhisperTranscriber.forceStop().catch(() => {});
        handleSttError({ provider: 'local', message: error.message, status: 500, code: error.code || 'local_error' }, store.getSettings());
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription error: ${error.message}. Audio was not sent to a cloud fallback.` });
        setCapturing(false);
      }
    });

    localWhisperTranscriber = transcriber;
    await transcriber.start();
  } catch (error) {
    if (localWhisperTranscriber === transcriber) localWhisperTranscriber = null;
    activeWhisperModelId = null;
    if (transcriber) await transcriber.forceStop().catch(() => {});
    throw error;
  }
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;

  const savedSettings = store.getSettings();
  let startX = Math.round(workArea.x + (workArea.width - W) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    const clampedX = Math.max(workArea.x - W + 100, Math.min(savedSettings.windowX, workArea.x + workArea.width - 100));
    const clampedY = Math.max(workArea.y, Math.min(savedSettings.windowY, workArea.y + workArea.height - 40));
    startX = clampedX;
    startY = clampedY;
  }

  const winOptions = {
    width: W,
    height: H,
    x: startX,
    y: startY,
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Set the platform-appropriate BrowserWindow type so screen-sharing pickers
  // (Chrome, Zoom, Teams, OBS) exclude GhostWolf from the capturable-window list.
  //   Windows  → type:'toolbar' removes from Alt+Tab and taskbar.
  //   Linux    → type:'toolbar' writes _NET_WM_WINDOW_TYPE_UTILITY, excluded by
  //              Chromium's X11 window picker (and EWMH-compliant tools).
  //   macOS    → no type override; setContentProtection(true) handles exclusion
  //              and 'toolbar' would break keyboard focus.
  applyPlatformWindowType(process.platform, winOptions);

  win = new BrowserWindow(winOptions);

  // Linux GTK/X11: force the native window surface to fully transparent.
  // Without this the compositor may fall back to an opaque white surface
  // even when transparent:true and backgroundColor:'#00000000' are set in options.
  win.setBackgroundColor('#00000000');
  win.setSkipTaskbar(true);

  // Linux: keep /tmp/ghostwolf_bounds live so libghost.so always masks the
  // correct screen region even when the user drags or resizes the window.
  // publishGhostBounds writes on 'move' and 'resize' events — no polling.
  if (isLinux && typeof publishGhostBounds === 'function') {
    publishGhostBounds(win);
  }

  // Capture privacy: native on Windows/macOS, renderer-only on Linux.
  // createCapturePrivacy() never modifies third-party processes or PATH.
  capturePrivacy = createCapturePrivacy(win);
  const shouldProtect = !process.env.GHOSTWOLF_NO_PROTECT;
  if (shouldProtect) {
    const privacyResult = capturePrivacy.enable();
    console.log('[GhostWolf] Capture privacy result:', privacyResult);
    if (win && win.webContents) win.webContents.send('status', { message: 'Capture privacy result: ' + JSON.stringify(privacyResult, null, 2) });
    if (process.platform === 'win32' && typeof win.isContentProtected === 'function') {
      console.log(
        '[GhostWolf] Electron isContentProtected():',
        win.isContentProtected()
      );
    }
    if (privacyResult.native) {
      console.log(`[GhostWolf] Native capture protection enabled on ${process.platform}.`);
    } else {
      console.log(`[GhostWolf] Native capture protection unavailable on ${process.platform}.`);
      if (process.platform === 'linux') {
        console.log('[GhostWolf] Linux will use renderer-level privacy only.');
      }
    }
    
    // Fix: Re-apply the protection programmatically whenever the window visibility state changes.
    // This resolves the Electron state-clearing bug on Windows where hide/show can reset the flag.
    win.on('show', () => {
      capturePrivacy.enable();
    });
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    // Ensure transparent background is fully applied before showing.
    setTimeout(() => {
      win.show();
    }, 100);
  });

  // Save window position when the user moves the window.
  let moveSaveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        store.setSettings({ windowX: x, windowY: y });
      }
    }, 500);
  });

  win.setTitle('GhostWolf'); // set before load

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    win.setTitle('GhostWolf');
    // On Linux, inform the renderer that only renderer-level privacy is available.
    if (isLinux && shouldProtect) {
      const privacyStatus = capturePrivacy.status();
      if (!privacyStatus.supported) {
        console.log('[GhostWolf] Linux: renderer-level privacy mode only (Electron does not expose native capture exclusion).');
      }
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[GhostWolf] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- STT Utterance Segmentation & Queue (batch mode) --------
function enqueueBatchUtterance(channel, pcm) {
  if (!pcm || pcm.length < MIN_BYTES) return;
  pendingBatchJobs += 1;
  state.transcribing[channel] = true;
  send('stt:status', { provider: 'batch', channel, pending: pendingBatchJobs, status: 'transcribing' });

  const job = batchQueueTail.then(async () => {
    if (!state.capturing && !batchSegmenters[channel]) return;
    try {
      const settings = store.getSettings();
      function getActiveKey(p, keys) {
        const raw = keys[p] || '';
        if (!raw.includes(',')) return raw;
        const arr = raw.split(',').map(k => k.trim()).filter(Boolean);
        return arr[sttProviderKeyIndex[p] || 0] || arr[0];
      }
      const activeKeys = { ...settings.apiKeys };
      ['deepgram', 'openai', 'groq', 'gemini'].forEach(p => {
        activeKeys[p] = getActiveKey(p, settings.apiKeys);
      });
      const stt = createSTT({ ...settings, apiKeys: activeKeys });
      if (!stt.available) {
        if (!sttDisabled) {
          sttDisabled = true;
          send('status', { message: 'No transcription key set. Add an OpenAI (Whisper), Deepgram, or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' });
        }
        return;
      }

      // Circuit breaker: if we previously disabled STT due to repeated failures, stop hitting the API
      if (sttDisabled) return;

      const res = await stt.transcribe(pcm);
      if (res.error) {
        handleSttError(res.error, settings);
        return;
      }
      if (res.text && res.text.trim()) {
        publishTranscript(channel, res.text.trim());
      }
    } catch (e) {
      console.log('[stt] error', e && e.message);
      recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'enqueueBatchUtterance', context: { channel } });
    }
  }).catch((err) => {
    console.error('[stt] batch queue error', err);
  }).finally(() => {
    pendingBatchJobs -= 1;
    state.transcribing[channel] = false;
    if (pendingBatchJobs === 0 && state.capturing) {
      send('stt:status', { provider: 'batch', status: 'ready' });
    }
  });

  batchQueueTail = job;
  return job;
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state GhostWolf is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  const msg = String(err.message || '').toLowerCase();
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || msg.includes('quota exceeded') ||
                  msg.includes('timed out') || msg.includes('timeout') || msg.includes('fetch failed') ||
                  msg.includes('etimedout') || msg.includes('econnrefused') || msg.includes('enotfound') ||
                  msg.includes('network error') || msg.includes('socket hang up');
  
  if (isQuota || (err.provider === 'local' && err.status === 500)) {
    const s = store.getSettings();
    const STT_PRIORITY = ['deepgram', 'openai', 'groq', 'gemini', 'local'];
    const keys = s.apiKeys || {};
    let activeProvider = err.provider || s.sttProvider || 'auto';
    
    if (activeProvider === 'auto') {
      activeProvider = keys.deepgram ? 'deepgram' : (keys.openai ? 'openai' : (keys.groq ? 'groq' : (keys.gemini ? 'gemini' : 'local')));
    }

    const rawKeys = keys[activeProvider] || '';
    const keyCount = (activeProvider !== 'local' && rawKeys.includes(',')) ? rawKeys.split(',').filter(k => k.trim()).length : 1;
    
    if ((sttProviderKeyIndex[activeProvider] || 0) < keyCount - 1) {
      sttProviderKeyIndex[activeProvider] = (sttProviderKeyIndex[activeProvider] || 0) + 1;
      send('status', { message: `Switching to alternate ${activeProvider} key due to quota limit, timeout, or connection error.` });
      setCapturing(false).then(() => setCapturing(true));
      return;
    }

    sttProviderKeyIndex[activeProvider] = 0; // reset for next time

    let currentIndex = STT_PRIORITY.indexOf(activeProvider);
    if (currentIndex === -1) currentIndex = STT_PRIORITY.indexOf('local');
    
    let nextProvider = null;
    for (let i = 1; i < STT_PRIORITY.length; i++) {
      const p = STT_PRIORITY[(currentIndex + i) % STT_PRIORITY.length];
      if (p === 'local' || keys[p]) {
        nextProvider = p;
        break;
      }
    }

    if (nextProvider) {
      s.sttProvider = nextProvider;
      store.setSettings(s);
      send('settings:sync', s);
      send('status', { message: `Transcription switched to ${nextProvider === 'local' ? 'local model' : nextProvider}: your ${activeProvider} provider hit a quota limit or failed.` });
      setCapturing(false).then(() => setCapturing(true));
      return;
    }
  }

  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: `Transcription off: your ${err.provider} key was rejected or hit a quota limit. Update your key in Settings to resume.` });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function initBatchSegmenters() {
  for (const channel of ['you', 'them']) {
    const isRemote = channel === 'them';
    batchSegmenters[channel] = new UtteranceSegmenter({
      channel,
      vadOptions: {
        onsetThreshold: isRemote ? 180 : 200,
        offsetThreshold: isRemote ? 110 : 120,
        silenceFrames: isRemote ? 20 : 18
      },
      onSpeechState: (ch, speaking, durationMs) => {
        send('vad:state', { channel: ch, speaking, durationMs });
      },
      onUtterance: (ch, pcm) => {
        enqueueBatchUtterance(ch, pcm);
      }
    });
  }
}

function stopBatchSegmenters() {
  for (const ch of ['you', 'them']) {
    if (batchSegmenters[ch]) {
      batchSegmenters[ch].stop();
      batchSegmenters[ch] = null;
    }
  }
}

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  streamingMode = false;

  
  function getActiveKey(p, keys) {
    const raw = keys[p] || '';
    if (!raw.includes(',')) return raw;
    const arr = raw.split(',').map(k => k.trim()).filter(Boolean);
    return arr[sttProviderKeyIndex[p] || 0] || arr[0];
  }
  const activeKeys = { ...settings.apiKeys };
  ['deepgram', 'openai', 'groq', 'gemini'].forEach(p => {
    activeKeys[p] = getActiveKey(p, settings.apiKeys);
  });
  
  const modifiedSettings = { ...settings, apiKeys: activeKeys };

  ['you', 'them'].forEach((channel) => {
    const sttInstance = createStreamingSTT(modifiedSettings, channel, {
      onTranscript: (ch, text) => {
        const turn = { channel: ch, text, ts: Date.now() };
        pushTranscript(turn);
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      },
      onInterim: (ch, text) => {
        send('stt:interim', { channel: ch, text });
      },
      onError: (err) => {
        console.log('[streaming-stt] error', err.provider, err.message);

        const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
        if (isQuota) {
          const s = store.getSettings();
          if ((s.sttProvider || 'auto') !== 'local') {
            s.sttProvider = 'local';
            store.setSettings(s);
            send('settings:sync', s);
            send('status', { message: `Streaming transcription switched to local model: your ${err.provider || 'cloud'} key hit a quota limit.` });
            setCapturing(false).then(() => setCapturing(true));
            return;
          }
        }

        const batchFallbackAvailable = createSTT(settings).available;
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batchFallbackAvailable) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
          initBatchSegmenters();
        } else if (!sttDisabled) {
          sttDisabled = true;
          send('status', { message: `Transcription stopped (${err.provider}): ${err.message}. The selected provider has no batch fallback.` });
        }
        streamingMode = false;
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      streamingMode = true;
      streamingSTT[channel] = sttInstance.instance;
      sttInstance.instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// Real-time sub-millisecond DSP noise reduction filters
const noiseFilters = {
  you: new RealtimeNoiseFilter(),
  them: new RealtimeNoiseFilter()
};

// -------- audio routing (streaming or batch) --------
function routeAudio(channel, pcmBuffer) {
  let buf = Buffer.from(pcmBuffer);

  const filter = noiseFilters[channel];
  if (filter) {
    const s = store.getSettings();
    filter.setMode(s.noiseFilter || 'balanced');
    buf = filter.process(buf);
  }

  // Smart audio gate: record activity sample for meeting detection.
  // Gate notification-like audio bursts when in meeting mode.
  if (channel === 'them') {
    const hasAudio = buf.length > 0;
    audioSourceGate.recordActivitySample(hasAudio);
    const bufMs = (buf.length / 2) / 16; // ms at 16kHz mono int16
    if (!audioSourceGate.shouldPassThrough(channel, bufMs, buf)) {
      return; // Blocked — notification/non-meeting audio dropped
    }
  }

  if (localWhisperTranscriber) {
    localWhisperTranscriber.push(channel, buf);
    return;
  }

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send filtered PCM directly to the WebSocket
    vad[channel].processChunk(buf);
    ringBuffers[channel].write(buf);
    streamingSTT[channel].sendAudio(buf);
  } else {
    // Batch mode: route through utterance segmenter for phrase-coherent transcription
    if (!batchSegmenters[channel]) {
      initBatchSegmenters();
    }
    batchSegmenters[channel].push(buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside GhostWolf's own process
// and use GhostWolf's own Screen-Recording grant — no separate helper binary to authorize.
async function setCapturing(active) {
  if (active === state.capturing) return state.capturing;

  if (active) {
    sttDisabled = false; // reset on re-enable
    const settings = store.getSettings();
    if ((settings.sttProvider || 'auto') === 'local') {
      try {
        await startLocalWhisper(settings);
        state.capturing = true;
        console.log('[GhostWolf] capture started, mode: local');
        send('capture:state', { active: true, streaming: false, mode: 'local' });
        return true;
      } catch (error) {
        state.capturing = false;
        desiredCaptureState = false;
        if (error.code === 'STARTUP_CANCELLED') {
          send('stt:status', { provider: 'local', status: 'off' });
          send('capture:state', { active: false, streaming: false, mode: 'local' });
          return false;
        }
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription could not start: ${error.message} No audio was sent to a cloud provider.` });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
    }

    state.capturing = true;
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      initBatchSegmenters();
    }
    console.log('[GhostWolf] capture started, mode:', streaming ? 'streaming' : 'batch');
    send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
    return true;
  }

  state.capturing = false;
  stopBatchSegmenters();
  stopStreamingSTT();
  vad.you.reset(); vad.them.reset();
  noiseFilters.you.reset(); noiseFilters.them.reset();
  ringBuffers.you.clear(); ringBuffers.them.clear();
  audioSourceGate.reset(); // Reset transient detection state (manualMode preserved)
  const stoppingLocalTranscriber = localWhisperTranscriber;
  localWhisperTranscriber = null;
  send('capture:state', { active: false, streaming: false, mode: stoppingLocalTranscriber ? 'local' : 'off' });
  if (stoppingLocalTranscriber) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      await stoppingLocalTranscriber.stop();
    } catch (error) {
      console.log('[local-whisper] stop error', error && error.message);
    } finally {
      activeWhisperModelId = null;
    }
  }
  return false;
}

function handleLlmFallback(newProvider, oldProvider) {
  const s = store.getSettings();
  s.provider = newProvider;
  store.setSettings(s);
  send('settings:sync', s);
  send('status', { message: `AI switched to ${newProvider}: ${oldProvider} hit a quota limit.` });
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  let streamSettled = false; // drop stray tokens from a stream we've already abandoned
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings, handleLlmFallback);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : mode === 'answerThis' ? `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"` : null);
    const category = mode !== 'leetcode' ? detectCategory(transcript) : null;
    send('llm:start', { userBubble, small: !!def.small, category, provider: llm.provider, model: llm.model });

    if (!llm.ready) {
      const message = llm.configurationError || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      send('llm:error', { message });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try {
        imageDataUrl = await captureScreenshot();
        if (!imageDataUrl) throw new Error('No screen source was available.');
      }
      catch (e) {
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        const message = process.platform === 'darwin'
          ? 'Screen capture needs permission — grant Screen Recording to GhostWolf in System Settings.'
          : (process.platform === 'win32'
            ? 'Screen capture failed. Make sure GhostWolf is not blocked by Windows privacy or security software, then try again.'
            : 'Screen capture failed. Check your desktop capture permissions, then try again.');
        send('status', { message });
      }
    }

    const settingsForPrompt = store.getSettings();
    const contextBlock = buildInterviewContext(settingsForPrompt, mode, transcript, activeMeetingContext);
    const system = def.buildSystem ? def.buildSystem(contextBlock, settingsForPrompt.aiRules || '', settingsForPrompt.responseMode) : (def.system || '');
    const built = def.build({ transcript, userText: userText || '' });

    // Watchdog: a provider that stalls mid-stream would otherwise hang the await forever,
    // leaving state.busy = true and wedging every later question until an app restart.
    let watchdog = null;
    let rearm = () => {};
    const stalled = new Promise((_res, reject) => {
      rearm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error('the model stopped responding (timed out). Please try again.')), STREAM_INACTIVITY_MS);
      };
      rearm();
    });
    try {
      await Promise.race([
        llm.stream({
          system,
          turns: [{ role: 'user', text: built }],
          imageDataUrl,
          onToken: (t) => { if (streamSettled) return; rearm(); send('llm:token', { text: t }); }
        }),
        stalled
      ]);
    } finally {
      streamSettled = true;
      clearTimeout(watchdog);
    }
    send('llm:done', {});
  } catch (e) {
    recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider } });
    send('llm:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    streamSettled = true;
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
ipcMain.handle('capture:toggle', () => {
  const targetState = !desiredCaptureState;
  desiredCaptureState = targetState;
  if (!targetState && !state.capturing && localWhisperTranscriber) {
    localWhisperTranscriber.forceStop().catch(() => {});
  }
  captureTransition = captureTransition
    .catch(() => state.capturing)
    .then(() => setCapturing(targetState));
  return captureTransition;
});
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
}));
ipcMain.handle('transcript:clear', () => {
  transcript.splice(0, transcript.length);
  activeMeetingContext = [];
  lastResearchedTs = Date.now();
  if (win && !win.isDestroyed()) win.webContents.send('transcript:cleared');
});

// -------- meetings IPC (meeting store is initialised in launchApp) --------
// These are registered before launchApp so the IPC names are predictable;
// the handlers call out to `meetingStore` which is a module-level let below.
let meetingStore = null; // set in launchApp()
ipcMain.handle('meetings:list', () => meetingStore ? meetingStore.list() : []);
ipcMain.handle('meetings:add', () => {
  if (!meetingStore) return null;
  return meetingStore.add();
});
ipcMain.handle('meetings:update', (_e, id, patch) => meetingStore ? meetingStore.update(id, patch) : null);
ipcMain.handle('meetings:search', (_e, q) => meetingStore ? meetingStore.search(q) : []);
ipcMain.handle('meetings:recent-summaries', (_e, n) => meetingStore ? meetingStore.recentSummaries(n || 3) : []);
ipcMain.handle('meetings:remove', (_e, id) => meetingStore ? meetingStore.remove(id) : false);
ipcMain.handle('meetings:generate-notes', async (_e, id) => {
  if (!meetingStore) return { error: 'Meeting store not ready.' };
  const meeting = meetingStore.get(id);
  if (!meeting) return { error: 'Meeting not found.' };
  const settings = store.getSettings();
  const llm = createLLM(settings, handleLlmFallback);
  if (!llm.ready) return { error: llm.configurationError || 'LLM not configured.' };
  const prompt = buildNotesPrompt(meeting.transcript);
  let fullText;
  try {
    // `llm.stream()` returns the complete accumulated text after the stream ends.
    // onToken streams tokens to the renderer incrementally for real-time display.
    // We use the return value (not an onToken accumulator) as the canonical text
    // so there is no double-counting if the stream resolves synchronously.
    fullText = await llm.stream({
      system: 'You are GhostWolf, a meeting assistant. Write structured meeting notes.',
      turns: [{ role: 'user', text: prompt }],
      onToken: (t) => send('meetings:notes-token', { id, token: t })
    });
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
  const notes = parseNotes(fullText);
  meetingStore.update(id, notes);
  
  // Background memory extraction
  (async () => {
    try {
      const currentMemory = Array.isArray(settings.userMemory) ? settings.userMemory : [];
      const memPrompt = buildMemoryExtractionPrompt(meeting.transcript, currentMemory);
      const memLLM = createLLM(settings, handleLlmFallback);
      if (!memLLM.ready) return;
      const newFactsText = await memLLM.stream({
        system: 'You are ghostwolf, a discreet meeting assistant.',
        turns: [{ role: 'user', text: memPrompt }]
      });
      if (newFactsText && newFactsText.trim()) {
        const lines = newFactsText.split('\n').map(l => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
        if (lines.length > 0) {
          const freshMemory = [...currentMemory, ...lines];
          store.setSettings({ userMemory: freshMemory });
          console.log('[memory] Extracted ' + lines.length + ' new facts from meeting ' + id);
        }
      }
    } catch (e) {
      console.error('[memory] Extraction failed:', e);
    }
  })();

  return { ok: true, notes };
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));

// -------- Online Research IPC --------
ipcMain.handle('research:jd', async (_e, jdText) => {
  const settings = store.getSettings();
  send('research:status', { active: true, query: 'Job Description' });
  try {
    const { queries, results } = await researchJobDescription(jdText, settings, (prog) => {
      send('research:status', { active: prog.stage !== 'done', query: prog.query || 'Role & Tech Stack', message: prog.message });
    });
    for (const r of results) {
      if (!activeMeetingContext.some(c => c.includes(r.query))) {
        activeMeetingContext.push(r.snippet);
        if (activeMeetingContext.length > 8) activeMeetingContext.shift();
      }
    }
    send('research:status', { active: false, done: true, queries, resultsCount: results.length, totalCount: activeMeetingContext.length });
    return { ok: true, queries, resultsCount: results.length };
  } catch (err) {
    console.error('JD research error:', err);
    send('research:status', { active: false, error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('research:get-context', () => activeMeetingContext);

// -------- Audio source / meeting mode IPC --------
ipcMain.handle('meeting:set-mode', (_, mode) => {
  audioSourceGate.setManualMode(mode); // 'auto' | 'meeting' | 'blocked'
  const status = audioSourceGate.getStatus();
  send('meeting:mode', status);
  console.log('[AudioGate] Manual mode set:', mode, '->', status.mode);
  return { ok: true, status };
});

ipcMain.handle('meeting:get-status', () => audioSourceGate.getStatus());



// -------- Capture privacy IPC --------
// Renderer can query/toggle content protection state via these handlers.
ipcMain.handle('capture-privacy:status', () => {
  if (!capturePrivacy) return { supported: false, enabled: false, platform: process.platform };
  return capturePrivacy.status();
});
ipcMain.handle('capture-privacy:enable', () => {
  if (!capturePrivacy) return { supported: false, enabled: false, platform: process.platform };
  return capturePrivacy.enable();
});
ipcMain.handle('capture-privacy:disable', () => {
  if (!capturePrivacy) return { supported: false, enabled: false, platform: process.platform };
  return capturePrivacy.disable();
});
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('close-window', () => win && win.close());
ipcMain.on('window-drag', (e, { dx, dy }) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy, false);
});
ipcMain.on('window:resize', (e, { width, height }) => {
  if (!win) return;
  win.setContentSize(width, height, false);
});
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('devtools:open', () => {
  if (win && !win.isDestroyed()) {
    if (win.webContents.isDevToolsOpened()) {
      win.webContents.closeDevTools();
    } else {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  }
});
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => revokeAppLinkCaller(callerId));

// -------- permissions IPC --------
ipcMain.handle('permissions:check', () => getPermissionStatus());
ipcMain.handle('permissions:request', () => requestPermissions());
ipcMain.on('permissions:continue', async () => {
  const status = await getPermissionStatus();
  if (status.mic === 'granted' && status.screen === 'granted') {
    if (permWin) { permWin.close(); permWin = null; }
    launchApp();
  }
});

// -------- license ipc --------
ipcMain.handle('license:get-hardware-id', () => license.getHardwareId());
ipcMain.handle('license:verify', (_e, key) => {
  const isValid = license.verifyLicense(key);
  if (isValid) {
    license.saveLicense(key);
    if (activationWin) {
      activationWin.close();
      activationWin = null;
    }
    // Proceed with the normal launch
    startNormalBootSequence();
  }
  return isValid;
});

// -------- shortcuts --------
function registerShortcuts() {
  shortcutState.assist = globalShortcut.register('CommandOrControl+Return', () => runFeature('assist', ''));
  shortcutState.say = globalShortcut.register('CommandOrControl+Shift+Return', () => runFeature('say', ''));
  shortcutState.leetcode = globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  shortcutState.hide = globalShortcut.register('CommandOrControl+Shift+/', () => send('hide:toggle', {}));
  shortcutState.quit = globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
  // F12: toggle Electron DevTools in a detached window for debugging
  globalShortcut.register('F12', () => {
    if (win && !win.isDestroyed()) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });
  for (const [name, wasRegistered] of Object.entries(shortcutState)) {
    if (!wasRegistered) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds the ' + name + ' shortcut', frame: 'registerShortcuts', context: { shortcut: name } });
    }
  }
}

// -------- permissions --------
// systemPreferences.getMediaAccessStatus('screen') is unreliable: it can return
// 'not-determined' or 'denied' even after the user has granted Screen Recording,
// especially in dev mode (unsigned / no proper app bundle).  As a fallback we
// actually attempt a capture and inspect the thumbnail — if it contains any
// non-zero pixel data, macOS is giving us real screen content, i.e. granted.
async function verifyScreenAccess() {
  const sysStatus = systemPreferences.getMediaAccessStatus('screen');
  if (sysStatus === 'granted') return 'granted';

  // Fallback: try an actual capture and check the thumbnail for real pixels.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length > 0) {
      const bmp = sources[0].thumbnail.toBitmap();
      // toBitmap() returns raw RGBA bytes; any non-zero byte means real content
      if (bmp && bmp.some(byte => byte !== 0)) return 'granted';
    }
  } catch (_) {}

  return sysStatus;  // return the original system status if fallback didn't help
}

async function getPermissionStatus() {
  if (process.platform !== 'darwin') return { mic: 'granted', screen: 'granted' };
  return {
    mic: systemPreferences.getMediaAccessStatus('microphone'),
    screen: await verifyScreenAccess(),
  };
}

async function requestPermissions() {
  if (process.platform !== 'darwin') return true;

  // Trigger the macOS microphone permission dialog (first-use only)
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  // Trigger the macOS screen-recording permission dialog (first-use only).
  // There is no askForMediaAccess('screen'), but attempting to enumerate
  // sources via desktopCapturer will cause macOS to prompt the user.
  const screenStatus = await verifyScreenAccess();
  if (screenStatus !== 'granted') {
    try { await desktopCapturer.getSources({ types: ['screen'] }); } catch (_) {}
  }

  const status = await getPermissionStatus();
  return status.mic === 'granted' && status.screen === 'granted';
}

let activationWin = null;

function createActivationWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 400, H = 350;
  activationWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  activationWin.loadFile(path.join(__dirname, 'renderer', 'activation.html'));
  activationWin.webContents.on('did-finish-load', () => activationWin.show());
}

function createPermissionsWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 500, H = 540;
  permWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  permWin.loadFile(path.join(__dirname, 'renderer', 'permissions.html'));
  permWin.webContents.on('did-finish-load', () => permWin.show());
}

// -------- launch (called after permissions are confirmed) --------
function launchApp() {
  if (isMac && app.dock) app.dock.hide();

  whisperModelManager = new WhisperModelManager({ userDataPath: app.getPath('userData') });

  // Meeting persistence — local JSON file, survives across sessions.
  // Assigned to the module-level `let` so IPC handlers registered above can reach it.
  meetingStore = createMeetingStore({
    file: path.join(app.getPath('userData'), 'ghostwolf-meetings.json')
  });

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using GhostWolf's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return callback();
      const request = { video: sources[0] };
      if (isWindows) request.audio = true;
      else request.audio = 'loopback';
      callback(request);
    }).catch(() => callback());
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
    }),
    setCapturing,
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
  });

  createWindow();
  registerShortcuts();
}

// -------- lifecycle --------
if (!isWindows && !isMac) {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

app.whenReady().then(async () => {
  app.setName('GhostWolf');

  // Feature flag for hardware activation
  const ENABLE_ACTIVATION = process.env.GHOSTWOLF_REQUIRE_ACTIVATION === 'true';

  // Intercept boot: check license if activation is enabled
  if (ENABLE_ACTIVATION && !license.loadAndVerifyLicense()) {
    createActivationWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !activationWin) createActivationWindow(); });
    return;
  }

  startNormalBootSequence();
});

async function startNormalBootSequence() {
  if (isMac) {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      // Show the permissions gate — the dock stays visible so the user can find the app
      createPermissionsWindow();
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !permWin) createPermissionsWindow(); });
      return;
    }
  }

  launchApp();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !permWin && !activationWin) createWindow(); });
}

app.on('before-quit', () => {
  // Graceful teardown: explicitly stop capture so the OS drops mic/screen indicators instantly
  // before the windows are destroyed.
  if (state.capturing) {
    console.log('[GhostWolf] Graceful teardown: stopping capture streams');
    setCapturing(false);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Flush any pending debounced meeting transcript writes before exit.
  if (meetingStore) meetingStore.flush();
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
  if (localWhisperTranscriber) localWhisperTranscriber.forceStop().catch(() => {});
});
app.on('window-all-closed', (e) => {
  // Don't quit while the permissions window is open — the user may be in System Settings
  if (permWin) { e.preventDefault(); return; }
  app.quit();
});
