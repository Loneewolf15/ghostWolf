/**
 * interview-context-mobile.js — Builds the LLM system prompt context block.
 * Mirrors src/interview-context.js logic, browser-native (no Node.js).
 */

const BASE_RULES =
  'Always respond in clear, natural English. Never switch to Hindi or any other language unless explicitly asked. ' +
  'CRITICAL HUMANIZER & CLAUDE-LEVEL INTELLIGENCE RULES: ' +
  '1. Never use these words: pivotal, landscape, tapestry, delve, crucial, underscore, testament, vibrant, foster. ' +
  '2. Never use bullet points unless explicitly asked to list things. ' +
  '3. Do not use negative parallelisms. ' +
  '4. Vary sentence rhythm. Keep it conversational. Sound like a real person, not an AI. ' +
  '5. Do not use generic filler conclusions. ' +
  '6. INDEPENDENT DOMAIN ACCURACY: Deliver authoritative, direct answers. ' +
  'Never artificially shoehorn mentions of the target role or job description. ' +
  'Answer technical and conceptual questions on their own merits with first-principles precision.\n';

const TONE_MODES = {
  conversational: 'TONE: Conversational. Flow like a smart friend. Natural, not polished or rehearsed.',
  professional:   'TONE: Professional. Clean, concise, structured for a formal interview.',
  technical:      'TONE: Technical. Engineering accuracy, precise terminology, no pleasantries.',
};

window.GWContext = {
  /**
   * buildSystemPrompt(mode) → string
   * Returns the full system prompt for a given action mode.
   */
  buildSystemPrompt(mode = 'assist') {
    const s = GWStorage.load();
    const parts = [BASE_RULES];

    // Resume
    if (s.resume && s.resume.trim()) {
      parts.push(`=== CANDIDATE RESUME ===\n${s.resume.trim()}\nUse this as reference for experience and skills.`);
    }

    // Job Description
    if (s.jobDescription && s.jobDescription.trim()) {
      parts.push(`=== TARGET ROLE ===\n${s.jobDescription.trim()}\nUse this for domain alignment only. Do NOT shoehorn it into every answer.`);
    }

    // STAR stories (for behavioral/motivation modes)
    if (s.starStories && s.starStories.trim() && ['say', 'assist', 'followup'].includes(mode)) {
      parts.push(`=== STAR STORIES ===\n${s.starStories.trim()}`);
    }

    // Salary
    if (s.salaryTarget && mode === 'assist') {
      parts.push(`Salary target: ${s.salaryTarget}`);
    }

    // Tone
    const tone = TONE_MODES[s.responseMode] || TONE_MODES.conversational;
    parts.push(tone);

    // AI rules
    if (s.aiRules && s.aiRules.trim()) {
      parts.push(`=== RESPONSE RULES ===\n${s.aiRules.trim()}`);
    }

    return parts.join('\n\n');
  },

  /**
   * buildModePrompt(mode, transcript, userText) → { system, turns }
   * Returns the full prompt payload for GWLLM.stream().
   */
  buildModePrompt(mode, transcript = [], userText = '') {
    const recent = transcript.slice(-20);
    const formatted = recent.map(t => `${t.channel === 'them' ? 'Interviewer' : 'You'}: ${t.text}`).join('\n');
    const system = this.buildSystemPrompt(mode);

    let userContent;
    switch (mode) {
      case 'say':
        userContent = formatted
          ? `Based on this conversation, what should I say next?\n\n${formatted}`
          : 'What should I say to start the interview well?';
        break;
      case 'assist':
        userContent = userText
          ? `Context:\n${formatted}\n\nQuestion: ${userText}`
          : (formatted ? `Review this conversation and assist:\n\n${formatted}` : 'How can I introduce myself effectively?');
        break;
      case 'followup':
        userContent = formatted
          ? `Generate a thoughtful follow-up question based on:\n\n${formatted}`
          : 'What is a good follow-up question to ask the interviewer?';
        break;
      case 'recap':
        userContent = formatted
          ? `Recap the key points discussed:\n\n${formatted}`
          : 'Nothing has been discussed yet. Ask the user to start listening first.';
        break;
      default:
        userContent = userText || (formatted ? `Help with:\n\n${formatted}` : 'How can I help you?');
    }

    return {
      system,
      turns: [{ role: 'user', text: userContent }],
    };
  },
};
