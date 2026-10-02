/**
 * llm-mobile.js — Streaming LLM client for GhostWolf Android.
 *
 * Mirrors the logic in src/llm.js but is browser-native (no Node.js require).
 * Supports: Groq, Gemini, OpenAI, Cerebras, GLM (ZhipuAI) — all OpenAI-compatible.
 * Uses fetch + ReadableStream for real-time token streaming.
 */

const LLM_DEFAULTS = {
  groq:     { baseURL: 'https://api.groq.com/openai/v1',            model: 'llama-3.1-8b-instant' },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1',                model: 'llama3.1-8b' },
  glm:      { baseURL: 'https://open.bigmodel.cn/api/paas/v4',      model: 'glm-4-flash' },
  openai:   { baseURL: 'https://api.openai.com/v1',                 model: 'gpt-4o-mini' },
  gemini:   { baseURL: null,                                         model: 'gemini-2.5-flash' },
};

const PROVIDER_LABELS = {
  groq: 'Groq', gemini: 'Gemini', openai: 'OpenAI',
  cerebras: 'Cerebras', glm: 'GLM (ZhipuAI)',
};

function isQuotaError(msg) {
  return /quota|billing|rate.?limit|exceeded|resource.?exhausted|too.?many.?requests|429/i.test(msg);
}
function isConnectionError(msg) {
  return /fetch.?failed|network|socket|timeout|econnrefused|enotfound|etimedout/i.test(msg);
}

async function streamOpenAICompat({ baseURL, apiKey, model, system, turns, maxTokens = 1024, onToken }) {
  const messages = [
    { role: 'system', content: system },
    ...turns.map(t => ({ role: t.role, content: t.text || t.content || '' })),
  ];

  const resp = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw Object.assign(new Error(`${resp.status} ${resp.statusText} — ${body.slice(0, 200)}`), { status: resp.status });
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onToken(delta); }
      } catch { /* skip malformed line */ }
    }
  }
  return full;
}

async function streamGemini({ apiKey, model, system, turns, maxTokens = 1024, onToken }) {
  const contents = turns.map(t => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.text || t.content || '' }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw Object.assign(new Error(`Gemini ${resp.status} — ${body.slice(0, 200)}`), { status: resp.status });
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (delta) { full += delta; onToken(delta); }
      } catch { /* skip */ }
    }
  }
  return full;
}

window.GWLLM = {
  /**
   * stream({ system, turns, maxTokens, onToken }) → Promise<string>
   * Reads provider + apiKey from GWStorage, auto-falls back on quota/connection errors.
   */
  async stream({ system, turns = [], maxTokens = 1024, onToken }) {
    const settings = GWStorage.load();
    const provider = settings.provider || 'groq';
    const apiKey = GWStorage.getApiKey(provider);

    if (!apiKey) throw new Error(`No API key configured for ${PROVIDER_LABELS[provider] || provider}. Open Settings → Keys.`);

    const defaults = LLM_DEFAULTS[provider] || LLM_DEFAULTS.groq;
    const model = settings.model || defaults.model;

    // Build fallback chain: try configured provider, then groq, then gemini
    const chain = [provider];
    if (provider !== 'groq' && GWStorage.getApiKey('groq')) chain.push('groq');
    if (provider !== 'gemini' && GWStorage.getApiKey('gemini')) chain.push('gemini');

    let lastError;
    for (const p of chain) {
      const key = GWStorage.getApiKey(p);
      if (!key) continue;
      const d = LLM_DEFAULTS[p] || LLM_DEFAULTS.groq;
      const m = (p === provider ? model : null) || d.model;
      try {
        if (p === 'gemini') {
          return await streamGemini({ apiKey: key, model: m, system, turns, maxTokens, onToken });
        } else {
          return await streamOpenAICompat({ baseURL: d.baseURL, apiKey: key, model: m, system, turns, maxTokens, onToken });
        }
      } catch (err) {
        lastError = err;
        const msg = err.message || String(err);
        if (isQuotaError(msg) || isConnectionError(msg)) {
          console.warn(`[LLM] ${p} failed, trying next in chain:`, msg);
          continue;
        }
        throw new Error(formatError(err, p));
      }
    }
    throw new Error(formatError(lastError, provider));
  },
};

function formatError(error, provider) {
  const label = PROVIDER_LABELS[provider] || provider;
  const msg = (error && error.message) || String(error);
  if (isQuotaError(msg)) return `${label} quota exceeded. Add a different provider key or wait and retry.`;
  if (isConnectionError(msg)) return `${label} is unreachable. Check your internet connection.`;
  return msg || 'Unknown LLM error.';
}
