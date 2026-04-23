/**
 * LM Studio API クライアント（TranslateGemma 専用）
 * ローカルで動作する LM Studio サーバー経由で TranslateGemma モデルを叩く
 *
 * 設計方針（TranslateGemma の強みである "文脈を考慮した翻訳" を最大化する）:
 *   - 呼び出し元（content.js）から渡される 1 バッチ（= ユーザー設定「バッチ許容量」で
 *     区切られた単位）をそのまま 1 回の LM Studio リクエストに詰める
 *   - 内部で追加のチャンク分割はしない（= バッチ許容量の設定を尊重）
 *   - 番号付きリストとして送ることで周囲項目が文脈となる
 *   - ローカル推論は 1 モデル = 1 パイプラインなので並列化しても速くならない
 *     （直列の方がコンテキストスイッチが起きずスループットが高い）
 *
 * 失敗時フォールバック（Gemini 実装に合わせる）:
 *   1. パースに失敗した項目だけ直列で個別リトライ
 *   2. バッチリクエスト自体が失敗したら全件を直列で個別翻訳にフォールバック
 *   3. 個別翻訳で拒否応答が返ってきたら原文フォールバック
 */

export const DEFAULT_ENDPOINT = 'http://localhost:1234';
export const DEFAULT_MODEL = 'translategemma-4b-it';

// リトライ設定
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 300;          // ローカルサーバーなのでリトライ間隔を短縮
const RETRYABLE_STATUS_CODES = [429, 500, 503];
const REQUEST_TIMEOUT_MS = 30000;      // ローカル推論なので30秒で十分（詰まり検出を速く）

// 個別翻訳フォールバック時の並列数
// ローカル推論は 1 モデル = 1 パイプラインなので直列の方が文脈翻訳時のスループットが高い
const FALLBACK_CONCURRENCY = 1;

/**
 * UI で表示している翻訳先言語名を TranslateGemma が理解する
 * ISO 639-1 コードにマッピングする
 */
const UI_TARGET_LANG_TO_CODE = {
    '日本語': 'ja',
    'English': 'en',
    '中文': 'zh',
    '한국어': 'ko',
    'Français': 'fr',
    'Deutsch': 'de',
    'Español': 'es',
    'Português': 'pt',
    'Italiano': 'it',
    'Русский': 'ru'
};

/**
 * TranslateGemma が対応する主要言語の ISO コード -> 英語名
 */
const LANG_CODE_TO_NAME = {
    af: 'Afrikaans', am: 'Amharic', ar: 'Arabic', az: 'Azerbaijani',
    be: 'Belarusian', bg: 'Bulgarian', bn: 'Bengali', bs: 'Bosnian',
    ca: 'Catalan', cs: 'Czech', cy: 'Welsh', da: 'Danish',
    de: 'German', el: 'Greek', en: 'English', es: 'Spanish',
    et: 'Estonian', eu: 'Basque', fa: 'Persian', fi: 'Finnish',
    fr: 'French', ga: 'Irish', gl: 'Galician', gu: 'Gujarati',
    he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', ht: 'Haitian',
    hu: 'Hungarian', hy: 'Armenian', id: 'Indonesian', is: 'Icelandic',
    it: 'Italian', ja: 'Japanese', jv: 'Javanese', ka: 'Georgian',
    kk: 'Kazakh', km: 'Central Khmer', kn: 'Kannada', ko: 'Korean',
    ky: 'Kyrgyz', la: 'Latin', lo: 'Lao', lt: 'Lithuanian',
    lv: 'Latvian', mk: 'Macedonian', ml: 'Malayalam', mn: 'Mongolian',
    mr: 'Marathi', ms: 'Malay', my: 'Burmese', ne: 'Nepali',
    nl: 'Dutch', no: 'Norwegian', pa: 'Punjabi', pl: 'Polish',
    ps: 'Pashto', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian',
    si: 'Sinhala', sk: 'Slovak', sl: 'Slovenian', sq: 'Albanian',
    sr: 'Serbian', sv: 'Swedish', sw: 'Swahili', ta: 'Tamil',
    te: 'Telugu', th: 'Thai', tl: 'Tagalog', tr: 'Turkish',
    uk: 'Ukrainian', ur: 'Urdu', uz: 'Uzbek', vi: 'Vietnamese',
    xh: 'Xhosa', yi: 'Yiddish', yo: 'Yoruba', zh: 'Chinese',
    zu: 'Zulu'
};

/**
 * モデルが翻訳を拒否してきたかを判定するためのパターン
 */
const REFUSAL_PATTERNS = [
    /意味を持たないため/,
    /適切な翻訳を提供することができません/,
    /文脈が提供されれば/,
    /より正確な翻訳/,
    /申し訳(?:ありません|ございません)/,
    /翻訳することができません/,
    /cannot provide.*translation/i,
    /cannot.*accurately translate/i,
    /need.*more context/i,
    /without.*context/i
];

