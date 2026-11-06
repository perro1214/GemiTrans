/**
 * 翻訳キャッシュ（サイト別管理）
 * 同じテキスト+言語の翻訳結果をサイト（ホスト名）ごとにキャッシュして再利用する。
 *
 * ストレージキー: "cache:<host>" （例: "cache:cloud.vast.ai"）
 * 各サイトの容量上限: MAX_BYTES_PER_SITE（20 MiB、最終使用順に削除）
 */

const CACHE_PREFIX = 'cache:';
const LEGACY_CACHE_KEY = 'translationCache';
const MAX_BYTES_PER_SITE = 20 * 1024 * 1024;

/**
 * ホスト別サイトキャッシュの短寿命メモ化。
 *
 * 背景:
 *   translatePage は複数バッチを並列で handleTranslate に送り、
 *   それぞれが checkBatchCache を呼ぶため、同じサイトのキャッシュオブジェクト
 *   （最大 MAX_BYTES_PER_SITE = 20 * 1024 * 1024 件、MB クラスになり得る）を
 *   1 翻訳で何度も chrome.storage.local から読み直していた。
 *   これを短時間（SITE_CACHE_TTL_MS）メモ化して読み直しを集約する。
 *
 * 一貫性:
 *   storage.onChanged 監視で、対象キーが書き換わったらメモを破棄する。
 *   saveBatchToCache 側は保存後に memo を明示更新して以後の読み込みを最新化する。
 */
const SITE_CACHE_TTL_MS = 3000;
const siteCacheMemo = new Map(); // siteKey -> { data, at, inflight }

function getMemoEntry(sk) {
    return siteCacheMemo.get(sk) || null;
}

async function loadSiteCache(sk) {
    const now = Date.now();
    const memo = getMemoEntry(sk);
    if (memo) {
        if (memo.data && now - memo.at < SITE_CACHE_TTL_MS) {
            return memo.data;
        }
        if (memo.inflight) return memo.inflight;
    }
    const inflight = (async () => {
        try {
            const result = await chrome.storage.local.get(sk);
            const data = result[sk] || {};
            siteCacheMemo.set(sk, { data, at: Date.now(), inflight: null });
            return data;
        } catch (e) {
            siteCacheMemo.set(sk, { data: {}, at: Date.now(), inflight: null });
            return {};
        }
    })();
    siteCacheMemo.set(sk, { data: memo?.data || null, at: memo?.at || 0, inflight });
    return inflight;
}

function setSiteCacheMemo(sk, data) {
    siteCacheMemo.set(sk, { data, at: Date.now(), inflight: null });
}

function invalidateSiteCacheMemo(sk) {
    siteCacheMemo.delete(sk);
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        for (const key of Object.keys(changes)) {
            if (key.startsWith(CACHE_PREFIX)) {
                // 他所からの書き換えに追随（自分の saveBatchToCache 由来は後段で上書き反映される）
                invalidateSiteCacheMemo(key);
            }
        }
    });
}

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
function makeCacheKey(text, targetLang, scope = '') {
    let hash = 0;
    const str = JSON.stringify([text, targetLang, scope]);
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    const fingerprint = text.slice(0, 16) + '|' + text.slice(-16);
    // v3: 文脈情報のない旧キャッシュを再利用しない。
    return `v3:${hash}:${fingerprint}`;
}

/**
 * 容量が上限を超えたら最終使用が古いものを削除する
 */
// UTF-8 bytes of the serialized site object, including keys and separators.
function serializedBytes(value) { return new TextEncoder().encode(JSON.stringify(value)).length; }
function evictOldEntries(cache, max = MAX_BYTES_PER_SITE) {
    const entries = Object.entries(cache).map(([key, entry]) => ({
        key, used: entry.lastUsedAt || entry.timestamp || 0,
        bytes: serializedBytes(key) + 1 + serializedBytes(entry)
    }));
    let bytes = 2 + entries.reduce((n, x) => n + x.bytes, 0) + Math.max(0, entries.length - 1);
    let remaining = entries.length, evicted = 0;
    if (bytes > max) {
        entries.sort((a, b) => a.used - b.used);
        for (const entry of entries) {
            if (bytes <= max) break;
            delete cache[entry.key]; bytes -= entry.bytes + (remaining > 1 ? 1 : 0);
            remaining--; evicted++;
        }
    }
    return { bytes, evicted, count: remaining, maxBytes: max };
}

