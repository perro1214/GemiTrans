/**
 * Logger ユーティリティ
 * エラーログを chrome.storage.local に保存する
 *
 * 性能上の注意:
 * ログは翻訳ホットパスから呼ばれるため、同期で await すると毎回 storage.local
 * への get→set が発生しクリティカルパスを膨らませる（1翻訳あたり数百ms〜）。
 * 対策として、addLog() はメモリ上のリングバッファに即 push して即 resolve し、
 * 実ストレージへは debounce で後追い flush する。ERROR レベルだけは観測性を
 * 損なわないよう短めの間隔で flush する。
 */
const MAX_LOGS = 200;
const LOG_STORAGE_KEY = 'errorLogs';
const FLUSH_DEBOUNCE_MS = 400;
const FLUSH_DEBOUNCE_ERROR_MS = 50;

export const LogLevel = {
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR'
};

// プロセス内で保持している最新ログ（メモリ）。
// 最初の addLog 呼び出し時にストレージから一度だけ読み込んで同期する。
let memoryLogs = null;
let memoryLoadPromise = null;
let flushTimer = null;
let flushPending = false;

async function loadMemoryLogsOnce() {
    if (memoryLogs !== null) return;
    if (!memoryLoadPromise) {
        memoryLoadPromise = (async () => {
            try {
                const result = await chrome.storage.local.get(LOG_STORAGE_KEY);
                memoryLogs = Array.isArray(result[LOG_STORAGE_KEY]) ? result[LOG_STORAGE_KEY] : [];
            } catch {
                memoryLogs = [];
            }
        })();
    }
    await memoryLoadPromise;
}

async function flushToStorage() {
    flushPending = false;
    flushTimer = null;
    if (!memoryLogs) return;
    try {
        // スナップショットを書き込む（以後の push はメモリに溜まり、次回 flush で書かれる）
        const snapshot = memoryLogs.slice();
        await chrome.storage.local.set({ [LOG_STORAGE_KEY]: snapshot });
    } catch (e) {
        // 書き込み失敗時は次回以降に再試行される（メモリには残っている）
        console.error('Failed to persist logs:', e);
    }
}

function scheduleFlush(isError) {
    if (flushPending) return;
    flushPending = true;
    const delay = isError ? FLUSH_DEBOUNCE_ERROR_MS : FLUSH_DEBOUNCE_MS;
    flushTimer = setTimeout(() => {
        flushToStorage().catch(() => {});
    }, delay);
}

/**
 * ログエントリを追加する。storage への書き込みは debounce される。
 * @param {string} level - INFO, WARN, ERROR
 * @param {string} source - background / content / popup
 * @param {string} message
 * @param {*} [detail]
 */
export async function addLog(level, source, message, detail = null) {
    try {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            source,
            message,
            detail: detail ? String(detail) : null
        };
        await loadMemoryLogsOnce();
        memoryLogs.push(entry);
        if (memoryLogs.length > MAX_LOGS) {
            memoryLogs.splice(0, memoryLogs.length - MAX_LOGS);
        }
        scheduleFlush(level === LogLevel.ERROR);
    } catch (e) {
        console.error('Failed to add log:', e);
    }
}

/**
 * ログを取得する（メモリ優先 / 未読込ならストレージから）
 * @param {number} [limit]
 * @returns {Promise<Array>}
 */
export async function getLogs(limit = 50) {
    try {
        // 取得時は最新状態が欲しいので、pending な変更を先に flush する
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
            flushPending = false;
            await flushToStorage();
        }
        await loadMemoryLogsOnce();
        return memoryLogs.slice(-limit).reverse();
    } catch (e) {
        console.error('Failed to get logs:', e);
        return [];
    }
}

/**
 * ログをクリアする
 */
export async function clearLogs() {
    try {
        memoryLogs = [];
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
            flushPending = false;
        }
        await chrome.storage.local.set({ [LOG_STORAGE_KEY]: [] });
    } catch (e) {
        console.error('Failed to clear logs:', e);
    }
}

/**
 * 便利メソッド
 * 呼び出し側は await しなくても良い（ホットパスでは await しないことを推奨）
 */
export const logger = {
    info: (source, message, detail) => addLog(LogLevel.INFO, source, message, detail),
    warn: (source, message, detail) => addLog(LogLevel.WARN, source, message, detail),
    error: (source, message, detail) => addLog(LogLevel.ERROR, source, message, detail)
};
