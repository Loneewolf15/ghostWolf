/**
 * app.js — Main application controller for GhostWolf Android.
 *
 * Wires together: STT → Transcript → LLM → UI
 * Replaces Electron IPC with direct JS module calls.
 */

// ── State ──────────────────────────────────────────────────────
const state = {
  transcript: [],       // { channel: 'you'|'them', text: string, ts: number }[]
  capturing: false,
  streaming: false,
  privacyMode: false,
  clearConfirmTimeout: null,
};

// ── DOM refs ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const liveDot       = $('live-dot');
const sttBadge      = $('stt-badge');
const messagesEl    = $('messages');
const interimBar    = $('interim-bar');
const interimText   = $('interim-text');
const interimChan   = $('interim-channel');
const captureBtn    = $('capture-btn');
const captureIcon   = $('capture-icon');
const captureLabel  = $('capture-label');
const inputEl       = $('input');
const sendBtn       = $('send-btn');
const clearBtn      = $('clear-btn');
const privacyBtn    = $('privacy-btn');
const privacyOverlay= $('privacy-overlay');
const privacyOffBtn = $('privacy-off-btn');
const settingsBtn   = $('settings-btn');
const settingsScrim = $('settings-scrim');
const settingsClose = $('settings-close');
const audioModeBtn  = $('audio-mode-btn');

// Prep pills
const prepPills = document.querySelectorAll('.prep-pill');

// ── Toast ──────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, ms = 3000) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ── STT status updates ─────────────────────────────────────────
function onSttStatus(status) {
  const labels = {
    'off':                    ['off',       false, false],
    'requesting-mic':         ['...',       false, false],
    'requesting-system-audio':['asking...',false, false],
    'mic-only':               ['mic only', true,  true ],
    'system-audio-granted':   ['mic+sys',  true,  true ],
    'listening':              ['live',     true,  true ],
  };
  const [label, dotOn, active] = labels[status] || ['...', false, false];
  sttBadge.textContent = label;
  sttBadge.classList.toggle('active', active);
  liveDot.className = active ? 'listening' : 'off';
}

// ── Transcript append ──────────────────────────────────────────
function onTranscript({ channel, text }) {
  if (!text || !text.trim()) return;

  const entry = { channel, text: text.trim(), ts: Date.now() };
  state.transcript.push(entry);

  // Update interim bar briefly
  interimChan.textContent = channel === 'them' ? 'Them' : 'You';
  interimChan.className   = channel === 'them' ? 'channel-them' : 'channel-you';
  interimText.textContent = text.trim();
  interimBar.classList.remove('hidden');

  // Hide interim bar after 4s
  clearTimeout(interimBar._timer);
  interimBar._timer = setTimeout(() => interimBar.classList.add('hidden'), 4000);

  // Auto-assist if THEM just spoke
  if (channel === 'them') {
    autoAssist();
  }
}

// ── Auto-assist on "them" speech ───────────────────────────────
let autoAssistTimer;
function autoAssist() {
  clearTimeout(autoAssistTimer);
  autoAssistTimer = setTimeout(() => {
    runMode('say');
  }, 800); // slight debounce so rapid transcript segments merge
}

// ── Run a mode (say / assist / followup / recap) ───────────────
async function runMode(mode, userText = '') {
  if (state.streaming) return;
  state.streaming = true;

  const bubble = appendMessage(mode, '');
  bubble.classList.add('msg-streaming');

  try {
    const { system, turns } = GWContext.buildModePrompt(mode, state.transcript, userText);
    let full = '';
    await GWLLM.stream({
      system,
      turns,
      maxTokens: 1024,
      onToken: (token) => {
        full += token;
        bubble.querySelector('.msg-text').textContent = full;
        messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
      },
    });
    bubble.classList.remove('msg-streaming');
  } catch (err) {
    bubble.querySelector('.msg-text').textContent = `⚠️ ${err.message}`;
    bubble.classList.remove('msg-streaming');
    showToast(err.message, 5000);
  } finally {
    state.streaming = false;
  }
}

// ── Message bubbles ────────────────────────────────────────────
const MODE_ICONS = { say: '💬', assist: '⚡', followup: '🔄', recap: '📋', ask: '❓' };

function appendMessage(mode, text) {
  // Remove welcome message on first response
  const welcome = messagesEl.querySelector('.welcome-msg');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `
    <div class="msg-header">
      <span class="msg-mode-icon">${MODE_ICONS[mode] || '🐺'}</span>
      <span>${mode.charAt(0).toUpperCase() + mode.slice(1)}</span>
    </div>
    <div class="msg-text">${text}</div>
    <button class="msg-copy-btn" title="Copy">Copy</button>
  `;
  div.querySelector('.msg-copy-btn').addEventListener('click', () => {
    const txt = div.querySelector('.msg-text').textContent;
    navigator.clipboard.writeText(txt).catch(() => {});
    showToast('Copied!', 1500);
  });
  messagesEl.appendChild(div);
  messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
  return div;
}