// Coalesce accesses, so repeated hits do not rewrite a large site object.
// Exact accesses are used for eviction; durable access timestamps are flushed
// at most once a minute per site, or together with the next saved translation.
const pendingAccess = new Map();
const accessFlushedAt = new Map();
const ACCESS_FLUSH_MS = 60000;
function noteAccess(sk, keys) {
    let accesses = pendingAccess.get(sk);
    if (!accesses) { accesses = new Map(); pendingAccess.set(sk, accesses); }
    for (const key of keys) accesses.set(key, Date.now());
}
function applyAccess(cache, accesses) {
    for (const [key, time] of accesses || []) {
        if (cache[key]) cache[key] = { ...cache[key], lastUsedAt: Math.max(cache[key].lastUsedAt || 0, time) };
    }
}
function finishAccess(sk, snapshot) {
    const current = pendingAccess.get(sk);
    for (const [key, time] of snapshot) if (current?.get(key) === time) current.delete(key);
    if (!current?.size) pendingAccess.delete(sk);
    accessFlushedAt.set(sk, Date.now());
}
async function flushAccess(sk) {
    if (!pendingAccess.get(sk)?.size || Date.now() - (accessFlushedAt.get(sk) || 0) < ACCESS_FLUSH_MS) return;
    return queueSiteWrite(sk, async () => {
        if (!pendingAccess.get(sk)?.size || Date.now() - (accessFlushedAt.get(sk) || 0) < ACCESS_FLUSH_MS) return;
        const result = await chrome.storage.local.get(sk);
        const cache = { ...(result[sk] || {}) };
        const snapshot = new Map(pendingAccess.get(sk));
        applyAccess(cache, snapshot);
        const stats = evictOldEntries(cache);
        await chrome.storage.local.set({ [sk]: cache });
        setSiteCacheMemo(sk, cache); finishAccess(sk, snapshot);
        return stats;
    });
}
export async function touchBatchCache(texts, targetLang, host, scopes = []) {
    const sk = siteKey(host);
    noteAccess(sk, texts.map((text, i) => makeCacheKey(text, targetLang, scopes[i] || '')));
    return flushAccess(sk);
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
        evictOldEntries(legacyCache, MAX_BYTES_PER_SITE);
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
export async function getFromCache(text, targetLang, host, scope = '') {
    const { cached } = await checkBatchCache([text], targetLang, host, [scope]);
    return cached.get(0) ?? null;
}

/**
 * キャッシュにテキストを保存する
 * @param {string} text - 原文
 * @param {string} targetLang - 翻訳先言語
 * @param {string} translated - 翻訳結果
 * @param {string} host - サイトのホスト名
 */
export async function saveToCache(text, targetLang, translated, host, scope = '') {
    return saveBatchToCache([text], targetLang, [translated], host, [scope]);
}

/**
 * 複数テキストのキャッシュヒットを確認する
 * @param {string[]} texts - テキスト配列
 * @param {string} targetLang - 翻訳先言語
 * @param {string} host - サイトのホスト名
 * @returns {Promise<{cached: Map<number, string>, uncached: number[]}>}
 */
export async function checkBatchCache(texts, targetLang, host, scopes = []) {
    await migrateIfNeeded();
    const cached = new Map();
    const uncached = [];

    try {
        const sk = siteKey(host);
        const cache = await loadSiteCache(sk);

        for (let i = 0; i < texts.length; i++) {
            const key = makeCacheKey(texts[i], targetLang, scopes[i] || '');
            const entry = cache[key];
            if (entry && entry.original === texts[i] && entry.lang === targetLang && entry.scope === (scopes[i] || '')) {
                if (typeof entry.translated !== 'string' || !entry.translated || entry.translated.includes('[SEP]') && !texts[i].includes('[SEP]')) {
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

    let touchError = null, touchEvicted = 0;
    if (cached.size) {
        const indices = [...cached.keys()];
        try { const stats = await touchBatchCache(indices.map(i => texts[i]), targetLang, host, indices.map(i => scopes[i] || '')); touchEvicted = stats?.evicted || 0; }
        catch (error) { touchError = error.message; }
    }
    return { cached, uncached, touchError, touchEvicted };
}

/**
 * 複数テキストをキャッシュに保存する
 * @param {string[]} texts - 原文配列
 * @param {string} targetLang - 翻訳先言語
 * @param {string[]} translations - 翻訳結果配列
 * @param {string} host - サイトのホスト名
 */
const siteWrites = new Map();
async function queueSiteWrite(sk, action) {
    const previous = siteWrites.get(sk) || Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    siteWrites.set(sk, task);
    try { return await task; }
    catch (error) { invalidateSiteCacheMemo(sk); throw error; }
    finally { if (siteWrites.get(sk) === task) siteWrites.delete(sk); }
}
export async function saveBatchToCache(texts, targetLang, translations, host, scopes = []) {
    const sk = siteKey(host);
    return queueSiteWrite(sk, async () => {
        const result = await chrome.storage.local.get(sk);
        const cache = { ...(result[sk] || {}) };
        const snapshot = new Map(pendingAccess.get(sk));
        applyAccess(cache, snapshot);
        const written = new Set();
        let skipped = 0;
        for (let i = 0; i < texts.length; i++) {
            if (typeof translations[i] !== 'string' || !translations[i]) continue;
            const scope = scopes[i] || '';
            const key = makeCacheKey(texts[i], targetLang, scope);
            const entry = { original: texts[i], lang: targetLang, scope,
                translated: translations[i], timestamp: Date.now(), lastUsedAt: Date.now() };
            // One oversized item must not evict the entire useful cache.
            if (serializedBytes({ [key]: entry }) > MAX_BYTES_PER_SITE) { skipped++; continue; }
            cache[key] = entry; written.add(key);
        }
        const stats = evictOldEntries(cache);
        await chrome.storage.local.set({ [sk]: cache });
        setSiteCacheMemo(sk, cache); finishAccess(sk, snapshot);
        return { ...stats, saved: [...written].filter(key => key in cache).length, skipped };
    });
}

/**
 * 全キャッシュをクリアする
 */
export async function clearCache() {
    const all = await chrome.storage.local.get(null);
    const keys = new Set([...Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX)), ...siteWrites.keys(), ...pendingAccess.keys()]);
    await Promise.all([...keys].map(sk => clearSiteCache(sk.slice(CACHE_PREFIX.length))));
    await chrome.storage.local.remove(LEGACY_CACHE_KEY);
}

export async function clearSiteCache(host) {
    const sk = siteKey(host);
    return queueSiteWrite(sk, async () => {
        await chrome.storage.local.remove(sk);
        invalidateSiteCacheMemo(sk); pendingAccess.delete(sk); accessFlushedAt.delete(sk);
    });
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
            const size = serializedBytes(value);
            sites.push({ host, count, size, maxBytes: MAX_BYTES_PER_SITE });
        }
        sites.sort((a, b) => b.count - a.count);
        return sites;
    } catch (e) {
        return [];
    }
}
