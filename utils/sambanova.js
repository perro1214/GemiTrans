/**
 * SambaNova API クライアント
 * OpenAI互換APIで各種モデルを呼び出す
 */

const SAMBANOVA_API_BASE = 'https://api.sambanova.ai/v1/chat/completions';
export const DEFAULT_MODEL = 'DeepSeek-V3.1';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const RETRYABLE_STATUS_CODES = [429, 500, 503];
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BATCH_CHARS = 3000;

async function fetchWithRetry(url, options, maxRetries = MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return response;
      }

      if (RETRYABLE_STATUS_CODES.includes(response.status) && attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData?.error?.message || errorData?.message || response.statusText;
      throw new Error(`SambaNova API Error (${response.status}): ${errorMessage}`);
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;

      if ((error.name === 'TypeError' || error.name === 'AbortError') && attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (error.name === 'AbortError') {
        throw new Error(`SambaNova API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }

      throw error;
    }
  }

  throw lastError;
}

async function callSambaNova(apiKey, model, prompt, onUsage = null) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 8192
  };

  const response = await fetchWithRetry(SAMBANOVA_API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (onUsage && data.usage) {
    onUsage({
      inputTokens: data.usage.prompt_tokens || 0,
      outputTokens: data.usage.completion_tokens || 0
    });
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('SambaNova APIから応答がありませんでした');
  }

  return content;
}

function buildContextBlock(pageContext) {
  if (!pageContext) return '';
  const title = (pageContext.title || '').trim();
  const hostname = (pageContext.hostname || '').trim();
  const pageLang = (pageContext.pageLang || '').trim();
  const lines = [];
  if (title) lines.push(`- Page title: ${title}`);
  if (hostname) lines.push(`- Domain: ${hostname}`);
  if (pageLang) lines.push(`- Source html lang attribute: ${pageLang}`);
  if (lines.length === 0) return '';
  return `\nPage context (metadata only — use to decide tone and terminology, never translate or quote this block):\n${lines.join('\n')}\n`;
}

function stripLeadingRoleParen(s) {
  if (!s) return s;
  return s.replace(/^\s*\(([\w-]{1,24})\)\s+/, '');
}

function buildTranslationPrompt(text, targetLang, options = {}) {
  const contextBlock = buildContextBlock(options.pageContext);
  const role = options.role ? String(options.role) : '';
  const roleBlock = role
    ? `\nRole hint for this fragment: ${role}. Use it only to pick tone/length (e.g. headings stay headline-like, buttons/labels stay short and actionable). Never mention the role hint in your output.\n`
    : '';

  return `You are a professional translator localizing a live web page into ${targetLang}.
Translate the fragment below so it reads naturally to a native ${targetLang} speaker while faithfully preserving the author's intent, voice, and register.
${contextBlock}${roleBlock}
Preserve:
- Voice and register (formal/casual, polite/plain, marketing/technical/conversational).
- Emphasis cues (ALL CAPS, !, ?, "…", em-dashes, quotation styles).
- Emoji, symbols, bullets, and surrounding punctuation — exactly.
- Proper nouns, brand/product/people names, code identifiers, URLs, file paths, version numbers, hashtags, @mentions — do not translate or transliterate unless an established local form exists.
- Numbers, units, dates, currency — keep values; adapt format only when standard in ${targetLang}.

Style:
- Render idioms and metaphors with the closest natural equivalent, not literally.
- For headings stay headline-like; for buttons/labels keep it short and actionable.
- If the text is already in ${targetLang}, or is purely symbolic/numeric/untranslatable, return it unchanged.
- If the text consists solely of emoji, icons, or symbols (e.g. ☰ • › ← ▸ ✓ ★) with no translatable words, return it exactly as-is.

Output rules:
- Output ONLY the translation. No quotes, no code fences, no explanations, no role hint, no notes.

Text:
${text}`;
}

function buildBatchPrompt(texts, targetLang, options = {}) {
  const contextBlock = buildContextBlock(options.pageContext);
  const roles = Array.isArray(options.roles) ? options.roles : [];
  const numbered = texts
    .map((t, i) => {
      const r = roles[i] ? String(roles[i]) : 'body';
      return `[${i + 1}] (${r}) ${t}`;
    })
    .join('\n');

  return `You are a professional translator localizing a live web page into ${targetLang}.
The numbered items below are independent text fragments from the SAME page (headings, body text, buttons, menus, captions, etc.). Use the surrounding items as context to pick the right tone and terminology, but translate each item on its own line.
${contextBlock}
Each item is prefixed with a role hint in parentheses (e.g. "(h1)", "(button)", "(body)", "(link)", "(caption)"). Use the hint to decide tone and length — headings stay headline-like, buttons/labels stay short and actionable, body stays natural prose — but DO NOT echo the role hint in your output.

Items sharing the same "@group-N" suffix (e.g. "(option@group-1)") belong to the same UI component (dropdown, menu, tab bar, etc.). Translate them as a coherent set — use sibling items to disambiguate abbreviations and pick consistent terminology. For example if you see "Auto Sort", "Price (inc.)", "Price (dec.)" in the same group, recognize "inc./dec." as increasing/decreasing (ascending/descending), not "including" or "December".

Preserve for every item:
- Voice and register (formal/casual, polite/plain, marketing/technical/conversational), kept CONSISTENT across items from the same page.
- Emphasis cues (ALL CAPS, !, ?, "…", em-dashes), emoji, symbols, bullets, and punctuation style.
- Proper nouns, brand/product/people names, code identifiers, URLs, file paths, version numbers, hashtags, @mentions — keep as-is unless an established local form exists.
- Numbers, units, dates, currency — keep values; adapt format only when standard in ${targetLang}.
- Approximate length: short labels stay short; headings stay headline-like; body stays natural prose.

Other rules:
- Prefer the closest natural equivalent over literal word-by-word translation.
- If an item is already in ${targetLang}, or is purely symbolic/numeric, return it unchanged.
- If an item consists solely of emoji, icons, or symbols (e.g. ☰ • › ← ▸ ✓ ★) with no translatable words, return it exactly as-is.
- Translate every item — never refuse, never ask for context, never merge or split items.

Output format (strict):
- Exactly one line per item in the same numbered format: "[N] <translation>".
- Do NOT repeat the "(role)" hint.
- No blank lines, no headers, no commentary, no code fences.

Items:
${numbered}`;
}

function parseBatchResponse(responseText, expectedCount) {
  const results = new Array(expectedCount).fill(null);
  let currentIdx = -1;
  let currentLines = [];

  function flush() {
    if (currentIdx >= 0 && currentIdx < expectedCount) {
      const value = stripLeadingRoleParen(currentLines.join('\n').trim());
      results[currentIdx] = value || null;
    }
  }

  for (const line of responseText.split('\n')) {
    const match = line.match(/^\[(\d+)\]\s*(.*)/);
    if (match) {
      flush();
      currentIdx = parseInt(match[1], 10) - 1;
      currentLines = [match[2]];
    } else if (currentIdx >= 0) {
      currentLines.push(line);
    }
  }
  flush();

  return results;
}

export async function translateText(text, targetLang, apiKey, model = DEFAULT_MODEL, onUsage = null, options = {}) {
  if (!text || !text.trim()) {
    return text;
  }

  const prompt = buildTranslationPrompt(text, targetLang, options);
  const result = await callSambaNova(apiKey, model, prompt, onUsage);
  return stripLeadingRoleParen(result.trim());
}

export function splitIntoBatches(texts, maxChars = MAX_BATCH_CHARS) {
  const batches = [];
  let currentBatch = [];
  let currentLength = 0;

  for (const text of texts) {
    const textLength = text.length + 7;

    if (currentBatch.length > 0 && currentLength + textLength > maxChars) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLength = 0;
    }

    currentBatch.push(text);
    currentLength += textLength;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

export async function translateBatch(texts, targetLang, apiKey, model = DEFAULT_MODEL, onUsage = null, options = {}) {
  if (!texts || texts.length === 0) return [];

  const roles = Array.isArray(options.roles) ? options.roles : [];
  const pageContext = options.pageContext || null;

  if (texts.length === 1) {
    try {
      return [await translateText(texts[0], targetLang, apiKey, model, onUsage, {
        role: roles[0], pageContext
      })];
    } catch (e) {
      return [null];
    }
  }

  try {
    const prompt = buildBatchPrompt(texts, targetLang, { roles, pageContext });
    const responseText = await callSambaNova(apiKey, model, prompt, onUsage);
    const parsed = parseBatchResponse(responseText, texts.length);

    const missIndices = parsed.reduce((acc, r, i) => {
      if (r === null) acc.push(i);
      return acc;
    }, []);

    if (missIndices.length === 0) return parsed;

    const missResults = await Promise.all(
      missIndices.map(async i => {
        try {
          return await translateText(texts[i], targetLang, apiKey, model, onUsage, {
            role: roles[i], pageContext
          });
        } catch (e) {
          return null;
        }
      })
    );
    missIndices.forEach((origIdx, j) => { parsed[origIdx] = missResults[j]; });
    return parsed;

  } catch (e) {
    return Promise.all(texts.map(async (text, i) => {
      try {
        return await translateText(text, targetLang, apiKey, model, onUsage, {
          role: roles[i], pageContext
        });
      } catch (err) {
        return null;
      }
    }));
  }
}

export async function testApiKey(apiKey, model) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.sambanova.ai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = errorData?.error?.message || errorData?.message || response.statusText;
      throw new Error(`SambaNova API Error (${response.status}): ${message}`);
    }

    const data = await response.json();
    const models = data.data || [];
    if (model && models.length > 0 && !models.some(m => m.id === model)) {
      throw new Error(`SambaNova API Error (400): Model not available: ${model}`);
    }
    return models.length > 0 || response.ok;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('SambaNova API request timed out');
    }
    throw error;
  }
}