// ── Capture (start/stop) ───────────────────────────────────────
async function toggleCapture() {
  if (state.capturing) {
    await GWSTT.stop();
    state.capturing = false;
    captureBtn.className = 'capture-off';
    captureIcon.textContent = '🎙️';
    captureLabel.textContent = 'Start Listening';
    interimBar.classList.add('hidden');
    onSttStatus('off');
  } else {
    captureBtn.disabled = true;
    captureLabel.textContent = 'Starting…';
    try {
      await GWSTT.start({
        onTranscript,
        onStatus: onSttStatus,
        mode: audioModeBtn.dataset.mode || 'both',
      });
      state.capturing = true;
      captureBtn.className = 'capture-on';
      captureIcon.textContent = '⏹️';
      captureLabel.textContent = 'Stop Listening';
    } catch (err) {
      showToast('⚠️ ' + err.message, 5000);
      onSttStatus('off');
      captureBtn.className = 'capture-off';
      captureIcon.textContent = '🎙️';
      captureLabel.textContent = 'Start Listening';
    }
    captureBtn.disabled = false;
  }
}

// ── Privacy Mode ───────────────────────────────────────────────
function togglePrivacy() {
  state.privacyMode = !state.privacyMode;
  privacyOverlay.classList.toggle('hidden', !state.privacyMode);
  privacyBtn.textContent = state.privacyMode ? '🔓' : '🔒';

  // Tell native plugin to set/unset FLAG_SECURE
  if (window.GhostWolfPrivacy) {
    window.GhostWolfPrivacy.setSecure({ secure: state.privacyMode }).catch(() => {});
  }
}

// ── Clear conversation ─────────────────────────────────────────
function handleClear() {
  if (!state.clearConfirmTimeout) {
    clearBtn.classList.add('confirm');
    clearBtn.title = 'Tap again to confirm';
    showToast('Tap 🗑️ again to clear', 3000);
    state.clearConfirmTimeout = setTimeout(() => {
      clearBtn.classList.remove('confirm');
      clearBtn.title = 'Clear conversation';
      state.clearConfirmTimeout = null;
    }, 3000);
    return;
  }
  // Second tap: actually clear
  clearTimeout(state.clearConfirmTimeout);
  state.clearConfirmTimeout = null;
  clearBtn.classList.remove('confirm');
  clearBtn.title = 'Clear conversation';
  state.transcript = [];
  messagesEl.innerHTML = '<div class="welcome-msg"><div class="welcome-icon">🐺</div><div class="welcome-text">GhostWolf is ready.<br>Tap <strong>Start Listening</strong> to begin.</div></div>';
  interimBar.classList.add('hidden');
  showToast('Conversation cleared', 2000);
}

// ── Audio mode toggle ──────────────────────────────────────────
function cycleAudioMode() {
  const modes = [
    { mode: 'both', label: '🎧 Mic + System' },
    { mode: 'mic',  label: '🎙️ Mic only' },
  ];
  const current = modes.findIndex(m => m.mode === (audioModeBtn.dataset.mode || 'both'));
  const next = modes[(current + 1) % modes.length];
  audioModeBtn.dataset.mode = next.mode;
  audioModeBtn.textContent = next.label;
  showToast(`Audio: ${next.label}`, 2000);
}

// ── Prep status pills ──────────────────────────────────────────
function updatePrepPills() {
  const s = GWStorage.load();
  const checks = {
    resume:  !!(s.resume && s.resume.trim()),
    jd:      !!(s.jobDescription && s.jobDescription.trim()),
    stories: !!(s.starStories && s.starStories.trim()),
    salary:  !!(s.salaryTarget && s.salaryTarget.trim()),
  };
  prepPills.forEach(pill => {
    const field = pill.dataset.field;
    pill.classList.toggle('ready', !!checks[field]);
  });
}

// ── Settings Panel ─────────────────────────────────────────────
function openSettings() { settingsScrim.classList.remove('hidden'); }
function closeSettings() { settingsScrim.classList.add('hidden'); }

