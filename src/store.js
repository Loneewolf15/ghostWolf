// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
// API keys are encrypted at rest using Electron safeStorage (AES-256 + OS keychain).
// Non-sensitive settings (models, UI prefs) stay in plaintext ghostwolf-data.json.
// Encrypted keys are stored in ghostwolf-keys.enc.json as base64-encoded ciphertext blobs.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { normalizeBaseUrl } = require('./openai-compatible');

const FILE = path.join(app.getPath('userData'), 'ghostwolf-data.json');
// Separate file for encrypted key blobs — clear boundary between sensitive and non-sensitive data.
const KEYS_FILE = path.join(app.getPath('userData'), 'ghostwolf-keys.enc.json');

// Cap on the user's custom response rules. Generous but bounded: anything longer
// should live in a real prompt file, not in a settings field.
const MAX_AI_RULES_CHARS = 2000;

// All provider keys that must be encrypted. Anything not in this list is stored as-is.
const API_KEY_PROVIDERS = ['openai', 'anthropic', 'gemini', 'deepgram', 'custom', 'ollama', 'groq', 'minimax', 'azure', 'aerolink'];

const DEFAULTS = {
  provider: 'openai',
  sttProvider: 'auto',
  localWhisper: {
    modelId: 'base.en',
    language: 'auto',
    threads: 0
  },
  smart: false,
  baseUrl: '',
  minimaxRegion: 'global_en',
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', custom: '', ollama: '', groq: '', minimax: '', azure: '', aerolink: '' },
  azureEndpoint: '',
  // Tab 2: Profile
  resumeText: '',
  jobDescription: '',
  // Tab 3: Interview Prep
  starStories: '',       // 3-5 behavioral STAR stories in plain English
  whyCompany: '',        // Why do you want to work here?
  whyLeaving: '',        // Why are you leaving your current job?
  workStyle: '',         // How you work, decision-making style, values
  // Tab 4: Q&A
  salaryTarget: '',      // e.g. "$150k-$180k base + equity"
  questionsToAsk: '',    // Questions to ask the interviewer
  // Tab 5: Style — custom response rules
  // The user writes how the AI should write: e.g. "no em-dashes", "use bullet
  // points", "casual tone". Applied to every LLM mode EXCEPT LeetCode (kept
  // strict for coding problems).
  aiRules: '',
  userMemory: [],
  // Window position
  windowX: null,
  windowY: null,
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    // Kept in sync with CURRENT_GEMINI_DEFAULT in src/llm.js — gemini-2.0-flash
    // (the previous default here) was retired by Google on 2026-03-03 and 404s
    // on every request. gemini-2.5-flash is current and free-tier available.
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' },
    custom: { fast: '', smart: '' },
    ollama: { fast: 'qwen2.5:0.5b', smart: 'llama3.2:1b' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    aerolink: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }
  }
};

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      if (k === 'aiRules' && typeof over[k] === 'string') {
        out[k] = over[k].slice(0, MAX_AI_RULES_CHARS);
      } else {
        out[k] = over[k];
      }
    }
  }
  return out;
}

// -------- safeStorage helpers --------
// safeStorage is available from Electron 15+ on all platforms.
// On Linux it requires libsecret + a running keyring daemon (GNOME Keyring or KWallet).
// If unavailable, we fall back to plaintext and warn once.
let _safeStorageAvailable = null;
let _safeStorageWarnedOnce = false;

function isSafeStorageAvailable() {
  if (_safeStorageAvailable === null) {
    try {
      _safeStorageAvailable = safeStorage && safeStorage.isEncryptionAvailable();
    } catch {
      _safeStorageAvailable = false;
    }
  }
  return _safeStorageAvailable;
}

function encryptKey(plaintext) {
  if (!plaintext) return { enc: '', plain: '' };
  if (isSafeStorageAvailable()) {
    try {
      const buf = safeStorage.encryptString(plaintext);
      return { enc: buf.toString('base64'), plain: '' };
    } catch (e) {
      console.warn('[store] safeStorage.encryptString failed, falling back to plaintext:', e && e.message);
    }
  } else if (!_safeStorageWarnedOnce) {
    _safeStorageWarnedOnce = true;
    console.warn('[store] safeStorage unavailable (Linux without keyring?). API keys stored in plaintext.');
  }
  return { enc: '', plain: plaintext };
}

function decryptKey(entry) {
  if (!entry) return '';
  // Prefer encrypted form if present
  if (entry.enc) {
    try {
      return safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
    } catch (e) {
      console.warn('[store] safeStorage.decryptString failed, trying plaintext fallback:', e && e.message);
    }
  }
  return entry.plain || '';
}

// -------- encrypted keys file --------
function loadEncryptedKeys() {
  try {
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveEncryptedKeys(encMap) {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(encMap, null, 2));
  } catch (e) {
    console.error('[store] encrypted keys save failed:', e && e.message);
  }
}

// -------- main settings load/save --------
function load() {
  if (data) return data;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }

  data = deepMerge(DEFAULTS, raw);

  // Decrypt API keys from the encrypted store and merge into data.
  // If a key exists in both ghostwolf-data.json (old plaintext) and ghostwolf-keys.enc.json,
  // the encrypted form wins and the plaintext copy will be cleared on next save.
  const encMap = loadEncryptedKeys();
  const resolvedKeys = {};
  let needsMigration = false;

  for (const provider of API_KEY_PROVIDERS) {
    const encEntry = encMap[provider];
    const plaintextInData = raw.apiKeys && raw.apiKeys[provider];

    if (encEntry) {
      resolvedKeys[provider] = decryptKey(encEntry);
    } else if (plaintextInData) {
      // Migrate plaintext key to encrypted storage on first load
      resolvedKeys[provider] = plaintextInData;
      needsMigration = true;
    } else {
      resolvedKeys[provider] = data.apiKeys[provider] || '';
    }
  }

  data.apiKeys = { ...data.apiKeys, ...resolvedKeys };

  if (needsMigration) {
    // Re-encrypt any plaintext keys discovered during load
    _flushEncryptedKeys();
    // Clear plaintext keys from the main data file
    const withoutKeys = { ...data };
    withoutKeys.apiKeys = Object.fromEntries(API_KEY_PROVIDERS.map((p) => [p, '']));
    try { fs.writeFileSync(FILE, JSON.stringify({ ...raw, apiKeys: withoutKeys.apiKeys }, null, 2)); } catch { /* best effort */ }
  }

  return data;
}

function _flushEncryptedKeys() {
  if (!data) return;
  const encMap = {};
  for (const provider of API_KEY_PROVIDERS) {
    const plaintext = (data.apiKeys && data.apiKeys[provider]) || '';
    encMap[provider] = encryptKey(plaintext);
  }
  saveEncryptedKeys(encMap);
}

function save() {
  // Encrypt API keys separately; store only non-sensitive fields in ghostwolf-data.json.
  _flushEncryptedKeys();
  const toWrite = { ...data, apiKeys: Object.fromEntries(API_KEY_PROVIDERS.map((p) => [p, ''])) };
  try {
    fs.writeFileSync(FILE, JSON.stringify(toWrite, null, 2));
  } catch (e) {
    // Log instead of swallowing — a silent settings-save failure would lose API keys.
    console.error('[store] settings save failed:', e && e.message);
  }
}

module.exports = {
  MAX_AI_RULES_CHARS,
  getSettings() { return load(); },
  setSettings(patch) {
    load();
    const nextSettings = deepMerge(data, patch || {});
    nextSettings.baseUrl = normalizeBaseUrl(nextSettings.baseUrl);
    data = nextSettings;
    save();
    return data;
  }
};
