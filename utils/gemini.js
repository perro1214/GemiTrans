/**
 * Gemini API クライアント
 * テキスト翻訳のためのAPI通信を担当
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.0-flash';

// リトライ設定
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000; // 1秒
const RETRYABLE_STATUS_CODES = [429, 500, 503];

// バッチ設定
const MAX_BATCH_CHARS = 3000; // バッチあたり最大文字数

/**
 * 指数バックオフ付きリトライでfetchを実行する
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} maxRetries
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, maxRetries = MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.ok) {
        return response;
      }

      // リトライ可能なステータスコードかチェック
      if (RETRYABLE_STATUS_CODES.includes(response.status) && attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // リトライ不可のエラー
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData?.error?.message || response.statusText;
      throw new Error(`Gemini API Error (${response.status}): ${errorMessage}`);
    } catch (error) {
      lastError = error;

      // ネットワークエラーの場合もリトライ
      if (error.name === 'TypeError' && attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

/**
 * Gemini APIを使用してテキストを翻訳する
 * @param {string} text - 翻訳するテキスト
 * @param {string} targetLang - 翻訳先の言語
 * @param {string} apiKey - Gemini API キー
 * @param {string} [model] - 使用するモデル名
 * @returns {Promise<string>} 翻訳されたテキスト
 */
export async function translateText(text, targetLang, apiKey, model = DEFAULT_MODEL, onUsage = null) {
  if (!text || !text.trim()) {
    return text;
  }

  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  const prompt = buildTranslationPrompt(text, targetLang);

  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      maxOutputTokens: 8192
    }
  };

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();

  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('Gemini APIから応答がありませんでした');
  }

  const translatedText = data.candidates[0]?.content?.parts?.[0]?.text;

  if (!translatedText) {
    throw new Error('翻訳結果の取得に失敗しました');
  }

  if (onUsage && data.usageMetadata) {
    onUsage({
      inputTokens: data.usageMetadata.promptTokenCount || 0,
      outputTokens: data.usageMetadata.candidatesTokenCount || 0
    });
  }

  return translatedText.trim();
}

/**
 * 翻訳用のプロンプトを構築する
 * @param {string} text - 翻訳するテキスト
 * @param {string} targetLang - 翻訳先の言語
 * @returns {string} プロンプト文字列
 */
function buildTranslationPrompt(text, targetLang) {
  return `You are a professional translator. Translate the following text to ${targetLang}.

Rules:
- Translate ONLY the text content.
- Do NOT add any explanations, notes, or metadata.
- Do NOT wrap the translation in quotes or code blocks.
- Maintain the original tone and style.
- If the text is already in the target language, return it as-is.
- Translate naturally and fluently, not word-by-word.

Text to translate:
${text}`;
}

/**
 * バッチ翻訳用プロンプトを構築する（番号付きフォーマット）
 * [SEP] 方式より番号付きの方がGeminiが構造を崩しにくい
 */
function buildBatchPrompt(texts, targetLang) {
  const numbered = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');
  return `You are a professional translator. Translate each numbered item to ${targetLang}.

Rules:
- Output ONLY the translations in the same numbered format: [1] ..., [2] ..., etc.
- One item per line. Do NOT add explanations, blank lines between items, or extra text.
- If an item is already in ${targetLang}, return it as-is.
- Translate naturally and fluently, not word-by-word.
- Preserve inline code, URLs, file paths, and technical terms exactly as they are.

Items:
${numbered}`;
}

/**
 * 番号付きフォーマットのレスポンスをパースする
 * 複数行にまたがる翻訳も正しく収集する
 * @param {string} responseText
 * @param {number} expectedCount
 * @returns {Array<string|null>} パース結果（取得できなかった項目はnull）
 */
function parseBatchResponse(responseText, expectedCount) {
  const results = new Array(expectedCount).fill(null);
  let currentIdx = -1;
  let currentLines = [];

  function flush() {
    if (currentIdx >= 0 && currentIdx < expectedCount) {
      const value = currentLines.join('\n').trim();
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

/**
 * テキストの配列を文字数ベースで動的にバッチ分割する
 * @param {string[]} texts - テキストの配列
 * @param {number} maxChars - バッチあたりの最大文字数
 * @returns {string[][]} バッチに分割されたテキスト配列
 */
export function splitIntoBatches(texts, maxChars = MAX_BATCH_CHARS) {
  const batches = [];
  let currentBatch = [];
  let currentLength = 0;

  for (const text of texts) {
    const textLength = text.length + 7; // [SEP] の長さを加算

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

/**
 * テキストの配列をバッチで翻訳する
 * 番号付きフォーマットで一括送信し、パースできなかった項目のみ並列で個別翻訳する
 * @param {string[]} texts - 翻訳するテキストの配列
 * @param {string} targetLang - 翻訳先の言語
 * @param {string} apiKey - Gemini API キー
 * @param {string} [model] - 使用するモデル名
 * @returns {Promise<string[]>} 翻訳されたテキストの配列
 */
export async function translateBatch(texts, targetLang, apiKey, model = DEFAULT_MODEL, onUsage = null) {
  if (!texts || texts.length === 0) return [];

  // 1件のみの場合は通常翻訳
  if (texts.length === 1) {
    try {
      return [await translateText(texts[0], targetLang, apiKey, model, onUsage)];
    } catch (e) {
      return [texts[0]];
    }
  }

  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  try {
    // 番号付きフォーマットでバッチリクエスト
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildBatchPrompt(texts, targetLang) }] }],
        generationConfig: { temperature: 0.1, topP: 0.95, maxOutputTokens: 8192 }
      })
    });

    const data = await response.json();

    if (onUsage && data.usageMetadata) {
      onUsage({
        inputTokens: data.usageMetadata.promptTokenCount || 0,
        outputTokens: data.usageMetadata.candidatesTokenCount || 0
      });
    }

    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseBatchResponse(responseText, texts.length);

    // パースできなかった項目だけ並列で個別翻訳（直列フォールバックを廃止）
    const missIndices = parsed.reduce((acc, r, i) => {
      if (r === null) acc.push(i);
      return acc;
    }, []);

    if (missIndices.length === 0) return parsed;

    const missResults = await Promise.all(
      missIndices.map(async i => {
        try { return await translateText(texts[i], targetLang, apiKey, model, onUsage); }
        catch (e) { return texts[i]; }
      })
    );
    missIndices.forEach((origIdx, j) => { parsed[origIdx] = missResults[j]; });
    return parsed;

  } catch (e) {
    // バッチリクエスト自体が失敗した場合も並列で個別翻訳
    return Promise.all(texts.map(async text => {
      try { return await translateText(text, targetLang, apiKey, model, onUsage); }
      catch (e) { return text; }
    }));
  }
}

/**
 * APIキーの有効性をテストする
 * @param {string} apiKey - テストするAPIキー
 * @param {string} [model] - 使用するモデル名
 * @returns {Promise<boolean>} 有効な場合true
 */
export async function testApiKey(apiKey, model) {
  try {
    const result = await translateText('Hello', '日本語', apiKey, model || DEFAULT_MODEL);
    return !!result;
  } catch (e) {
    throw e;
  }
}
