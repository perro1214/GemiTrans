/**
 * Background Service Worker
 * Content Script と各種翻訳API 間の通信を中継する
 */

import { translateBatch as geminiTranslateBatch, testApiKey as geminiTestApiKey } from '../utils/gemini.js';
import { translateBatch as openrouterTranslateBatch, testApiKey as openrouterTestApiKey } from '../utils/openrouter.js';
import { translateBatch as lmstudioTranslateBatch, testApiKey as lmstudioTestApiKey } from '../utils/lmstudio.js';
import { translateBatch as sambanovaTranslateBatch, testApiKey as sambanovaTestApiKey } from '../utils/sambanova.js';
import { logger, getLogs, clearLogs } from '../utils/logger.js';
import { checkBatchCache, saveBatchToCache, clearCache, clearSiteCache, getCacheSiteList } from '../utils/cache.js';

/**
 * プロバイダーに応じた翻訳関数を返す
 */
function getTranslateBatch(provider) {
  if (provider === 'openrouter') return openrouterTranslateBatch;
  if (provider === 'lmstudio') return lmstudioTranslateBatch;
  if (provider === 'sambanova') return sambanovaTranslateBatch;
  return geminiTranslateBatch;
}

function getTestApiKey(provider) {
  if (provider === 'openrouter') return openrouterTestApiKey;
  if (provider === 'lmstudio') return lmstudioTestApiKey;
  if (provider === 'sambanova') return sambanovaTestApiKey;
  return geminiTestApiKey;
}

function normalizeProvider(provider) {
    if (provider === 'groq' || provider === 'cerebras') return 'gemini';
    return provider || 'gemini';
}

function resolveBatchMaxChars(value) {
    return typeof value === 'number' ? value : 3000;
}

async function cleanupRemovedProviderSettings() {
    const result = await settingsStorage.get([
        'apiProvider',
        'groqApiKey',
        'groqModel',
        'cerebrasApiKey',
        'cerebrasModel'
    ]);

    const updates = {};
    const removeKeys = [];
    const normalizedProvider = normalizeProvider(result.apiProvider);

    if ((result.apiProvider === 'groq' || result.apiProvider === 'cerebras') && normalizedProvider !== result.apiProvider) {
        updates.apiProvider = normalizedProvider;
    }

    if (result.groqApiKey !== undefined) removeKeys.push('groqApiKey');
    if (result.groqModel !== undefined) removeKeys.push('groqModel');
    if (result.cerebrasApiKey !== undefined) removeKeys.push('cerebrasApiKey');
    if (result.cerebrasModel !== undefined) removeKeys.push('cerebrasModel');

    if (removeKeys.length > 0) {
        await settingsStorage.remove(removeKeys);
    }
    if (Object.keys(updates).length > 0) {
        await settingsStorage.set(updates);
    }
}

/**
 * 現在のプロバイダー設定から翻訳に必要なクレデンシャル/エンドポイントを取得する
 * 値が空の場合は undefined を返す
 */
async function getActiveProviderCredential() {
    await cleanupRemovedProviderSettings();
    const s = await settingsStorage.get([
        'apiProvider', 'apiKey', 'openrouterApiKey', 'lmstudioEndpoint', 'sambanovaApiKey'
    ]);
    const provider = normalizeProvider(s.apiProvider);
    if (provider === 'openrouter') return s.openrouterApiKey || undefined;
    if (provider === 'lmstudio') return (s.lmstudioEndpoint || 'http://localhost:1234');
    if (provider === 'sambanova') return s.sambanovaApiKey || undefined;
    return s.apiKey || undefined;
}

const settingsStorage = chrome.storage.local;

// インメモリキャッシュ（Service Worker が生きている間有効）
const memoryCache = new Map();
const MEMORY_CACHE_MAX = 5000;

/**
 * LM Studio 呼び出し用の直列化ミューテックス
 *
 * TranslateGemma は文脈を考慮した翻訳が強みなので、1 バッチをできるだけ大きく
 * 送って 1 リクエストで翻訳させるのが最もスループットが高い。
 * ローカル推論は 1 モデル = 1 パイプラインのため、複数バッチを並列で投げても
 * 同時実行は出来ず GPU/CPU 上でコンテキストスイッチが起きて遅くなるだけ。
 * そこで content.js が 3 並列で TRANSLATE を送ってきても、ここで直列化する。
 */
let lmstudioMutex = Promise.resolve();
function withLMStudioMutex(task) {
    const next = lmstudioMutex.then(task, task);
    lmstudioMutex = next.catch(() => { });
    return next;
}

// API使用量ストレージキー
const USAGE_STORAGE_KEY = 'apiUsage';

