/**
 * Background Service Worker
 * Content Script と Gemini API 間の通信を中継する
 */

import { translateBatch, testApiKey } from '../utils/gemini.js';
import { logger, getLogs, clearLogs } from '../utils/logger.js';
import { checkBatchCache, saveBatchToCache } from '../utils/cache.js';

// インメモリキャッシュ（Service Worker が生きている間有効）
const memoryCache = new Map();
const MEMORY_CACHE_MAX = 5000;

// API使用量ストレージキー
const USAGE_STORAGE_KEY = 'apiUsage';

// モデル料金テーブル ($/1M tokens, Paid Tier)
const MODEL_PRICING = {
    'gemini-2.0-flash':              { input: 0.10,  output: 0.40  },
    'gemini-2.0-flash-lite':         { input: 0.075, output: 0.30  },
    'gemini-2.5-pro-preview-05-06':  { input: 1.25,  output: 10.00 },
    'gemini-3.1-flash-lite-preview': { input: 0.25,  output: 1.50  },
};

/**
 * API使用量を storage.local に記録する
 */
async function recordUsage(model, inputTokens, outputTokens) {
    try {
        const result = await chrome.storage.local.get(USAGE_STORAGE_KEY);
        const usage = result[USAGE_STORAGE_KEY] || {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalRequests: 0,
            byModel: {},
            since: new Date().toISOString()
        };

        usage.totalInputTokens += inputTokens;
        usage.totalOutputTokens += outputTokens;
        usage.totalRequests += 1;

        if (!usage.byModel[model]) {
            usage.byModel[model] = { inputTokens: 0, outputTokens: 0, requests: 0 };
        }
        usage.byModel[model].inputTokens += inputTokens;
        usage.byModel[model].outputTokens += outputTokens;
        usage.byModel[model].requests += 1;

        await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: usage });
    } catch (e) {
        // 使用量保存失敗は無視
    }
}

/**
 * メモリキャッシュ用のキーを生成する（ハッシュ＋プレフィックスで衝突防止）
 */
function makeMemoryCacheKey(text, targetLang) {
    let hash = 0;
    const str = text + '|' + targetLang;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash + ':' + str.slice(0, 20);
}

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

    if (message.type === 'GET_USAGE') {
        handleGetUsage(sendResponse);
        return true;
    }

    if (message.type === 'CLEAR_USAGE') {
        handleClearUsage(sendResponse);
        return true;
    }
});

/**
 * 翻訳リクエストを処理する（2層キャッシュ対応: メモリ → storage.local → API）
 */
