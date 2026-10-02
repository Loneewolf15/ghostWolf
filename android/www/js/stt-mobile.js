/**
 * stt-mobile.js — Speech-to-Text engine for GhostWolf Android.
 *
 * Supports three backends:
 *   1. groq-whisper   — Records 3s chunks, sends to Groq Whisper API (default)
 *   2. openai-whisper — Same flow, sends to OpenAI Whisper API
 *   3. webspeech      — Uses Web Speech API (browser built-in, free, less accurate)
 *
 * System audio (MediaProjection) is handled via the native Capacitor plugin
 * GhostWolfAudio which is injected into window.GhostWolfAudio by the plugin.
 * Falls back to mic-only if the plugin is not available.
 */

const STT_CHUNK_MS   = 3000;   // 3 second chunks for Whisper
const STT_SAMPLE_HZ  = 16000;  // Whisper wants 16kHz mono
const SILENCE_THRESH = 0.01;   // RMS below this = silence, skip chunk
const MAX_CHUNK_MS   = 8000;   // max chunk length before force-flush

const GROQ_STT_URL  = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Whisper hallucination filter — same list as desktop local-whisper-transcriber.js
const HALLUCINATION_RE = /^\s*(\[BLANK_AUDIO\]|\(music\)|\[music\]|\(silence\)|\[silence\]|thanks for watching|thank you for watching|\.{3,}|ugh+|hmm+|um+)\s*$/i;

window.GWSTT = {
  _active: false,
  _audioCtx: null,
  _micStream: null,
  _sysStream: null,  // MediaProjection system audio stream
  _recorder: null,
  _webSpeechRecog: null,
  _chunks: [],
  _flushTimer: null,
  _onTranscript: null,
  _onStatus: null,
  _mode: 'mic',  // 'mic' | 'both'

  get active() { return this._active; },

  async start({ onTranscript, onStatus, mode = 'both' }) {
    if (this._active) return;
    this._onTranscript = onTranscript;
    this._onStatus = onStatus;
    this._mode = mode;

    const settings = GWStorage.load();
    const sttProvider = settings.sttProvider || 'groq-whisper';

    if (sttProvider === 'webspeech') {
      return this._startWebSpeech(onTranscript, onStatus);
    }

    return this._startWhisper(sttProvider, onTranscript, onStatus);
  },

  // ── Whisper path ──────────────────────────────────────────────
  async _startWhisper(sttProvider, onTranscript, onStatus) {
    onStatus('requesting-mic');

    // 1. Mic stream (always)
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: STT_SAMPLE_HZ, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      throw new Error('Microphone permission denied. Grant microphone access in Android settings.');
    }
    this._micStream = micStream;

    // 2. System audio (MediaProjection — optional, Android 10+ only)
    let sysStream = null;
    if (this._mode === 'both' && window.GhostWolfAudio) {
      try {
        onStatus('requesting-system-audio');
        sysStream = await window.GhostWolfAudio.startCapture();
        this._sysStream = sysStream;
        onStatus('system-audio-granted');
      } catch (err) {
        console.warn('[STT] System audio not available, mic-only mode:', err.message);
        onStatus('mic-only');
      }
    } else {
      onStatus('mic-only');
    }

    // 3. Build AudioContext and merge tracks
    const audioCtx = new AudioContext({ sampleRate: STT_SAMPLE_HZ });
    this._audioCtx = audioCtx;
    const dest = audioCtx.createMediaStreamDestination();

    // Mic source
    const micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(dest);

    // System audio source (if we got it)
    if (sysStream) {
      const sysSource = audioCtx.createMediaStreamSource(sysStream);
      sysSource.connect(dest);
    }

    // 4. MediaRecorder on merged stream
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this._recorder = new MediaRecorder(dest.stream, { mimeType });
    this._chunks = [];
    this._active = true;

    this._recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };

    // Flush every STT_CHUNK_MS
    this._recorder.onstart = () => {
      this._scheduleFlush(sttProvider);
    };

    this._recorder.start(100); // 100ms timeslices so ondataavailable fires often
    onStatus('listening');
  },

  _scheduleFlush(sttProvider) {
    if (!this._active) return;
    this._flushTimer = setTimeout(async () => {
      if (!this._active) return;
      await this._flushChunk(sttProvider);
      this._scheduleFlush(sttProvider);
    }, STT_CHUNK_MS);
  },

  async _flushChunk(sttProvider) {
    if (!this._chunks.length) return;
    const chunks = this._chunks.splice(0);
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (blob.size < 1000) return; // too small, skip

    try {
      const text = await this._transcribe(blob, sttProvider);
      if (text && !HALLUCINATION_RE.test(text)) {
        this._onTranscript({ channel: 'you', text: text.trim() });
      }
    } catch (err) {
      console.error('[STT] Whisper transcription failed:', err.message);
    }
  },

  async _transcribe(blob, sttProvider) {
    const settings = GWStorage.load();
    let apiKey, url;

    if (sttProvider === 'openai-whisper') {
      apiKey = GWStorage.getApiKey('openai');
      url = OPENAI_STT_URL;
    } else {
      // Default: groq-whisper
      apiKey = GWStorage.getApiKey('groq');
      url = GROQ_STT_URL;
    }

    if (!apiKey) throw new Error(`No API key for ${sttProvider}. Configure in Settings → Keys.`);

    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'en');
    form.append('response_format', 'json');

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Whisper ${resp.status}: ${body.slice(0, 150)}`);
    }

    const json = await resp.json();
    return json.text || '';
  },

  // ── Web Speech path ───────────────────────────────────────────
  _startWebSpeech(onTranscript, onStatus) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('Web Speech API not supported on this device. Use Groq Whisper instead.');

    const recog = new SR();
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = 'en-US';
    this._webSpeechRecog = recog;
    this._active = true;

    recog.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text && !HALLUCINATION_RE.test(text)) {
            onTranscript({ channel: 'you', text });
          }
        }
      }
    };
    recog.onerror = (e) => console.error('[STT] WebSpeech error:', e.error);
    recog.onend = () => { if (this._active) recog.start(); };

    recog.start();
    onStatus('listening');
  },

  // ── Stop ──────────────────────────────────────────────────────
  async stop() {
    this._active = false;
    clearTimeout(this._flushTimer);

    if (this._recorder && this._recorder.state !== 'inactive') {
      this._recorder.stop();
    }
    if (this._webSpeechRecog) {
      this._webSpeechRecog.abort();
      this._webSpeechRecog = null;
    }
    if (this._micStream) {
      this._micStream.getTracks().forEach(t => t.stop());
      this._micStream = null;
    }
    if (this._sysStream) {
      this._sysStream.getTracks().forEach(t => t.stop());
      this._sysStream = null;
    }
    if (window.GhostWolfAudio) {
      window.GhostWolfAudio.stopCapture().catch(() => {});
    }
    if (this._audioCtx) {
      await this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }

    this._chunks = [];
    this._recorder = null;
    if (this._onStatus) this._onStatus('off');
  },
};
