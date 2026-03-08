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
export async function translateText(text, targetLang, apiKey, model = DEFAULT_MODEL) {
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
- Translate ONLY the text content, preserving any formatting markers like [SEP] exactly as they are.
- Do NOT add any explanations, notes, or metadata.
- Do NOT wrap the translation in quotes or code blocks.
- Maintain the original tone and style.
- If the text is already in the target language, return it as-is.
- Translate naturally and fluently, not word-by-word.

Text to translate:
${text}`;
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
 * 複数のテキストを [SEP] で区切って一度に翻訳する
 * @param {string[]} texts - 翻訳するテキストの配列
 * @param {string} targetLang - 翻訳先の言語
 * @param {string} apiKey - Gemini API キー
 * @param {string} [model] - 使用するモデル名
 * @returns {Promise<string[]>} 翻訳されたテキストの配列
 */
export async function translateBatch(texts, targetLang, apiKey, model = DEFAULT_MODEL) {
  if (!texts || texts.length === 0) return [];

  // 短いテキストはまとめて翻訳する
  const separator = ' [SEP] ';
  const combined = texts.join(separator);

  const translated = await translateText(combined, targetLang, apiKey, model);

  // セパレータで分割して結果を返す
  const results = translated.split('[SEP]').map(t => t.trim());

  // 結果の数が入力と異なる場合は個別に翻訳する
  if (results.length !== texts.length) {
    const individualResults = [];
    for (const text of texts) {
      try {
        const result = await translateText(text, targetLang, apiKey, model);
        individualResults.push(result);
      } catch (e) {
        individualResults.push(text); // 失敗時は原文を返す
      }
    }
    return individualResults;
  }

  return results;
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