/**
 * UI 上の表示名または既に ISO コードとして渡された文字列を ISO コードに正規化する
 */
export function normalizeLangCode(langOrName) {
    if (!langOrName) return 'en';
    const trimmed = String(langOrName).trim();
    if (UI_TARGET_LANG_TO_CODE[trimmed]) return UI_TARGET_LANG_TO_CODE[trimmed];
    const lower = trimmed.toLowerCase();
    if (LANG_CODE_TO_NAME[lower]) return lower;
    const match = lower.match(/^([a-z]{2})(?:[-_][a-z]{2,4})?$/i);
    return match ? match[1] : 'en';
}

function langNameFromCode(code) {
    return LANG_CODE_TO_NAME[code] || code;
}

/**
 * ページ文脈を 1 行の短い注記にまとめる。
 * TranslateGemma は長い指示で崩れるため、タイトル/ドメインだけを 1 行で添える。
 */
function buildPageContextLine(pageContext) {
    if (!pageContext) return '';
    const title = (pageContext.title || '').trim();
    const hostname = (pageContext.hostname || '').trim();
    const parts = [];
    if (title) parts.push(`page "${title}"`);
    if (hostname) parts.push(`on ${hostname}`);
    return parts.length ? ` Context: ${parts.join(' ')}.` : '';
}

/**
 * 単一テキスト用プロンプト（TranslateGemma 公式フォーマット: 短い・モデルの性能が安定）
 * オプションで role とページ文脈を 1 行だけ足す。
 */
function buildSinglePrompt(text, sourceCode, targetCode, options = {}) {
    const sourceName = langNameFromCode(sourceCode);
    const targetName = langNameFromCode(targetCode);
    const ctx = buildPageContextLine(options.pageContext);
    const role = options.role ? ` The fragment is a (${options.role}); preserve its tone/length accordingly.` : '';
    return (
        `You are a professional ${sourceName} (${sourceCode}) to ${targetName} (${targetCode}) translator localizing web page text.${ctx}${role} ` +
        `Preserve tone, register, emphasis, punctuation, emoji, brand/product names, URLs, code, file paths, numbers and units. ` +
        `If the text consists solely of emoji, icons, or symbols (e.g. ☰ • › ← ▸ ✓ ★) with no translatable words, return it exactly as-is. ` +
        `Produce only the ${targetName} translation without any commentary.\n\n` +
        text
    );
}

/**
 * バッチ翻訳用プロンプト（Gemini と同じ番号付きフォーマット + role ヒント）
 * 周囲の項目が同じプロンプトに入ることで文脈が維持される。
 * TranslateGemma を考慮して指示文は短めに抑える。
 */
function buildBatchPrompt(texts, sourceCode, targetCode, options = {}) {
    const sourceName = langNameFromCode(sourceCode);
    const targetName = langNameFromCode(targetCode);
    const roles = Array.isArray(options.roles) ? options.roles : [];
    const ctx = buildPageContextLine(options.pageContext);
    const numbered = texts
        .map((t, i) => {
            const r = roles[i] ? String(roles[i]) : 'body';
            return `[${i + 1}] (${r}) ${String(t).replace(/\r?\n/g, ' ').trim()}`;
        })
        .join('\n');

    return (
        `You are a professional ${sourceName} (${sourceCode}) to ${targetName} (${targetCode}) translator localizing text fragments from a single web page.${ctx} ` +
        `Each item carries a role hint in parentheses (e.g. "(h1)", "(button)", "(body)"). Use it only to decide tone and length — headings stay headline-like, buttons/labels stay short and actionable, body stays natural prose. Do NOT echo the role hint. ` +
        `Items sharing the same "@group-N" suffix (e.g. "(option@group-1)") belong to the same UI widget (dropdown, menu, tabs). Translate them as a coherent set — use sibling items to disambiguate abbreviations. ` +
        `Preserve tone, register, emphasis, punctuation, emoji, brand/product names, URLs, code, file paths, numbers and units. ` +
        `If an item consists solely of emoji, icons, or symbols (e.g. ☰ • › ← ▸ ✓ ★) with no translatable words, return it exactly as-is. ` +
        `Translate each numbered item into ${targetName}. Output ONLY the translations in the same "[N] <translation>" format, one per line. ` +
        `Translate every item — never refuse or ask for context.\n\n` +
        `Items:\n${numbered}`
    );
}

function normalizeEndpoint(endpoint) {
    const ep = (endpoint || '').trim() || DEFAULT_ENDPOINT;
    return ep.replace(/\/+$/, '');
}