async function handleTranslate(message, sender, sendResponse) {
    try {
        const { texts, targetLang } = message;

        const settings = await chrome.storage.sync.get(['apiKey', 'model', 'verboseLog']);
        const apiKey = settings.apiKey;
        const model = settings.model || 'gemini-2.0-flash';
        const verboseLog = !!settings.verboseLog;

        if (!apiKey) {
            const err = 'APIキーが設定されていません。ポップアップから設定してください。';
            await logger.error('background', err);
            sendResponse({ success: false, error: err });
            return;
        }

        // 1層目: メモリキャッシュチェック（I/Oなし・最速）
        const memoryCached = new Map(); // index -> translated
        const memoryMissIndices = [];
        for (let i = 0; i < texts.length; i++) {
            const key = makeMemoryCacheKey(texts[i], targetLang);
            if (memoryCache.has(key)) {
                memoryCached.set(i, memoryCache.get(key));
            } else {
                memoryMissIndices.push(i);
            }
        }
        if (memoryCached.size > 0) {
            await logger.info('background', `メモリキャッシュヒット: ${memoryCached.size}/${texts.length}件`);
        }

        // 2層目: storage.local キャッシュチェック（メモリミス分のみ）
        const storageCached = new Map(); // index -> translated
        let storageUncachedIndices = memoryMissIndices;
        if (memoryMissIndices.length > 0) {
            const memoryMissTexts = memoryMissIndices.map(i => texts[i]);
            const { cached: storageCacheResult, uncached } = await checkBatchCache(memoryMissTexts, targetLang);
            if (storageCacheResult.size > 0) {
                await logger.info('background', `ストレージキャッシュヒット: ${storageCacheResult.size}/${memoryMissTexts.length}件`);
            }
            if (verboseLog) {
                await logger.info('background', `キャッシュ統計: メモリ=${memoryCached.size} / ストレージ=${storageCacheResult.size} / API予定=${uncached.length} (合計=${texts.length}件)`, `メモリキャッシュ使用: ${memoryCache.size}/${MEMORY_CACHE_MAX}`);
            }

            // storage ヒット分を元のインデックスに戻しつつメモリキャッシュにウォームアップ
            for (const [localIdx, translated] of storageCacheResult) {
                const originalIdx = memoryMissIndices[localIdx];
                storageCached.set(originalIdx, translated);
                const key = makeMemoryCacheKey(texts[originalIdx], targetLang);
                if (memoryCache.size < MEMORY_CACHE_MAX) {
                    memoryCache.set(key, translated);
                }
            }
            storageUncachedIndices = uncached.map(localIdx => memoryMissIndices[localIdx]);
        }

        // API 呼び出し（両キャッシュともミスした分のみ）
        let apiTranslations = [];
        if (storageUncachedIndices.length > 0) {
            const uncachedTexts = storageUncachedIndices.map(i => texts[i]);
            await logger.info('background', `翻訳開始: ${uncachedTexts.length}件, 言語=${targetLang}, モデル=${model}`);
            const apiStartTime = Date.now();
            apiTranslations = await translateBatch(uncachedTexts, targetLang, apiKey, model, (usage) => {
                recordUsage(model, usage.inputTokens, usage.outputTokens);
            });
            const apiElapsed = Date.now() - apiStartTime;

            if (verboseLog) {
                const avgMs = uncachedTexts.length > 0 ? Math.round(apiElapsed / uncachedTexts.length) : 0;
                await logger.info('background', `API応答: ${apiElapsed}ms (${uncachedTexts.length}件, 平均${avgMs}ms/件)`, `モデル=${model}, 言語=${targetLang}`);
            }

            // API結果をメモリキャッシュに保存
            for (let j = 0; j < storageUncachedIndices.length; j++) {
                const key = makeMemoryCacheKey(texts[storageUncachedIndices[j]], targetLang);
                if (memoryCache.size < MEMORY_CACHE_MAX) {
                    memoryCache.set(key, apiTranslations[j]);
                }
            }

            // storage.local への保存は fire-and-forget（レスポンスを早く返す）
            saveBatchToCache(uncachedTexts, targetLang, apiTranslations)
                .then(() => logger.info('background', `キャッシュ保存完了: ${apiTranslations.length}件`))
                .catch(e => logger.error('background', `キャッシュ保存エラー: ${e.message}`));
        }

        // 全キャッシュ・API結果をマージ
        const translatedTexts = new Array(texts.length);
        let apiIdx = 0;
        for (let i = 0; i < texts.length; i++) {
            if (memoryCached.has(i)) {
                translatedTexts[i] = memoryCached.get(i);
            } else if (storageCached.has(i)) {
                translatedTexts[i] = storageCached.get(i);
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
 * API使用量取得リクエストを処理する
 */
async function handleGetUsage(sendResponse) {
    try {
        const result = await chrome.storage.local.get(USAGE_STORAGE_KEY);
        sendResponse({ success: true, usage: result[USAGE_STORAGE_KEY] || null, pricing: MODEL_PRICING });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * API使用量リセットリクエストを処理する
 */
async function handleClearUsage(sendResponse) {
    try {
        await chrome.storage.local.remove(USAGE_STORAGE_KEY);
        sendResponse({ success: true });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
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
 * SPA のページ遷移（history.pushState）を検知して自動翻訳
 * React / Vue / Angular などのシングルページアプリケーション対応
 */
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
    // メインフレームのみ処理（iframe 内の遷移は無視）
    if (details.frameId !== 0) return;

    try {
        const settings = await chrome.storage.sync.get(['apiKey', 'targetLang', 'autoTranslate', 'batchMaxChars']);
        if (!settings.autoTranslate || !settings.apiKey) return;

        const targetLang = settings.targetLang || '日本語';
        const batchMaxChars = settings.batchMaxChars || 3000;

        await logger.info('background', `SPA遷移検知: ${details.url}`);

        // SPA 遷移後は React/Vue 等がDOMを更新するまで少し待機
        await new Promise(resolve => setTimeout(resolve, 800));

        chrome.tabs.sendMessage(details.tabId, {
            type: 'START_TRANSLATION',
            targetLang,
            batchMaxChars
        }).catch(async (err) => {
            await logger.warn('background', `SPA自動翻訳メッセージ送信失敗: ${err.message}`);
        });
    } catch (error) {
        await logger.error('background', `SPA自動翻訳エラー: ${error.message}`, error.stack);
    }
});

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
