/**
 * 翻訳キャッシュ
 * 同じテキスト+言語の翻訳結果をキャッシュして再利用する
 */

const CACHE_KEY = 'translationCache';
const MAX_CACHE_ENTRIES = 1000;

/**
 * キャッシュキーを生成する
 * @param {string} text - 原文
 * @param {string} targetLang - 翻訳先言語
 * @returns {string}
 */
function makeCacheKey(text, targetLang) {
    // 簡易ハッシュ（衝突はあるが高速）
    let hash = 0;
    const str = text + '|' + targetLang;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return String(hash);
}

/**
 * キャッシュからテキストを取得する
 * @param {string} text - 原文
 * @param {string} targetLang - 翻訳先言語
 * @returns {Promise<string|null>}
 */
export async function getFromCache(text, targetLang) {
    try {
        const result = await chrome.storage.local.get(CACHE_KEY);
        const cache = result[CACHE_KEY] || {};
        const key = makeCacheKey(text, targetLang);
        const entry = cache[key];

        if (entry && entry.original === text && entry.lang === targetLang) {
            return entry.translated;
        }
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * キャッシュにテキストを保存する
 * @param {string} text - 原文
 * @param {string} targetLang - 翻訳先言語
 * @param {string} translated - 翻訳結果
 */
export async function saveToCache(text, targetLang, translated) {
    try {
        const result = await chrome.storage.local.get(CACHE_KEY);
        const cache = result[CACHE_KEY] || {};
        const key = makeCacheKey(text, targetLang);

        cache[key] = {
            original: text,
            lang: targetLang,
            translated,
            timestamp: Date.now()
        };

        // エントリ数が上限を超えたら古いものを削除
        const entries = Object.entries(cache);
        if (entries.length > MAX_CACHE_ENTRIES) {
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toRemove = entries.slice(0, entries.length - MAX_CACHE_ENTRIES);
            for (const [removeKey] of toRemove) {
                delete cache[removeKey];
            }
        }

        await chrome.storage.local.set({ [CACHE_KEY]: cache });
    } catch (e) {
        // キャッシュ保存に失敗しても無視
    }
}

/**
 * 複数テキストのキャッシュヒットを確認する
 * @param {string[]} texts - テキスト配列
 * @param {string} targetLang - 翻訳先言語
 * @returns {Promise<{cached: Map<number, string>, uncached: number[]}>}
 */
export async function checkBatchCache(texts, targetLang) {
    const cached = new Map();
    const uncached = [];

    try {
        const result = await chrome.storage.local.get(CACHE_KEY);
        const cache = result[CACHE_KEY] || {};

        for (let i = 0; i < texts.length; i++) {
            const key = makeCacheKey(texts[i], targetLang);
            const entry = cache[key];
            if (entry && entry.original === texts[i] && entry.lang === targetLang) {
                // 旧 [SEP] バッチ形式の汚染エントリを自動無効化
                if (entry.translated.includes('[SEP]') && !texts[i].includes('[SEP]')) {
                    uncached.push(i);
                } else {
                    cached.set(i, entry.translated);
                }
            } else {
                uncached.push(i);
            }
        }
    } catch (e) {
        // エラー時は全てキャッシュミスとして扱う
        for (let i = 0; i < texts.length; i++) {
            uncached.push(i);
        }
    }

    return { cached, uncached };
}

/**
 * 複数テキストをキャッシュに保存する
 * @param {string[]} texts - 原文配列
 * @param {string} targetLang - 翻訳先言語
 * @param {string[]} translations - 翻訳結果配列
 */
export async function saveBatchToCache(texts, targetLang, translations) {
    try {
        const result = await chrome.storage.local.get(CACHE_KEY);
        const cache = result[CACHE_KEY] || {};

        for (let i = 0; i < texts.length; i++) {
            if (translations[i]) {
                const key = makeCacheKey(texts[i], targetLang);
                cache[key] = {
                    original: texts[i],
                    lang: targetLang,
                    translated: translations[i],
                    timestamp: Date.now()
                };
            }
        }

        const entries = Object.entries(cache);
        if (entries.length > MAX_CACHE_ENTRIES) {
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toRemove = entries.slice(0, entries.length - MAX_CACHE_ENTRIES);
            for (const [removeKey] of toRemove) {
                delete cache[removeKey];
            }
        }

        await chrome.storage.local.set({ [CACHE_KEY]: cache });
    } catch (e) {
        // ignored
    }
}

/**
 * キャッシュをクリアする
 */
export async function clearCache() {
    await chrome.storage.local.set({ [CACHE_KEY]: {} });
}
