/**
 * 翻訳キャッシュ（サイト別管理）
 * 同じテキスト+言語の翻訳結果をサイト（ホスト名）ごとにキャッシュして再利用する。
 *
 * ストレージキー: "cache:<host>" （例: "cache:cloud.vast.ai"）
 * 各サイトのエントリ上限: MAX_ENTRIES_PER_SITE
 */

const CACHE_PREFIX = 'cache:';
const LEGACY_CACHE_KEY = 'translationCache';
const MAX_ENTRIES_PER_SITE = 2000;

/**
 * ホスト名からストレージキーを生成する
 */
function siteKey(host) {
    return `${CACHE_PREFIX}${(host || '_unknown').toLowerCase()}`;
}

/**
 * エントリキーを生成する（ハッシュ + フィンガープリント）
 * @param {string} text - 原文
 * @param {string} targetLang - 翻訳先言語
 * @returns {string}
 */
function makeCacheKey(text, targetLang) {
    let hash = 0;
    const str = text + '|' + targetLang;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    const fingerprint = text.slice(0, 16) + '|' + text.slice(-16);
    return `${hash}:${fingerprint}`;
}

/**
 * エントリ数が上限を超えたら古いものを削除する
 */
function evictOldEntries(cache, max) {
    const entries = Object.entries(cache);
    if (entries.length <= max) return;
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.slice(0, entries.length - max);
    for (const [removeKey] of toRemove) {
        delete cache[removeKey];
    }
}

// ────────────────── 旧キャッシュからのマイグレーション ──────────────────

let migrationDone = false;

/**
 * 旧形式（単一キー "translationCache"）のデータをサイト別に分配して削除する。
 * ホスト情報が無い旧エントリは "_legacy" サイトに格納する。
 * 初回呼び出し時に1回だけ実行される。
 */
async function migrateIfNeeded() {
    if (migrationDone) return;
    migrationDone = true;
    try {
        const result = await chrome.storage.local.get(LEGACY_CACHE_KEY);
        const old = result[LEGACY_CACHE_KEY];
        if (!old || typeof old !== 'object' || Object.keys(old).length === 0) return;

        // 旧エントリは全て _legacy サイトへ
        const legacyKey = siteKey('_legacy');
        const legacyResult = await chrome.storage.local.get(legacyKey);
        const legacyCache = legacyResult[legacyKey] || {};
        Object.assign(legacyCache, old);
        evictOldEntries(legacyCache, MAX_ENTRIES_PER_SITE);
        await chrome.storage.local.set({ [legacyKey]: legacyCache });
        await chrome.storage.local.remove(LEGACY_CACHE_KEY);
    } catch (e) {
        // マイグレーション失敗は無視
    }
}

// ────────────────── 公開 API ──────────────────

/**
 * キャッシュからテキストを取得する
 * @param {string} text - 原文
 * @param {string} targetLang - 翻訳先言語
 * @param {string} host - サイトのホスト名
 * @returns {Promise<string|null>}
 */
export async function getFromCache(text, targetLang, host) {
    await migrateIfNeeded();
    try {
        const sk = siteKey(host);
        const result = await chrome.storage.local.get(sk);
        const cache = result[sk] || {};
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
 * @param {string} host - サイトのホスト名
 */
export async function saveToCache(text, targetLang, translated, host) {
    try {
        const sk = siteKey(host);
        const result = await chrome.storage.local.get(sk);
        const cache = result[sk] || {};
        const key = makeCacheKey(text, targetLang);

        cache[key] = {
            original: text,
            lang: targetLang,
            translated,
            timestamp: Date.now()
        };

        evictOldEntries(cache, MAX_ENTRIES_PER_SITE);
        await chrome.storage.local.set({ [sk]: cache });
    } catch (e) {
        // キャッシュ保存に失敗しても無視
    }
}

/**
 * 複数テキストのキャッシュヒットを確認する
 * @param {string[]} texts - テキスト配列
 * @param {string} targetLang - 翻訳先言語
 * @param {string} host - サイトのホスト名
 * @returns {Promise<{cached: Map<number, string>, uncached: number[]}>}
 */
export async function checkBatchCache(texts, targetLang, host) {
    await migrateIfNeeded();
    const cached = new Map();
    const uncached = [];

    try {
        const sk = siteKey(host);
        const result = await chrome.storage.local.get(sk);
        const cache = result[sk] || {};

        for (let i = 0; i < texts.length; i++) {
            const key = makeCacheKey(texts[i], targetLang);
            const entry = cache[key];
            if (entry && entry.original === texts[i] && entry.lang === targetLang) {
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
 * @param {string} host - サイトのホスト名
 */
export async function saveBatchToCache(texts, targetLang, translations, host) {
    try {
        const sk = siteKey(host);
        const result = await chrome.storage.local.get(sk);
        const cache = result[sk] || {};

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

        evictOldEntries(cache, MAX_ENTRIES_PER_SITE);
        await chrome.storage.local.set({ [sk]: cache });
    } catch (e) {
        // ignored
    }
}

/**
 * 全キャッシュをクリアする
 */
export async function clearCache() {
    try {
        const all = await chrome.storage.local.get(null);
        const cacheKeys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
        if (cacheKeys.length > 0) {
            await chrome.storage.local.remove(cacheKeys);
        }
        // 旧形式も念のため削除
        await chrome.storage.local.remove(LEGACY_CACHE_KEY);
    } catch (e) {
        // ignored
    }
}

/**
 * 特定サイトのキャッシュをクリアする
 * @param {string} host - サイトのホスト名
 */
export async function clearSiteCache(host) {
    try {
        await chrome.storage.local.remove(siteKey(host));
    } catch (e) {
        // ignored
    }
}

/**
 * キャッシュされているサイト一覧とエントリ数を取得する
 * @returns {Promise<Array<{host: string, count: number, size: number}>>}
 */
export async function getCacheSiteList() {
    try {
        const all = await chrome.storage.local.get(null);
        const sites = [];
        for (const [key, value] of Object.entries(all)) {
            if (!key.startsWith(CACHE_PREFIX)) continue;
            const host = key.slice(CACHE_PREFIX.length);
            const count = typeof value === 'object' ? Object.keys(value).length : 0;
            const size = JSON.stringify(value).length;
            sites.push({ host, count, size });
        }
        sites.sort((a, b) => b.count - a.count);
        return sites;
    } catch (e) {
        return [];
    }
}