// モデル料金テーブル ($/1M tokens, Paid Tier)
const MODEL_PRICING = {
    // Gemini
    'gemini-2.0-flash':              { input: 0.10,  output: 0.40  },
    'gemini-2.0-flash-lite':         { input: 0.075, output: 0.30  },
    'gemini-2.5-pro-preview-05-06':  { input: 1.25,  output: 10.00 },
    'gemini-3.1-flash-lite-preview': { input: 0.25,  output: 1.50  },
    // OpenRouter 無料モデル
    'google/gemma-4-31b-it:free':              { input: 0,    output: 0     },
    'google/gemma-4-26b-a4b-it:free':          { input: 0,    output: 0     },
    'nvidia/nemotron-3-super-120b-a12b:free':  { input: 0,    output: 0     },
    'minimax/minimax-m2.5:free':               { input: 0,    output: 0     },
    // OpenRouter Google Gemini
    'google/gemini-3.1-flash-lite-preview':    { input: 0.25, output: 1.50  },
    'google/gemini-3-flash-preview':           { input: 0.50, output: 3.00  },
    'google/gemini-3.1-pro-preview':           { input: 2.00, output: 12.00 },
    // OpenRouter OpenAI
    'openai/gpt-5.4-nano':                     { input: 0.20, output: 1.25  },
    'openai/gpt-5.4-mini':                     { input: 0.75, output: 4.50  },
    'openai/gpt-5.4':                          { input: 2.50, output: 15.00 },
    // OpenRouter Anthropic
    'anthropic/claude-sonnet-4.6':             { input: 3.00, output: 15.00 },
    'anthropic/claude-opus-4.6':               { input: 5.00, output: 25.00 },
    // LM Studio (ローカル実行なのでコスト 0)
    'translategemma-4b-it':                    { input: 0,    output: 0     },
    'translategemma-12b-it':                   { input: 0,    output: 0     },
    'translategemma-27b-it':                   { input: 0,    output: 0     },
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
 * 末尾に "|host" を付与し、サイト別削除時にフィルタ可能にする
 */
function makeMemoryCacheKey(text, targetLang, host) {
    let hash = 0;
    const str = text + '|' + targetLang;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    const fingerprint = text.slice(0, 16) + '|' + text.slice(-16);
    return `${hash}:${fingerprint}|${(host || '_unknown').toLowerCase()}`;
}

/**
 * キャッシュ対象として有効な訳文か
 * null をキャッシュすると以後ずっと「ヒットしているのに未翻訳」の状態になるため弾く。
 */
function isValidTranslatedText(value) {
    return typeof value === 'string' && value.length > 0;
}

// コンテキストメニューの作成
// 入力欄向けには言語選択サブメニューを提供する
const INPUT_TRANSLATE_LANGUAGES = [
    { id: 'English', label: '🇺🇸 English' },
    { id: '日本語', label: '🇯🇵 日本語' },
    { id: '中文', label: '🇨🇳 中文' },
    { id: '한국어', label: '🇰🇷 한국어' },
    { id: 'Français', label: '🇫🇷 Français' },
    { id: 'Deutsch', label: '🇩🇪 Deutsch' },
    { id: 'Español', label: '🇪🇸 Español' },
    { id: 'Português', label: '🇧🇷 Português' },
    { id: 'Italiano', label: '🇮🇹 Italiano' },
    { id: 'Русский', label: '🇷🇺 Русский' }
];

chrome.runtime.onInstalled.addListener(() => {
    if (!chrome.contextMenus?.create) return;

    // 通常テキスト選択用（ページ翻訳先言語で翻訳）
    chrome.contextMenus.create({
        id: 'translate-selection',
        title: '選択テキストを翻訳',
        contexts: ['selection']
    });

    // 入力欄向け: 言語選択サブメニュー付き
    chrome.contextMenus.create({
        id: 'translate-input-parent',
        title: '選択テキストを翻訳',
        contexts: ['editable']
    });
    for (const lang of INPUT_TRANSLATE_LANGUAGES) {
        chrome.contextMenus.create({
            id: `translate-input-${lang.id}`,
            parentId: 'translate-input-parent',
            title: `${lang.label} に翻訳`,
            contexts: ['editable']
        });
    }
});

// Safari iOS など、未実装APIがあるブラウザでも Service Worker が落ちないようにガードする
if (chrome.contextMenus?.onClicked) {
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
        if (!tab?.id) return;

        // 入力欄向け言語選択メニュー
        let targetLangOverride = null;
        if (info.menuItemId.startsWith?.('translate-input-')) {
            targetLangOverride = info.menuItemId.replace('translate-input-', '');
        } else if (info.menuItemId !== 'translate-selection') {
            return;
        }

        try {
            const credential = await getActiveProviderCredential();
            if (!credential) {
                await logger.warn('background', 'コンテキストメニュー: APIキー/エンドポイント未設定');
                return;
            }
            const settings = await settingsStorage.get(['targetLang', 'batchMaxChars']);
            const targetLang = targetLangOverride || settings.targetLang || '日本語';
            const batchMaxChars = resolveBatchMaxChars(settings.batchMaxChars);

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
}

// キーボードショートカット
if (chrome.commands?.onCommand) {
    chrome.commands.onCommand.addListener(async (command) => {
        if (command !== 'translate-page') return;

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;
            if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) return;

            const credential = await getActiveProviderCredential();
            if (!credential) {
                await logger.warn('background', 'ショートカット: APIキー/エンドポイント未設定');
                return;
            }
            const settings = await settingsStorage.get(['targetLang', 'batchMaxChars']);
            const targetLang = settings.targetLang || '日本語';
            const batchMaxChars = resolveBatchMaxChars(settings.batchMaxChars);

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
}

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

    if (message.type === 'CLEAR_CACHE') {
        const host = message.host; // undefined なら全削除
        const clearFn = host ? clearSiteCache(host) : clearCache();
        clearFn
            .then(() => {
                if (host) {
                    // サイト別削除: そのサイトに関連するメモリキャッシュのみ削除
                    for (const [key] of memoryCache) {
                        if (key.endsWith('|' + host)) memoryCache.delete(key);
                    }
                } else {
                    memoryCache.clear();
                }
                sendResponse({ success: true });
            })
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    if (message.type === 'GET_CACHE_SITES') {
        getCacheSiteList()
            .then(sites => sendResponse({ success: true, sites }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    // Content script からの UI 通知は SW にしか届かない環境があるため、オープン中の拡張ページ（ポップアップ等）へ転送する
    const forwardToExtensionPages = new Set([
        'TRANSLATION_PROGRESS',
        'TRANSLATION_COMPLETE',
        'TRANSLATION_SKIPPED',
        'TRANSLATION_CANCELLED',
        'TRANSLATION_ERROR'
    ]);
    if (forwardToExtensionPages.has(message.type) && sender.tab) {
        chrome.runtime.sendMessage(message).catch(() => { });
        return false;
    }
});

/**
 * 翻訳リクエストを処理する（2層キャッシュ対応: メモリ → storage.local → API）
 */
async function handleTranslate(message, sender, sendResponse) {
    try {
        const { texts, targetLang, roles, pageContext, host } = message;
        await cleanupRemovedProviderSettings();

        const settings = await settingsStorage.get([
            'apiKey', 'openrouterApiKey', 'apiProvider', 'model', 'openrouterModel',
            'lmstudioEndpoint', 'lmstudioModel', 'lmstudioSourceLang', 'sambanovaApiKey', 'sambanovaModel',
            'verboseLog'
        ]);
        const provider = normalizeProvider(settings.apiProvider);
        const verboseLog = !!settings.verboseLog;

        let apiKey, model;
        if (provider === 'openrouter') {
            apiKey = settings.openrouterApiKey;
            model = settings.openrouterModel || 'google/gemini-2.0-flash-exp:free';
        } else if (provider === 'lmstudio') {
            apiKey = settings.lmstudioEndpoint || 'http://localhost:1234';
            model = settings.lmstudioModel || 'translategemma-4b-it';
        } else if (provider === 'sambanova') {
            apiKey = settings.sambanovaApiKey;
            model = settings.sambanovaModel || 'DeepSeek-V3.1';
        } else {
            apiKey = settings.apiKey;
            model = settings.model || 'gemini-2.0-flash';
        }

        if (!apiKey) {
            const err = provider === 'lmstudio'
                ? 'LM Studio のエンドポイントが設定されていません。'
                : 'APIキーが設定されていません。ポップアップから設定してください。';
            await logger.error('background', err);
            sendResponse({ success: false, error: err });
            return;
        }

        const lmstudioSourceLang = settings.lmstudioSourceLang || 'en';

        // 1層目: メモリキャッシュチェック（I/Oなし・最速）
        const memoryCached = new Map(); // index -> translated
        const memoryMissIndices = [];
        for (let i = 0; i < texts.length; i++) {
            const key = makeMemoryCacheKey(texts[i], targetLang, host);
            const cachedValue = memoryCache.get(key);
            if (isValidTranslatedText(cachedValue)) {
                memoryCached.set(i, cachedValue);
            } else {
                if (memoryCache.has(key)) memoryCache.delete(key);
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
            const { cached: storageCacheResult, uncached } = await checkBatchCache(memoryMissTexts, targetLang, host);
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
                const key = makeMemoryCacheKey(texts[originalIdx], targetLang, host);
                if (isValidTranslatedText(translated) && memoryCache.size < MEMORY_CACHE_MAX) {
                    memoryCache.set(key, translated);
                }
            }
            storageUncachedIndices = uncached.map(localIdx => memoryMissIndices[localIdx]);
        }

        // API 呼び出し（両キャッシュともミスした分のみ）
        let apiTranslations = [];
        if (storageUncachedIndices.length > 0) {
            const uncachedTexts = storageUncachedIndices.map(i => texts[i]);
            const uncachedRoles = Array.isArray(roles)
                ? storageUncachedIndices.map(i => roles[i] || 'body')
                : undefined;
            await logger.info('background', `翻訳開始: ${uncachedTexts.length}件, 言語=${targetLang}, プロバイダー=${provider}, モデル=${model}`);
            const apiStartTime = Date.now();
            const translateBatch = getTranslateBatch(provider);
            const onUsage = (usage) => recordUsage(model, usage.inputTokens, usage.outputTokens);
            const promptOptions = { roles: uncachedRoles, pageContext: pageContext || null };
            if (provider === 'lmstudio') {
                // ローカル推論のバッチを直列化して 1 リクエスト = 1 推論を徹底する
                apiTranslations = await withLMStudioMutex(() =>
                    translateBatch(uncachedTexts, targetLang, apiKey, model, onUsage, lmstudioSourceLang, promptOptions)
                );
            } else {
                apiTranslations = await translateBatch(uncachedTexts, targetLang, apiKey, model, onUsage, promptOptions);
            }
            const apiElapsed = Date.now() - apiStartTime;

            const avgMs = uncachedTexts.length > 0 ? Math.round(apiElapsed / uncachedTexts.length) : 0;
            const nullCount = apiTranslations.filter(t => t === null).length;
            if (nullCount > 0) {
                await logger.warn('background', `翻訳失敗: ${nullCount}/${apiTranslations.length}件がnull (プロバイダー=${provider}, モデル=${model})`);
            }
            await logger.info(
                'background',
                `API応答: ${apiElapsed}ms (${uncachedTexts.length}件, 平均${avgMs}ms/件) プロバイダー=${provider}`,
                `モデル=${model}, 言語=${targetLang}`
            );

            // API結果をメモリキャッシュに保存
            for (let j = 0; j < storageUncachedIndices.length; j++) {
                const key = makeMemoryCacheKey(texts[storageUncachedIndices[j]], targetLang, host);
                const translated = apiTranslations[j];
                if (isValidTranslatedText(translated)) {
                    if (memoryCache.size < MEMORY_CACHE_MAX) {
                        memoryCache.set(key, translated);
                    }
                } else if (memoryCache.has(key)) {
                    memoryCache.delete(key);
                }
            }

            // storage.local への保存は fire-and-forget（レスポンスを早く返す）
            const savedCount = apiTranslations.filter(isValidTranslatedText).length;
            saveBatchToCache(uncachedTexts, targetLang, apiTranslations, host)
                .then(() => logger.info('background', `キャッシュ保存完了: ${savedCount}件`))
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
                const translated = apiTranslations[apiIdx++];
                translatedTexts[i] = isValidTranslatedText(translated) ? translated : null;
            }
        }

        const translatedCount = translatedTexts.filter(isValidTranslatedText).length;
        if (translatedCount === 0) {
            const err = `${provider} から有効な翻訳結果を取得できませんでした（モデル=${model}）`;
            await logger.error('background', err);
            sendResponse({ success: false, error: err });
            return;
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
        const { apiKey, model, provider } = message;
        const normalizedProvider = normalizeProvider(provider);
        await logger.info('background', `APIキーテスト開始 (プロバイダー: ${normalizedProvider}, モデル: ${model || 'default'})`);
        const testFn = getTestApiKey(normalizedProvider);
        const isValid = await testFn(apiKey, model);
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
        await cleanupRemovedProviderSettings();
        const settings = await settingsStorage.get(['apiKey', 'targetLang', 'model']);
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
        const settings = await settingsStorage.get(['targetLang', 'autoTranslate', 'batchMaxChars']);
        if (!settings.autoTranslate) return;
        const credential = await getActiveProviderCredential();
        if (!credential) return;

        const targetLang = settings.targetLang || '日本語';
        const batchMaxChars = resolveBatchMaxChars(settings.batchMaxChars);

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
        const settings = await settingsStorage.get(['targetLang', 'model', 'autoTranslate', 'batchMaxChars']);

        if (!settings.autoTranslate) return;
        const credential = await getActiveProviderCredential();
        if (!credential) return;

        const targetLang = settings.targetLang || '日本語';
        const batchMaxChars = resolveBatchMaxChars(settings.batchMaxChars);

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
