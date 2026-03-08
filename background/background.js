/**
 * Background Service Worker
 * Content Script と Gemini API 間の通信を中継する
 */

import { translateBatch, testApiKey } from '../utils/gemini.js';
import { logger, getLogs, clearLogs } from '../utils/logger.js';
import { checkBatchCache, saveBatchToCache } from '../utils/cache.js';

// コンテキストメニューの作成
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'translate-selection',
        title: '選択テキストを翻訳',
        contexts: ['selection']
    });
});

// コンテキストメニュークリック
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'translate-selection' || !tab?.id) return;

    try {
        const settings = await chrome.storage.sync.get(['apiKey', 'targetLang', 'batchMaxChars']);
        if (!settings.apiKey) {
            await logger.warn('background', 'コンテキストメニュー: APIキー未設定');
            return;
        }
        const targetLang = settings.targetLang || '日本語';
        const batchMaxChars = settings.batchMaxChars || 3000;

        // Content script を注入（必要であれば）
        await ensureContentScript(tab.id);

        chrome.tabs.sendMessage(tab.id, {
            type: 'TRANSLATE_SELECTION',
            targetLang,
            batchMaxChars
        }).catch(async (err) => {
            await logger.error('background', `選択翻訳エラー: ${err.message}`);
        });
    } catch (error) {
        await logger.error('background', `コンテキストメニューエラー: ${error.message}`);
    }
});

// キーボードショートカット
chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'translate-page') return;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) return;

        const settings = await chrome.storage.sync.get(['apiKey', 'targetLang', 'batchMaxChars']);
        if (!settings.apiKey) {
            await logger.warn('background', 'ショートカット: APIキー未設定');
            return;
        }
        const targetLang = settings.targetLang || '日本語';
        const batchMaxChars = settings.batchMaxChars || 3000;

        await logger.info('background', `ショートカットで翻訳開始: ${tab.url}`);

        await ensureContentScript(tab.id);

        chrome.tabs.sendMessage(tab.id, {
            type: 'START_TRANSLATION',
            targetLang,
            batchMaxChars
        }).catch(async (err) => {
            await logger.error('background', `ショートカット翻訳エラー: ${err.message}`);
        });
    } catch (error) {
        await logger.error('background', `ショートカットエラー: ${error.message}`);
    }
});

/**
 * Content Script が注入されていなければ注入する
 */
async function ensureContentScript(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { type: 'GET_TRANSLATION_STATE' });
    } catch {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content/content.js']
        });
        await chrome.scripting.insertCSS({
            target: { tabId },
            files: ['styles/content.css']
        });
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TRANSLATE') {
        handleTranslate(message, sender, sendResponse);
        return true;
    }

    if (message.type === 'TEST_API_KEY') {
        handleTestApiKey(message, sendResponse);
        return true;
    }

    if (message.type === 'GET_SETTINGS') {
        handleGetSettings(sendResponse);
        return true;
    }

    if (message.type === 'LOG') {
        handleLog(message);
        return false;
    }

    if (message.type === 'GET_LOGS') {
        handleGetLogs(message, sendResponse);
        return true;
    }

    if (message.type === 'CLEAR_LOGS') {
        handleClearLogs(sendResponse);
        return true;
    }
});

/**
 * 翻訳リクエストを処理する（キャッシュ対応）
 */
async function handleTranslate(message, sender, sendResponse) {
    try {
        const { texts, targetLang } = message;

        const settings = await chrome.storage.sync.get(['apiKey', 'model']);
        const apiKey = settings.apiKey;
        const model = settings.model || 'gemini-2.0-flash';

        if (!apiKey) {
            const err = 'APIキーが設定されていません。ポップアップから設定してください。';
            await logger.error('background', err);
            sendResponse({ success: false, error: err });
            return;
        }

        // キャッシュチェック
        const { cached, uncached } = await checkBatchCache(texts, targetLang);
        const cacheHits = cached.size;

        if (cacheHits > 0) {
            await logger.info('background', `キャッシュヒット: ${cacheHits}/${texts.length}件`);
        }

        // キャッシュミスのテキストのみ翻訳
        let apiTranslations = [];
        if (uncached.length > 0) {
            const uncachedTexts = uncached.map(i => texts[i]);
            await logger.info('background', `翻訳開始: ${uncachedTexts.length}件, 言語=${targetLang}, モデル=${model}`);
            apiTranslations = await translateBatch(uncachedTexts, targetLang, apiKey, model);

            // 結果をキャッシュに保存
            await saveBatchToCache(uncachedTexts, targetLang, apiTranslations);
            await logger.info('background', `翻訳完了: ${apiTranslations.length}件`);
        }

        // キャッシュとAPI結果をマージ
        const translatedTexts = new Array(texts.length);
        let apiIdx = 0;
        for (let i = 0; i < texts.length; i++) {
            if (cached.has(i)) {
                translatedTexts[i] = cached.get(i);
            } else {
                translatedTexts[i] = apiTranslations[apiIdx++];
            }
        }

        sendResponse({ success: true, translatedTexts });
    } catch (error) {
        await logger.error('background', `翻訳エラー: ${error.message}`, error.stack);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * APIキーのテストリクエストを処理する
 */
async function handleTestApiKey(message, sendResponse) {
    try {
        const { apiKey, model } = message;
        await logger.info('background', `APIキーテスト開始 (モデル: ${model || 'default'})`);
        const isValid = await testApiKey(apiKey, model);
        await logger.info('background', `APIキーテスト結果: ${isValid ? '有効' : '無効'}`);
        sendResponse({ success: true, isValid });
    } catch (error) {
        await logger.error('background', `APIキーテストエラー: ${error.message}`, error.stack);
        sendResponse({ success: false, isValid: false, error: error.message });
    }
}

/**
 * 設定の取得リクエストを処理する
 */
async function handleGetSettings(sendResponse) {
    try {
        const settings = await chrome.storage.sync.get(['apiKey', 'targetLang', 'model']);
        sendResponse({ success: true, settings });
    } catch (error) {
        await logger.error('background', `設定取得エラー: ${error.message}`);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Content Script からのログを記録する
 */
function handleLog(message) {
    const { level, source, logMessage, detail } = message;
    logger[level]?.(source, logMessage, detail);
}

/**
 * ログ取得リクエストを処理する
 */
async function handleGetLogs(message, sendResponse) {
    try {
        const logs = await getLogs(message.limit || 50);
        sendResponse({ success: true, logs });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * ログクリアリクエストを処理する
 */
async function handleClearLogs(sendResponse) {
    try {
        await clearLogs();
        await logger.info('background', 'ログをクリアしました');
        sendResponse({ success: true });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * ページ読み込み完了時の自動翻訳
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

    try {
        const settings = await chrome.storage.sync.get(['apiKey', 'targetLang', 'model', 'autoTranslate', 'batchMaxChars']);

        if (!settings.autoTranslate || !settings.apiKey) return;

        const targetLang = settings.targetLang || '日本語';
        const batchMaxChars = settings.batchMaxChars || 3000;

        await logger.info('background', `自動翻訳開始: ${tab.url}`);

        await ensureContentScript(tabId);

        chrome.tabs.sendMessage(tabId, {
            type: 'START_TRANSLATION',
            targetLang,
            batchMaxChars
        }).catch(async (err) => {
            await logger.warn('background', `自動翻訳メッセージ送信失敗: ${err.message}`);
        });
    } catch (error) {
        await logger.error('background', `自動翻訳エラー: ${error.message}`, error.stack);
    }
});
