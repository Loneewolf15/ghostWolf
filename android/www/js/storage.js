/**
 * storage.js — localStorage-backed settings store for GhostWolf Android.
 * Keeps the same schema as the desktop app's store.js for future sync compatibility.
 */

const STORAGE_KEY = 'ghostwolf-settings-v1';

const DEFAULT_SETTINGS = {
  provider: 'groq',
  sttProvider: 'groq-whisper',
  model: '',
  apiKeys: {},
  resume: '',
  jobDescription: '',
  starStories: '',
  whyCompany: '',
  whyLeaving: '',
  workStyle: '',
  salaryTarget: '',
  questionsToAsk: '',
  aiRules: '',
  responseMode: 'conversational',
};

window.GWStorage = {
  _cache: null,

  load() {
    if (this._cache) return this._cache;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this._cache = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    } catch {
      this._cache = { ...DEFAULT_SETTINGS };
    }
    return this._cache;
  },

  save(patch) {
    const settings = this.load();
    Object.assign(settings, patch);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.error('GWStorage: save failed', e);
    }
    return settings;
  },

  get(key) {
    return this.load()[key];
  },

  getApiKey(provider) {
    const keys = this.load().apiKeys || {};
    const val = keys[provider];
    if (!val) return '';
    if (Array.isArray(val)) return val[0] || '';
    return val;
  },

  setApiKey(provider, key) {
    const settings = this.load();
    settings.apiKeys = settings.apiKeys || {};
    settings.apiKeys[provider] = key;
    this.save({ apiKeys: settings.apiKeys });
  },
};
