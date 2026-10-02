const { createLLM } = require('./llm.js');

const SEARCH_PROMPT = `You are a background entity extractor.
Extract any specific companies, programs, software products, or niche technical terms from the provided transcript that someone might need background context on during an interview.
Output ONLY a comma-separated list of the entities.
If there are no specific entities that require web research, output EXACTLY the word "NONE".
Do not extract common words, generic job titles, or conversational filler.`;

async function extractEntities(transcript, settings) {
  const llm = createLLM(settings, () => {});
  if (!llm.ready) return [];
  
  const text = transcript.map(t => `${t.channel.toUpperCase()}: ${t.text}`).join('\n');
  if (!text.trim()) return [];

  let result = '';
  try {
    result = await llm.stream({
      system: SEARCH_PROMPT,
      turns: [{ role: 'user', text }],
      maxTokens: 50,
      onToken: () => {} // ignore tokens, just want the final result
    });
  } catch (err) {
    console.error('Entity extraction failed:', err);
    return [];
  }

  const clean = result.trim();
  if (!clean || clean.toUpperCase().includes('NONE')) return [];

  return clean.split(',').map(s => s.trim()).filter(Boolean);
}

async function searchDuckDuckGoLite(query, settings = null) {
  if (!query || !query.trim()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let wikipediaResult = null;
  
  try {
    // DDG Lite blocks headless scrapers with a CAPTCHA. Fallback to Wikipedia API
    const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostWolf/1.0'
      },
      signal: controller.signal
    });
    
    if (res.ok) {
      const data = await res.json();
      if (data && data.query && data.query.search && data.query.search.length > 0) {
        // Take top 2 snippets and strip HTML tags
        const snippets = data.query.search.slice(0, 2).map(r => r.snippet.replace(/<[^>]+>/g, '').trim());
        if (snippets.length > 0) {
          wikipediaResult = `[Search results for "${query}"]: ${snippets.join(' | ')}`;
        }
      }
    }
  } catch (err) {
    // Network errors/timeouts handled gracefully
  } finally {
    clearTimeout(timer);
  }

  if (wikipediaResult) return wikipediaResult;

  // Fallback: If Wikipedia has no data (e.g. obscure startups), use LLM's internal knowledge
  if (settings) {
    const llm = createLLM(settings, () => {});
    if (llm.ready) {
      try {
        const fallbackPrompt = `You are an expert background researcher. Provide a concise, 1-2 sentence background summary of the requested company or technology. If you do not know it, answer exactly "UNKNOWN".`;
        const result = await llm.stream({
          system: fallbackPrompt,
          turns: [{ role: 'user', text: `What is "${query}"?` }],
          maxTokens: 100,
          onToken: () => {}
        });
        const clean = (result || '').trim();
        if (clean && !clean.toUpperCase().includes('UNKNOWN') && clean.length > 10) {
          return `[Background for "${query}"]: ${clean}`;
        }
      } catch (e) {
        console.error('LLM fallback search failed:', e);
      }
    }
  }

  return null;
}

const JD_RESEARCH_PROMPT = `You are a background researcher preparing candidate context for an interview.
Analyze this job description and extract up to 3 targeted web search queries that would reveal:
1. What the hiring company does, their primary product, or recent company initiatives.
2. The specific technical stack, architecture, or engineering domain mentioned in the role.
Output ONLY a comma-separated list of 1 to 3 search queries.
If the job description is too short or has no specific company/tech details, output "NONE".`;

async function researchJobDescription(jdText, settings, onProgress = () => {}) {
  if (!jdText || !jdText.trim()) return { queries: [], results: [] };
  
  let queries = [];
  const llm = createLLM(settings, () => {});
  if (llm.ready) {
    try {
      onProgress({ stage: 'extracting', message: 'Analyzing job description for company and tech stack…' });
      const raw = await llm.stream({
        system: JD_RESEARCH_PROMPT,
        turns: [{ role: 'user', text: jdText.slice(0, 3000) }],
        maxTokens: 60,
        onToken: () => {}
      });
      const clean = (raw || '').trim();
      if (clean && !clean.toUpperCase().includes('NONE')) {
        queries = clean.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).slice(0, 3);
      }
    } catch (err) {
      console.error('LLM JD analysis failed, using fallback regex:', err);
    }
  }

  // Fallback if LLM extraction returned nothing
  if (queries.length === 0) {
    const lines = jdText.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || '';
    if (firstLine.length < 80) queries.push(firstLine);
    const techMatches = jdText.match(/\b([A-Z][a-zA-Z0-9+.#]{2,}|AWS|GCP|Azure|Kubernetes|Docker|React|Python|Go|Node\.js|Kafka|Spark|PostgreSQL)\b/g);
    if (techMatches && techMatches.length) {
      const uniqueTech = Array.from(new Set(techMatches)).slice(0, 3);
      queries.push(uniqueTech.join(' '));
    }
  }

  queries = Array.from(new Set(queries)).slice(0, 3);
  if (queries.length === 0) return { queries: [], results: [] };

  const results = [];
  for (const q of queries) {
    onProgress({ stage: 'searching', query: q, message: `Searching web: ${q}…` });
    const res = await searchDuckDuckGoLite(q, settings);
    if (res) {
      results.push({ query: q, snippet: res });
    }
  }

  onProgress({ stage: 'done', queries, resultsCount: results.length, message: `Web research complete (${results.length} sources found).` });
  return { queries, results };
}

module.exports = {
  extractEntities,
  searchDuckDuckGoLite,
  researchJobDescription
};
