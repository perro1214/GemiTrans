/**
 * Logger ユーティリティ
 * エラーログを chrome.storage.local に保存する
 */

const MAX_LOGS = 200;
const LOG_STORAGE_KEY = 'errorLogs';

/**
 * ログレベル
 */
export const LogLevel = {
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR'
};

/**
 * ログエントリを追加する
 * @param {string} level - ログレベル (INFO, WARN, ERROR)
 * @param {string} source - ログの発生源 (background, content, popup)
 * @param {string} message - ログメッセージ
 * @param {*} [detail] - 追加の詳細情報
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

        const result = await chrome.storage.local.get(LOG_STORAGE_KEY);
        const logs = result[LOG_STORAGE_KEY] || [];

        logs.push(entry);

        // 最大件数を超えたら古いものを削除
        if (logs.length > MAX_LOGS) {
            logs.splice(0, logs.length - MAX_LOGS);
        }

        await chrome.storage.local.set({ [LOG_STORAGE_KEY]: logs });
    } catch (e) {
        console.error('Failed to save log:', e);
    }
}

/**
 * ログを取得する
 * @param {number} [limit] - 取得件数（新しい順）
 * @returns {Promise<Array>}
 */
export async function getLogs(limit = 50) {
    try {
        const result = await chrome.storage.local.get(LOG_STORAGE_KEY);
        const logs = result[LOG_STORAGE_KEY] || [];
        return logs.slice(-limit).reverse();
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
        await chrome.storage.local.set({ [LOG_STORAGE_KEY]: [] });
    } catch (e) {
        console.error('Failed to clear logs:', e);
    }
}

/**
 * 便利メソッド
 */
export const logger = {
    info: (source, message, detail) => addLog(LogLevel.INFO, source, message, detail),
    warn: (source, message, detail) => addLog(LogLevel.WARN, source, message, detail),
    error: (source, message, detail) => addLog(LogLevel.ERROR, source, message, detail)
};