function loadSettingsUI() {
  const s = GWStorage.load();
  // Keys
  $('key-groq').value    = GWStorage.getApiKey('groq');
  $('key-gemini').value  = GWStorage.getApiKey('gemini');
  $('key-openai').value  = GWStorage.getApiKey('openai');
  $('key-cerebras').value= GWStorage.getApiKey('cerebras');
  $('key-glm').value     = GWStorage.getApiKey('glm');
  $('model-input').value = s.model || '';

  // Active provider
  document.querySelectorAll('#provider-seg button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.provider === s.provider);
  });

  // STT
  document.querySelectorAll('#stt-seg button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.stt === (s.sttProvider || 'groq-whisper'));
  });

  // Profile
  $('resume-text').value      = s.resume || '';
  $('job-description').value  = s.jobDescription || '';

  // Prep
  $('star-stories').value     = s.starStories || '';
  $('why-company').value      = s.whyCompany || '';
  $('salary-target').value    = s.salaryTarget || '';
  $('questions-to-ask').value = s.questionsToAsk || '';

  // Style
  $('response-mode').value    = s.responseMode || 'conversational';
  $('ai-rules').value         = s.aiRules || '';
  updateAiRulesCount();
}

function saveKeys() {
  GWStorage.setApiKey('groq',     $('key-groq').value.trim());
  GWStorage.setApiKey('gemini',   $('key-gemini').value.trim());
  GWStorage.setApiKey('openai',   $('key-openai').value.trim());
  GWStorage.setApiKey('cerebras', $('key-cerebras').value.trim());
  GWStorage.setApiKey('glm',      $('key-glm').value.trim());
  const provider = document.querySelector('#provider-seg button.active')?.dataset.provider || 'groq';
  const sttProvider = document.querySelector('#stt-seg button.active')?.dataset.stt || 'groq-whisper';
  GWStorage.save({ provider, sttProvider, model: $('model-input').value.trim() });
  updatePrepPills();
  showToast('Keys saved ✓', 2000);
}

function saveProfile() {
  GWStorage.save({
    resume:         $('resume-text').value,
    jobDescription: $('job-description').value,
  });
  updatePrepPills();
  showToast('Profile saved ✓', 2000);
}

function savePrep() {
  GWStorage.save({
    starStories:    $('star-stories').value,
    whyCompany:     $('why-company').value,
    salaryTarget:   $('salary-target').value,
    questionsToAsk: $('questions-to-ask').value,
  });
  updatePrepPills();
  showToast('Prep saved ✓', 2000);
}

function saveStyle() {
  GWStorage.save({
    responseMode: $('response-mode').value,
    aiRules:      $('ai-rules').value,
  });
  showToast('Style saved ✓', 2000);
}

function updateAiRulesCount() {
  const count = ($('ai-rules').value || '').length;
  $('ai-rules-count').textContent = count;
}

// ── Settings Tabs ──────────────────────────────────────────────
document.querySelectorAll('.sp-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sp-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sp-pane').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    document.querySelector(`.sp-pane[data-pane="${tab.dataset.tab}"]`).classList.remove('hidden');
  });
});

// Provider seg
document.querySelectorAll('#provider-seg button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#provider-seg button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// STT seg
document.querySelectorAll('#stt-seg button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#stt-seg button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ── Auto-resize textarea ───────────────────────────────────────
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

// ── Event wiring ───────────────────────────────────────────────
captureBtn.addEventListener('click', toggleCapture);

document.querySelectorAll('.act-btn').forEach(btn => {
  const modeMap = {
    'btn-say':      'say',
    'btn-assist':   'assist',
    'btn-followup': 'followup',
    'btn-recap':    'recap',
  };
  btn.addEventListener('click', () => {
    const mode = modeMap[btn.id];
    if (mode) runMode(mode);
  });
});

sendBtn.addEventListener('click', () => {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  runMode('assist', text);
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

clearBtn.addEventListener('click', handleClear);
audioModeBtn.addEventListener('click', cycleAudioMode);
privacyBtn.addEventListener('click', togglePrivacy);
privacyOffBtn.addEventListener('click', togglePrivacy);

settingsBtn.addEventListener('click', () => { loadSettingsUI(); openSettings(); });
settingsClose.addEventListener('click', closeSettings);
settingsScrim.addEventListener('click', (e) => { if (e.target === settingsScrim) closeSettings(); });

$('keys-save').addEventListener('click', saveKeys);
$('profile-save').addEventListener('click', saveProfile);
$('prep-save').addEventListener('click', savePrep);
$('style-save').addEventListener('click', saveStyle);
$('ai-rules').addEventListener('input', updateAiRulesCount);

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updatePrepPills();
  onSttStatus('off');

  // Capacitor ready — apply FLAG_SECURE immediately on app open
  document.addEventListener('deviceready', () => {
    if (window.GhostWolfPrivacy) {
      window.GhostWolfPrivacy.setSecure({ secure: true }).catch(() => {});
    }
  }, { once: true });
});