async function fetchWithRetry(url, options, maxRetries = MAX_RETRIES) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);

            if (response.ok) return response;

            if (RETRYABLE_STATUS_CODES.includes(response.status) && attempt < maxRetries) {
                await new Promise(r => setTimeout(r, RETRY_BASE_DELAY * Math.pow(2, attempt)));
                continue;
            }

            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData?.error?.message || errorData?.error || response.statusText;
            throw new Error(`LM Studio API Error (${response.status}): ${errorMessage}`);
        } catch (error) {
            clearTimeout(timeoutId);
            lastError = error;

            if ((error.name === 'TypeError' || error.name === 'AbortError') && attempt < maxRetries) {
                await new Promise(r => setTimeout(r, RETRY_BASE_DELAY * Math.pow(2, attempt)));
                continue;
            }

            if (error.name === 'AbortError') {
                throw new Error(`LM Studio API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
            }
            throw error;
        }
    }
    throw lastError;
}

/**
 * LM Studio の OpenAI 互換 Chat Completions エンドポイントを呼び出す
 */
async function callLMStudio(endpoint, model, prompt, onUsage, maxTokens) {
    const url = `${normalizeEndpoint(endpoint)}/v1/chat/completions`;
    const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: maxTokens,
            stream: false
        })
    });

    const data = await response.json();

    if (onUsage && data.usage) {
        onUsage({
            inputTokens: data.usage.prompt_tokens || 0,
            outputTokens: data.usage.completion_tokens || 0
        });
    }

    const content = data.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
        throw new Error('LM Studio から翻訳結果が返ってきませんでした');
    }
    return String(content);
}

function sanitizeTranslation(text) {
    if (!text) return text;
    let out = text.trim();
    // モデルが role ヒント "(h1) ..." を残した場合に備えて先頭だけ剥がす
    out = out.replace(/^\s*\(([\w-]{1,24})\)\s+/, '');
    if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('「') && out.endsWith('」'))) {
        out = out.slice(1, -1).trim();
    }
    return out;
}

function looksLikeRefusal(output) {
    if (!output) return true;
    const trimmed = output.trim();
    if (!trimmed) return true;
    for (const p of REFUSAL_PATTERNS) {
        if (p.test(trimmed)) return true;
    }
    return false;
}

/**
 * 番号付き応答を配列にパースする（Gemini 実装と同じロジック）
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

    for (const line of (responseText || '').split('\n')) {
        const match = line.match(/^\s*[\[【]\s*(\d+)\s*[\]】][\s:：.、]*(.*)$/);
        if (match) {
            flush();
            currentIdx = parseInt(match[1], 10) - 1;
            currentLines = [match[2] || ''];
        } else if (currentIdx >= 0) {
            currentLines.push(line);
        }
    }
    flush();

    // 拒否応答は null として扱う
    return results.map(v => (v == null || looksLikeRefusal(v)) ? null : sanitizeTranslation(v));
}

/**
 * 単一テキストの翻訳（内部用）
 * 拒否応答を検出した場合は null を返す
 * @param {{role?: string, pageContext?: object|null}} [promptOptions]
 */
async function translateSingleInternal(text, srcCode, tgtCode, endpoint, model, onUsage, promptOptions = {}) {
    if (!text || !text.trim()) return text;
    if (srcCode === tgtCode) return text;

    const prompt = buildSinglePrompt(text, srcCode, tgtCode, promptOptions);
    // 短い入力が多いので max_tokens はきつめに抑える（ローカル推論高速化）
    const maxTokens = Math.max(128, Math.min(2048, Math.ceil(text.length * 3) + 64));
    const raw = await callLMStudio(endpoint, model, prompt, onUsage, maxTokens);
    const cleaned = sanitizeTranslation(raw);
    if (looksLikeRefusal(cleaned)) return null;
    return cleaned;
}

/**
 * 単一テキストを翻訳する（公開 API）
 * 拒否された場合は原文を返す
 * @param {{role?: string, pageContext?: object|null}} [options]
 */
export async function translateText(text, targetLang, endpoint, model = DEFAULT_MODEL, onUsage = null, sourceLangCode = 'en', options = {}) {
    const srcCode = normalizeLangCode(sourceLangCode);
    const tgtCode = normalizeLangCode(targetLang);
    try {
        const out = await translateSingleInternal(text, srcCode, tgtCode, endpoint, model, onUsage, options);
        return out == null ? null : out;
    } catch {
        return null;
    }
}

/**
 * 並列個別翻訳（Gemini と同じく Promise.all で並列実行するが、
 * ローカル推論負荷が高いのでセマフォで上限を設ける）
 * 各インデックスごとに role を分けて渡す。
 */
async function parallelTranslate(indices, texts, srcCode, tgtCode, endpoint, model, onUsage, concurrency, perItemOptions = []) {
    const results = new Array(indices.length).fill(null);
    let cursor = 0;

    async function worker() {
        while (true) {
            const k = cursor++;
            if (k >= indices.length) return;
            const origIdx = indices[k];
            try {
                results[k] = await translateSingleInternal(
                    texts[origIdx], srcCode, tgtCode, endpoint, model, onUsage,
                    perItemOptions[origIdx] || {}
                );
            } catch {
                results[k] = null;
            }
        }
    }

    const n = Math.max(1, Math.min(concurrency, indices.length));
    await Promise.all(Array.from({ length: n }, worker));
    return results;
}

/**
 * 複数テキストを翻訳する
 *
 * 戦略（Gemini.translateBatch と同等）:
 *   - texts.length === 1 → 単一翻訳
 *   - それ以外 → 1 回の番号付きバッチ翻訳
 *     - パース欠落分のみ並列で個別リトライ
 *     - バッチ全体が失敗したら全件を並列で個別翻訳
 *   - 個別翻訳でも null（拒否 or エラー）になったものは原文フォールバック
 */
export async function translateBatch(
    texts,
    targetLang,
    endpoint,
    model = DEFAULT_MODEL,
    onUsage = null,
    sourceLangCode = 'en',
    options = {}
) {
    if (!texts || texts.length === 0) return [];

    const srcCode = normalizeLangCode(sourceLangCode);
    const tgtCode = normalizeLangCode(targetLang);
    if (srcCode === tgtCode) return texts.slice();

    const roles = Array.isArray(options.roles) ? options.roles : [];
    const pageContext = options.pageContext || null;
    // 個別フォールバック時に「どの原文がどの役割か」を維持するための配列
    const perItemOptions = texts.map((_, i) => ({ role: roles[i], pageContext }));

    if (texts.length === 1) {
        try {
            const r = await translateSingleInternal(
                texts[0], srcCode, tgtCode, endpoint, model, onUsage, perItemOptions[0]
            );
            return [r == null ? null : r];
        } catch {
            return [null];
        }
    }

    // 1 回の番号付きバッチリクエスト
    try {
        const prompt = buildBatchPrompt(texts, srcCode, tgtCode, { roles, pageContext });
        const totalChars = texts.reduce((n, t) => n + (t || '').length, 0);
        // 出力トークンは入力の概ね 3 倍 + 番号マーカー分を確保（翻訳用途なら4096で十分）
        const maxTokens = Math.max(512, Math.min(4096, Math.ceil(totalChars * 3) + 128));

        const raw = await callLMStudio(endpoint, model, prompt, onUsage, maxTokens);
        const parsed = parseBatchResponse(raw, texts.length);

        const missIndices = [];
        for (let i = 0; i < parsed.length; i++) {
            if (parsed[i] === null) missIndices.push(i);
        }

        if (missIndices.length === 0) return parsed;

        // 欠落分だけ並列で個別リトライ
        const missResults = await parallelTranslate(
            missIndices, texts, srcCode, tgtCode, endpoint, model, onUsage, FALLBACK_CONCURRENCY, perItemOptions
        );
        for (let j = 0; j < missIndices.length; j++) {
            const v = missResults[j];
            parsed[missIndices[j]] = (v == null) ? null : v;
        }
        return parsed;

    } catch {
        // バッチリクエスト自体が失敗 → 全件を並列で個別翻訳
        const indices = texts.map((_, i) => i);
        const individualResults = await parallelTranslate(
            indices, texts, srcCode, tgtCode, endpoint, model, onUsage, FALLBACK_CONCURRENCY, perItemOptions
        );
        return individualResults.map((v, i) => (v == null ? null : v));
    }
}

/**
 * 接続テスト: モデルがロードされていて簡易翻訳に応答するか確認する
 */
export async function testApiKey(endpoint, model = DEFAULT_MODEL) {
    const url = `${normalizeEndpoint(endpoint)}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
        });
        if (!response.ok) {
            throw new Error(`LM Studio に接続できません (HTTP ${response.status})`);
        }
        const data = await response.json();
        const ids = (data.data || []).map(m => m.id);
        if (model && !ids.includes(model)) {
            throw new Error(`モデル "${model}" が LM Studio にロードされていません。利用可能: ${ids.join(', ') || 'なし'}`);
        }
        return true;
    } catch (e) {
        if (e.name === 'TypeError') {
            throw new Error(`LM Studio サーバーに接続できません (${normalizeEndpoint(endpoint)})。"lms server start" でサーバーを起動してください。`);
        }
        throw e;
    }
}

/**
 * LM Studio からロード済みモデル一覧を取得する
 */
export async function listModels(endpoint) {
    const url = `${normalizeEndpoint(endpoint)}/v1/models`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data.data || []).map(m => m.id);
}
