function normalizeContextParallelism(value) {
    return Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 6 ? Number(value) : 3;
}
/**
 * Background Service Worker
 * Content Script と各種翻訳API 間の通信を中継する
 */

import { translateBatch as geminiTranslateBatch, testApiKey as geminiTestApiKey } from '../utils/gemini.js';
import { translateBatch as openrouterTranslateBatch, testApiKey as openrouterTestApiKey } from '../utils/openrouter.js';
import { translateBatch as lmstudioTranslateBatch, testApiKey as lmstudioTestApiKey, listModels as lmstudioListModels, isGemma4Model, isGemma4E2BModel, isHyMT2SmallModel } from '../utils/lmstudio.js';
import { translateBatch as sambanovaTranslateBatch, testApiKey as sambanovaTestApiKey } from '../utils/sambanova.js';
import { translateBatch as nvidiaTranslateBatch, testApiKey as nvidiaTestApiKey } from '../utils/nvidia.js';
import { translateBatch as cerebrasTranslateBatch, testApiKey as cerebrasTestApiKey } from '../utils/cerebras.js';
import { translateBatch as plamoTranslateBatch, testApiKey as plamoTestApiKey } from '../utils/plamo.js';
import { translateBatch as opencodeGoTranslateBatch, testApiKey as opencodeGoTestApiKey } from '../utils/opencodego.js';
import { translateBatch as lolipopTranslateBatch, testApiKey as lolipopTestApiKey } from '../utils/lolipop.js';
import { translateGooglePreview } from '../utils/googletranslate.js';
import { logger, getLogs, clearLogs } from '../utils/logger.js';
import { checkBatchCache, touchBatchCache, saveBatchToCache, clearCache, clearSiteCache, getCacheSiteList } from '../utils/cache.js';

/**
 * プロバイダーに応じた翻訳関数を返す
 */
function getTranslateBatch(provider) {
  if (provider === 'openrouter') return openrouterTranslateBatch;
  if (provider === 'lmstudio') return lmstudioTranslateBatch;
  if (provider === 'sambanova') return sambanovaTranslateBatch;
  if (provider === 'nvidia') return nvidiaTranslateBatch;
  if (provider === 'cerebras') return cerebrasTranslateBatch;
  if (provider === 'plamo') return plamoTranslateBatch;
  if (provider === 'opencodego') return opencodeGoTranslateBatch;
  if (provider === 'lolipop') return lolipopTranslateBatch;
  return geminiTranslateBatch;
}

function getTestApiKey(provider) {
  if (provider === 'openrouter') return openrouterTestApiKey;
  if (provider === 'lmstudio') return lmstudioTestApiKey;
  if (provider === 'sambanova') return sambanovaTestApiKey;
  if (provider === 'nvidia') return nvidiaTestApiKey;
  if (provider === 'cerebras') return cerebrasTestApiKey;
  if (provider === 'plamo') return plamoTestApiKey;
  if (provider === 'opencodego') return opencodeGoTestApiKey;
  if (provider === 'lolipop') return lolipopTestApiKey;
  return geminiTestApiKey;
}

function normalizeProvider(provider) {
    if (provider === 'groq') return 'gemini';
    return provider || 'gemini';
}

function resolveBatchMaxChars(value) {
    return typeof value === 'number' ? value : 3000;
}

// 旧 groq 設定のクリーンアップは SW 起動1回で済む。以降は memoized promise を再利用し
// 翻訳ホットパスで毎回 storage IO を発生させないようにする。
let cleanupPromise = null;
async function cleanupRemovedProviderSettings() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
        const result = await settingsStorage.get([
            'apiProvider',
            'groqApiKey',
            'groqModel'
        ]);

        const updates = {};
        const removeKeys = [];
        const normalizedProvider = normalizeProvider(result.apiProvider);

        if (result.apiProvider === 'groq' && normalizedProvider !== result.apiProvider) {
            updates.apiProvider = normalizedProvider;
        }

        if (result.groqApiKey !== undefined) removeKeys.push('groqApiKey');
        if (result.groqModel !== undefined) removeKeys.push('groqModel');

        if (removeKeys.length > 0) {
            await settingsStorage.remove(removeKeys);
        }
        if (Object.keys(updates).length > 0) {
            await settingsStorage.set(updates);
        }
    })();
    return cleanupPromise;
}

// 設定の短寿命キャッシュ。並列バッチが同一 SW 生存中にほぼ同時に handleTranslate
// を叩くため、storage.local.get を毎回呼ぶと IO が線形に増える。storage.onChanged
// で無効化しつつ、短い TTL も安全弁として設ける。
const SETTINGS_CACHE_TTL_MS = 2000;
const SETTINGS_KEYS = [
    'apiKey', 'openrouterApiKey', 'apiProvider', 'model', 'openrouterModel',
    'lmstudioEndpoint', 'lmstudioModel', 'lmstudioSourceLang', 'sambanovaApiKey', 'sambanovaModel',
    'nvidiaApiKey', 'nvidiaModel', 'cerebrasApiKey', 'cerebrasModel', 'plamoApiKey', 'plamoModel',
    'opencodeGoApiKey', 'opencodeGoModel',
    'lolipopApiKey', 'lolipopModel',
    'verboseLog', 'contextAwareParallel', 'contextParallelism', 'googlePreviewEnabled', 'googleTranslateApiKey'
];
let settingsCache = null;
let settingsCacheAt = 0;
let settingsCacheInflight = null;

async function getTranslateSettings() {
    const now = Date.now();
    if (settingsCache && now - settingsCacheAt < SETTINGS_CACHE_TTL_MS) {
        return settingsCache;
    }
    if (settingsCacheInflight) return settingsCacheInflight;
    settingsCacheInflight = (async () => {
        try {
            const s = await settingsStorage.get(SETTINGS_KEYS);
            settingsCache = s;
            settingsCacheAt = Date.now();
            return s;
        } finally {
            settingsCacheInflight = null;
        }
    })();
    return settingsCacheInflight;
}

if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        // 対象キーが変わった場合のみ設定キャッシュ無効化
        for (const k of SETTINGS_KEYS) {
            if (k in changes) {
                settingsCache = null;
                settingsCacheAt = 0;
                return;
            }
        }
    });
}

/**
 * 現在のプロバイダー設定から翻訳に必要なクレデンシャル/エンドポイントを取得する
 * 値が空の場合は undefined を返す
 */
async function getActiveProviderCredential() {
    await cleanupRemovedProviderSettings();
    const s = await settingsStorage.get([
        'apiProvider', 'apiKey', 'openrouterApiKey', 'lmstudioEndpoint', 'sambanovaApiKey', 'nvidiaApiKey', 'cerebrasApiKey', 'plamoApiKey', 'opencodeGoApiKey', 'lolipopApiKey'
    ]);
    const provider = normalizeProvider(s.apiProvider);
    if (provider === 'openrouter') return s.openrouterApiKey || undefined;
    if (provider === 'lmstudio') return (s.lmstudioEndpoint || 'http://localhost:1234');
    if (provider === 'sambanova') return s.sambanovaApiKey || undefined;
    if (provider === 'nvidia') return s.nvidiaApiKey || undefined;
    if (provider === 'cerebras') return s.cerebrasApiKey || undefined;
    if (provider === 'plamo') return s.plamoApiKey || undefined;
    if (provider === 'opencodego') return s.opencodeGoApiKey || undefined;
    if (provider === 'lolipop') return s.lolipopApiKey || undefined;
    return s.apiKey || undefined;
}

const settingsStorage = chrome.storage.local;

// インメモリキャッシュ（Service Worker が生きている間有効）
const memoryCache = new Map();
const MEMORY_CACHE_MAX = 5000;

/**
 * ローカルAPI 呼び出し用の軽い並列制限。
 *
 * 大型モデルは直列が安定する。GTX 1080へ全層ロードできるHy-MT2 1.8Bと
 * Gemma 4 E2Bは、llama.cppの2スロット構成と組み合わせると実測で速くなる。
 */
const LOCAL_API_DEFAULT_MAX_PARALLEL_REQUESTS = 1;
const LOCAL_API_HYMT2_SMALL_MAX_PARALLEL_REQUESTS = 2;
const LOCAL_API_GEMMA4_E2B_MAX_PARALLEL_REQUESTS = 2;
let localApiActiveRequests = 0;
const localApiWaiters = [];

async function withLocalApiSlot(task, maxParallel = LOCAL_API_DEFAULT_MAX_PARALLEL_REQUESTS) {
    if (localApiActiveRequests >= maxParallel) {
        await new Promise(resolve => localApiWaiters.push(resolve));
    }
    localApiActiveRequests++;
    try {
        return await task();
    } finally {
        localApiActiveRequests--;
        const next = localApiWaiters.shift();
        if (next) next();
    }
}

const LOCAL_MODEL_CACHE_TTL_MS = 10000;
const localModelCache = new Map();
const LOCAL_API_DEFAULT_MAX_ITEMS_PER_REQUEST = 24;
const LOCAL_API_GEMMA4_MAX_ITEMS_PER_REQUEST = 12;
const LOCAL_API_HYMT2_SMALL_MAX_ITEMS_PER_REQUEST = 1;

async function getLocalApiModelIds(endpoint) {
    const now = Date.now();
    const cached = localModelCache.get(endpoint);
    if (cached && now - cached.at < LOCAL_MODEL_CACHE_TTL_MS) {
        return cached.ids;
    }
    const ids = await lmstudioListModels(endpoint);
    localModelCache.set(endpoint, { ids, at: now });
    return ids;
}

async function resolveLocalApiModel(endpoint, configuredModel) {
    const ids = await getLocalApiModelIds(endpoint);
    if (configuredModel && ids.includes(configuredModel)) return configuredModel;
    if (ids.length === 1) {
        const actual = ids[0];
        if (configuredModel && configuredModel !== actual) {
            logger.warn('background', `ローカルAPIモデルを自動補正: ${configuredModel} → ${actual}`);
        }
        return actual;
    }
    if (ids.length > 1) {
        throw new Error(`モデル "${configuredModel || '(未設定)'}" がローカルAPIにロードされていません。利用可能: ${ids.join(', ')}`);
    }
    throw new Error('ローカルAPIにロード済みモデルがありません');
}

function splitLocalApiItems(texts, roles, maxItems = LOCAL_API_DEFAULT_MAX_ITEMS_PER_REQUEST) {
    const chunks = [];
    for (let i = 0; i < texts.length; i += maxItems) {
        const end = Math.min(texts.length, i + maxItems);
        chunks.push({
            texts: texts.slice(i, end),
            roles: Array.isArray(roles) ? roles.slice(i, end) : undefined
        });
    }
    return chunks;
}

function getLocalApiMaxItemsPerRequest(model) {
    if (isHyMT2SmallModel(model)) return LOCAL_API_HYMT2_SMALL_MAX_ITEMS_PER_REQUEST;
    return isGemma4Model(model)
        ? LOCAL_API_GEMMA4_MAX_ITEMS_PER_REQUEST
        : LOCAL_API_DEFAULT_MAX_ITEMS_PER_REQUEST;
}

function getLocalApiMaxParallelRequests(model) {
    if (isHyMT2SmallModel(model)) return LOCAL_API_HYMT2_SMALL_MAX_PARALLEL_REQUESTS;
    if (isGemma4E2BModel(model)) return LOCAL_API_GEMMA4_E2B_MAX_PARALLEL_REQUESTS;
    return LOCAL_API_DEFAULT_MAX_PARALLEL_REQUESTS;
}

async function translateLocalApiWithLimitedParallelism({
    translateBatch,
    texts,
    targetLang,
    endpoint,
    model,
    onUsage,
    sourceLang,
    roles,
    pageContext, requestFetch
}) {
    const maxItems = getLocalApiMaxItemsPerRequest(model);
    const maxParallel = getLocalApiMaxParallelRequests(model);
    const chunks = splitLocalApiItems(texts, roles, maxItems);
    const logSubBatches = chunks.length > 1 && maxItems > 1;

    if (chunks.length > 1) {
        await logger.info(
            'background',
            `ローカルAPI内部分割: ${texts.length}件を${chunks.length}回に分割`,
            `上限=${maxItems}件/回, 並列=${maxParallel}, モデル=${model}`
        );
    }

    const results = new Array(chunks.length);
    let cursor = 0;

    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= chunks.length) return;
            const chunk = chunks[i];
            const started = Date.now();
            if (logSubBatches) {
                await logger.info('background', `ローカルAPIサブバッチ ${i + 1}/${chunks.length}: ${chunk.texts.length}件`);
            }
            results[i] = await withLocalApiSlot(
                () => translateBatch(
                    chunk.texts,
                    targetLang,
                    endpoint,
                    model,
                    onUsage,
                    sourceLang,
                    { roles: chunk.roles, pageContext, requestFetch }
                ),
                maxParallel
            );
            if (logSubBatches) {
                await logger.info('background', `ローカルAPIサブバッチ完了 ${i + 1}/${chunks.length}: ${Date.now() - started}ms`);
            }
        }
    }

    const workerCount = Math.max(1, Math.min(maxParallel, chunks.length));
    await Promise.all(Array.from({ length: workerCount }, worker));

    const merged = [];
    for (const translated of results) {
        merged.push(...translated);
    }
    return merged;
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
    // ローカルAPI (ローカル実行なのでコスト 0)
    'translategemma-4b-it':                    { input: 0,    output: 0     },
    'translategemma-12b-it':                   { input: 0,    output: 0     },
    'translategemma-27b-it':                   { input: 0,    output: 0     },
    'mlx-community/Hy-MT2-1.8B-4bit':          { input: 0,    output: 0     },
    'mlx-community/Hy-MT2-7B-4bit':            { input: 0,    output: 0     },
    'tencent/Hy-MT2-7B-GGUF:Q4_K_M':           { input: 0,    output: 0     },
    'gemitrans-hymt2-1.8b':                     { input: 0,    output: 0     },
    'gemitrans-gemma4-e2b':                     { input: 0,    output: 0     },
    'gemitrans-gemma4':                         { input: 0,    output: 0     },
    // NVIDIA
    'meta/llama-3.1-70b-instruct':             { input: 0,    output: 0     },
    'meta/llama-3.1-8b-instruct':              { input: 0,    output: 0     },
    'nvidia/llama-3.1-nemotron-70b-instruct':  { input: 0,    output: 0     },
    // Cerebras
    'llama-3.3-70b':                           { input: 0,    output: 0     },
    'llama-3.1-8b':                            { input: 0,    output: 0     },
    'qwen-3-32b':                              { input: 0,    output: 0     },
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
    return JSON.stringify([text, targetLang]) + '|' + (host || '_unknown').toLowerCase();
}

/**
 * キャッシュ対象として有効な訳文か
 * null をキャッシュすると以後ずっと「ヒットしているのに未翻訳」の状態になるため弾く。
 */
const LEAKED_TRANSLATION_MARKER_RE = /<\/?(?:translation|link|body|button|h[1-6]|heading|label|caption|option|tab|menu[-_ ]?item|selection|em|emphasis|strong|code|title|header|footer|nav|aside|list[-_ ]?item|quote|table[-_ ]?header|table[-_ ]?cell|term|definition|summary|citation)(?:@group-\d+)?(?:\s+[^>]*)?>/i;
const LEAKED_PAREN_ROLE_RE = /\((?:translation|link|body|button|h[1-6]|heading|label|caption|option|tab|menu[-_ ]?item|selection|em|emphasis|strong|code|title|header|footer|nav|aside|list[-_ ]?item|quote|table[-_ ]?header|table[-_ ]?cell|term|definition|summary|citation)(?:@group-\d+)?\)/i;

function isValidTranslatedText(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (LEAKED_TRANSLATION_MARKER_RE.test(trimmed)) return false;
    if (LEAKED_PAREN_ROLE_RE.test(trimmed)) return false;
    if (/^<?\s*translation\s*>?$/i.test(trimmed)) return false;
    return true;
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
            const settings = await settingsStorage.get(['targetLang', 'batchMaxChars', 'contextAwareParallel', 'contextParallelism']);
            const targetLang = targetLangOverride || settings.targetLang || '日本語';
            const batchMaxChars = resolveBatchMaxChars(settings.batchMaxChars);

            // Content script を注入（必要であれば）
            await ensureContentScript(tab.id, info.frameId || 0);

            chrome.tabs.sendMessage(tab.id, {
                type: 'TRANSLATE_SELECTION',
                targetLang,
                batchMaxChars, contextAwareParallel: !!settings.contextAwareParallel, contextParallelism: normalizeContextParallelism(settings.contextParallelism)
            }, { frameId: info.frameId || 0 }).catch(async (err) => {
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
            const settings = await settingsStorage.get(['targetLang', 'batchMaxChars', 'contextAwareParallel', 'contextParallelism']);
            const targetLang = settings.targetLang || '日本語';
            const batchMaxChars = resolveBatchMaxChars(settings.batchMaxChars);

            await logger.info('background', `ショートカットで翻訳開始: ${tab.url}`);

            await ensureContentScript(tab.id);

            chrome.tabs.sendMessage(tab.id, {
                type: 'START_TRANSLATION',
                targetLang,
                batchMaxChars, contextAwareParallel: !!settings.contextAwareParallel, contextParallelism: normalizeContextParallelism(settings.contextParallelism)
            }, { frameId: 0 }).catch(async (err) => {
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
async function ensureContentScript(tabId, frameId = 0) {
    try {
        await chrome.tabs.sendMessage(tabId, { type: 'GET_TRANSLATION_STATE' }, { frameId });
    } catch {
        await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            files: ['content/content.js']
        });
        await chrome.scripting.insertCSS({
            target: { tabId, frameIds: [frameId] },
            files: ['styles/content.css']
        });
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

// Kaggleのノートブック本文だけを対象にする。任意の広告iframeには展開しない。
function isKaggleNotebookPageUrl(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && /^(www\.)?kaggle\.com$/.test(u.hostname) && u.pathname.startsWith('/code/'); }
    catch { return false; }
}
function isKaggleNotebookFrameUrl(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && /(^|\.)kaggleusercontent\.com$/.test(u.hostname) && u.pathname.startsWith('/kf/'); }
    catch { return false; }
}

const notebookSessionWrites = new Map();
async function notebookContext(sender) {
    if (!sender.tab?.id) throw new Error('Notebook sender has no tab');
    const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id }) || [];
    const top = frames.find(f => f.frameId === 0);
    if (!top || !isKaggleNotebookPageUrl(top.url)) throw new Error('Not a Kaggle notebook page');
    const current = frames.find(f => f.frameId === sender.frameId);
    if (!current || (sender.documentId && current.documentId && sender.documentId !== current.documentId)) {
        throw new Error('Notebook document has changed');
    }
    return { frames, top, tabId: sender.tab.id };
}

// 状態だけを直列に保存する。翻訳応答を待つ間も停止・復元を受け付ける。
async function updateNotebookSession(context, update) {
    const key = `notebookSession:${context.tabId}`;
    const prior = notebookSessionWrites.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
        const data = await chrome.storage.session.get(key);
        let session = data[key];
        if (session?.url !== context.top.url || session?.documentId !== context.top.documentId) session = null;
        const result = await update(session);
        if (result) await chrome.storage.session.set({ [key]: result });
        return result;
    });
    notebookSessionWrites.set(key, next);
    try { return await next; }
    finally { if (notebookSessionWrites.get(key) === next) notebookSessionWrites.delete(key); }
}

function newNotebookSession(context, message) {
    return { url: context.top.url, documentId: context.top.documentId,
        id: crypto.randomUUID(), action: message.action,
        targetLang: message.targetLang || '日本語', batchMaxChars: resolveBatchMaxChars(message.batchMaxChars), contextAwareParallel: !!message.contextAwareParallel, contextParallelism: normalizeContextParallelism(message.contextParallelism) };
}

async function sendNotebookSession(context, frame, session) {
    // 保存後に別の操作やナビゲーションへ移った場合、古い開始指示は送らない。
    const key = `notebookSession:${context.tabId}`;
    const latest = (await chrome.storage.session.get(key))[key];
    if (latest?.id !== session.id) return { success: true, outcome: 'cancelled' };
    return chrome.tabs.sendMessage(context.tabId, {
        type: session.action === 'START_TRANSLATION' ? 'START_NOTEBOOK_TRANSLATION' : session.action,
        targetLang: session.targetLang, batchMaxChars: session.batchMaxChars, contextAwareParallel: !!session.contextAwareParallel, contextParallelism: normalizeContextParallelism(session.contextParallelism),
        notebookSessionId: session.id, notebookHost: new URL(context.top.url).hostname
    }, frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId });
}

async function handleNotebookControl(message, sender) {
    if (sender.frameId !== 0 || !['START_TRANSLATION', 'CANCEL_TRANSLATION', 'RESTORE_ORIGINAL', 'GET_TRANSLATION_STATE'].includes(message.action)) {
        throw new Error('Invalid notebook control');
    }
    const context = await notebookContext(sender);
    const frames = context.frames.filter(f => f.frameId !== 0 && isKaggleNotebookFrameUrl(f.url));
    if (message.action === 'GET_TRANSLATION_STATE') {
        const results = await Promise.allSettled(frames.map(frame => chrome.tabs.sendMessage(context.tabId,
            { type: 'GET_TRANSLATION_STATE' }, frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId })));
        const states = results.filter(r => r.status === 'fulfilled').map(r => r.value);
        return { success: true, isTranslating: states.some(s => s?.isTranslating), isTranslated: states.some(s => s?.isTranslated) };
    }
    const session = await updateNotebookSession(context, () => newNotebookSession(context, message));
    const results = await Promise.allSettled(frames.map(f => sendNotebookSession(context, f, session)));
    const failed = results.find(r => r.status === 'rejected' || !r.value?.success);
    if (failed) throw new Error(failed.reason?.message || failed.value?.error || 'ノートブックの翻訳に失敗しました');
    return { success: true, frames: frames.length };
}

async function handleNotebookReady(sender) {
    if (!sender.frameId || !isKaggleNotebookFrameUrl(sender.url)) throw new Error('Invalid notebook frame');
    const context = await notebookContext(sender);
    const session = await updateNotebookSession(context, async current => {
        if (current) return current;
        const settings = await settingsStorage.get(['autoTranslate', 'targetLang', 'batchMaxChars', 'contextAwareParallel', 'contextParallelism']);
        if (!settings.autoTranslate) return null;
        return newNotebookSession(context, { ...settings, action: 'START_TRANSLATION' });
    });
    if (!session || session.action !== 'START_TRANSLATION') return { success: true, skipped: true };
    const frame = context.frames.find(f => f.frameId === sender.frameId);
    return sendNotebookSession(context, frame, session);
}

if (chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(`notebookSession:${tabId}`).catch(() => {}));
}

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'NOTEBOOK_CONTROL' || message.type === 'NOTEBOOK_FRAME_READY') {
        const task = message.type === 'NOTEBOOK_CONTROL'
            ? handleNotebookControl(message, sender) : handleNotebookReady(sender);
        task.then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.type === 'TRANSLATE') {
        handleTranslate(message, sendResponse, sender);
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

// Reservations are made synchronously before any API await. Overlapping batches
// share individual results while new items still use the provider's batch API.
// One network queue for all tabs/providers, including provider retries and fallbacks.
let translationNetworkLimit = 3;
let translationNetworkActive = 0;
let routeSequence = 0;
const translationNetworkQueue = [];
const translationRoutes = new Map();
const translationDocuments = new Map();
function retireTranslationRoute(tabId, url, force = false) {
    let key;
    try { key = translationPageKey(url); } catch { key = null; }
    const previous = translationRoutes.get(tabId);
    if (!force && previous?.key === key) return;
    translationRoutes.set(tabId, { key, priority: ++routeSequence });
    drainTranslationNetwork();
    chrome.tabs.sendMessage(tabId, { type: 'TRANSLATION_PAGE_CHANGED', pageKey: key }).catch(() => {});
}
function translationConsumer(sender, message) {
    const tabId = sender.tab?.id;
    if (tabId == null) return Object.assign(() => true, { priority: ++routeSequence });
    if (!translationRoutes.has(tabId)) {
        let key = null;
        try { key = translationPageKey(sender.tab.url || sender.url); } catch {}
        translationRoutes.set(tabId, { key, priority: ++routeSequence });
    }
    const route = translationRoutes.get(tabId);
    const documents = translationDocuments.get(tabId);
    const documentId = sender.documentId;
    const frameId = sender.frameId || 0;
    let matches = true;
    if (sender.frameId === 0 && message.sourcePageUrl) {
        try { matches = translationPageKey(message.sourcePageUrl) === route.key; } catch { matches = false; }
    }
    return Object.assign(() => matches && translationRoutes.get(tabId) === route &&
        (!documentId || !documents?.has(frameId) || documents.get(frameId) === documentId), { priority: route.priority });
}
function staleTranslationError() {
    return Object.assign(new Error('旧ページの未送信リクエストを停止しました'), { name: 'StaleTranslationError' });
}
function drainTranslationNetwork() {
    for (let i = translationNetworkQueue.length - 1; i >= 0; i--) {
        if (!translationNetworkQueue[i].isNeeded()) translationNetworkQueue.splice(i, 1)[0].reject(staleTranslationError());
    }
    const priorityOf = job => typeof job.priority === 'function' ? job.priority() : job.priority;
    translationNetworkQueue.sort((a, b) => priorityOf(b) - priorityOf(a));
    while (translationNetworkActive < translationNetworkLimit && translationNetworkQueue.length) {
        const job = translationNetworkQueue.shift();
        translationNetworkActive++;
        Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
            translationNetworkActive--;
            drainTranslationNetwork();
        });
    }
}
function scheduledTranslationFetch(url, init, timeout = 60000, isNeeded, priority) {
    return new Promise((resolve, reject) => {
        translationNetworkQueue.push({ resolve, reject, isNeeded, priority, run: async () => {
            if (!isNeeded()) throw staleTranslationError();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                // The provider's timer may expire while queued. Start a fresh timeout
                // at actual dispatch, and retain the slot until the response body arrives.
                const { requestFetch, signal, ...requestInit } = init;
                const response = await fetch(url, { ...requestInit, signal: controller.signal });
                await response.clone().arrayBuffer();
                return response;
            } finally { clearTimeout(timer); }
        }});
        drainTranslationNetwork();
    });
}

const pendingTranslations = new Map();
async function shareTranslationBatch(keys, run, consumer = () => true) {
    const owned = [];
    const waits = keys.map((key, index) => {
        if (pendingTranslations.has(key)) {
            pendingTranslations.get(key).consumers.add(consumer);
            return pendingTranslations.get(key).promise;
        }
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        pendingTranslations.set(key, { promise, resolve, reject, consumers: new Set([consumer]) });
        owned.push({ key, index, resolve, reject });
        return promise;
    });
    const result = Promise.all(waits);
    if (owned.length) {
        const activeConsumers = () => owned.flatMap(item =>
            [...(pendingTranslations.get(item.key)?.consumers || [])]).filter(isActive => isActive());
        const isNeeded = () => activeConsumers().length > 0;
        const priority = () => Math.max(0, ...activeConsumers().map(isActive => isActive.priority || 0));
        Promise.resolve().then(() => run(owned.map(item => item.index), isNeeded, priority)).then(values => {
            owned.forEach((item, i) => item.resolve(values[i] ?? null));
        }, error => owned.forEach(item => item.reject(error))).finally(() => {
            owned.forEach(item => pendingTranslations.delete(item.key));
        });
    }
    return result;
}
function translationScope(provider, model, sourceLang, endpoint, context, role) {
    return JSON.stringify([provider, model, sourceLang, endpoint,
        context?.hostname || '', context?.pathname || '', context?.title || '',
        context?.pageLang || '', context?.reference || '', role || 'body']);
}

async function handleTranslate(message, sendResponse, sender = {}) {
    const consumer = translationConsumer(sender, message);
    let translationError = '';
    let previewPromise = null, previewController = null, previewTimer = null;
    const stopPreview = () => {
        if (previewTimer !== null) clearTimeout(previewTimer);
        previewController?.abort();
    };
    try {
        const { texts, targetLang, roles, pageContext, host } = message;
        // 旧 groq クリーンアップと設定取得を並列化（どちらも storage IO）
        const [, settings] = await Promise.all([
            cleanupRemovedProviderSettings(),
            getTranslateSettings()
        ]);
        translationNetworkLimit = settings.contextAwareParallel ? normalizeContextParallelism(settings.contextParallelism) : 3;
        const provider = normalizeProvider(settings.apiProvider);
        const verboseLog = !!settings.verboseLog;

        let apiKey, model;
        if (provider === 'openrouter') {
            apiKey = settings.openrouterApiKey;
            model = settings.openrouterModel || 'google/gemini-2.0-flash-exp:free';
        } else if (provider === 'lmstudio') {
            apiKey = settings.lmstudioEndpoint || 'http://localhost:1234';
            model = settings.lmstudioModel || 'mlx-community/Hy-MT2-1.8B-4bit';
        } else if (provider === 'sambanova') {
            apiKey = settings.sambanovaApiKey;
            model = settings.sambanovaModel || 'DeepSeek-V3.1';
        } else if (provider === 'nvidia') {
            apiKey = settings.nvidiaApiKey;
            model = settings.nvidiaModel || 'meta/llama-3.1-70b-instruct';
            if (model === 'nvidia/nemotron-3-super-120b-a12b') {
                // このモデルは翻訳用途で遅延が大きいためデフォルト推奨モデルへフォールバック
                await logger.warn('background', `NVIDIAモデル ${model} は高遅延のため meta/llama-3.1-70b-instruct に自動切替`);
                model = 'meta/llama-3.1-70b-instruct';
            }
        } else if (provider === 'cerebras') {
            apiKey = settings.cerebrasApiKey;
            model = settings.cerebrasModel || 'llama-3.3-70b';
        } else if (provider === 'plamo') {
            apiKey = settings.plamoApiKey;
            model = settings.plamoModel || 'plamo-2.0-prime';
        } else if (provider === 'opencodego') {
            apiKey = settings.opencodeGoApiKey;
            model = settings.opencodeGoModel || 'qwen3.5-plus';
        } else if (provider === 'lolipop') {
            apiKey = settings.lolipopApiKey;
            model = settings.lolipopModel;
        } else {
            apiKey = settings.apiKey;
            model = settings.model || 'gemini-2.0-flash';
        }

        if (!apiKey) {
            const err = provider === 'lmstudio'
                ? 'ローカルAPIのエンドポイントが設定されていません。'
                : 'APIキーが設定されていません。ポップアップから設定してください。';
            logger.error('background', err);
            sendResponse({ success: false, error: err });
            return;
        }

        if (provider === 'lmstudio') {
            model = await resolveLocalApiModel(apiKey, model);
        }
        if (provider === 'lolipop' && !model) {
            sendResponse({ success: false, error: 'ロリポップ！AI Gatewayのモデル一覧を取得し、モデルを選択して設定を保存してください。' });
            return;
        }

        const lmstudioSourceLang = settings.lmstudioSourceLang || 'en';
        const scopes = texts.map((_, i) => translationScope(provider, model,
            provider === 'lmstudio' ? lmstudioSourceLang : '',
            provider === 'lmstudio' ? apiKey : '', pageContext, roles?.[i]));


        // 1層目: メモリキャッシュチェック（I/Oなし・最速）
        const memoryCached = new Map(); // index -> translated
        const memoryMissIndices = [];
        for (let i = 0; i < texts.length; i++) {
            const key = makeMemoryCacheKey(texts[i], JSON.stringify([targetLang, scopes[i]]), host);
            const cachedValue = memoryCache.get(key);
            if (isValidTranslatedText(cachedValue)) {
                memoryCached.set(i, cachedValue);
            } else {
                if (memoryCache.has(key)) memoryCache.delete(key);
                memoryMissIndices.push(i);
            }
        }
        if (memoryCached.size > 0) {
            logger.info('background', `メモリキャッシュヒット: ${memoryCached.size}/${texts.length}件`);
            const hitIndices = [...memoryCached.keys()];
            try {
                const stats = await touchBatchCache(hitIndices.map(i => texts[i]), targetLang, host, hitIndices.map(i => scopes[i]));
                if (stats?.evicted) logger.info('background', `キャッシュ容量超過による削除: ${stats.evicted}件`);
            }
            catch (error) { logger.warn('background', `キャッシュ最終使用時刻の保存失敗: ${error.message}`); }
        }

        // 2層目: storage.local キャッシュチェック（メモリミス分のみ）
        const storageCached = new Map(); // index -> translated
        let storageUncachedIndices = memoryMissIndices;
        if (memoryMissIndices.length > 0) {
            const memoryMissTexts = memoryMissIndices.map(i => texts[i]);
            const { cached: storageCacheResult, uncached, touchError, touchEvicted } = await checkBatchCache(memoryMissTexts, targetLang, host, memoryMissIndices.map(i => scopes[i]));
            if (touchEvicted) logger.info('background', `キャッシュ容量超過による削除: ${touchEvicted}件`);
            if (touchError) logger.warn('background', `キャッシュ最終使用時刻の保存失敗: ${touchError}`);
            if (storageCacheResult.size > 0) {
                logger.info('background', `ストレージキャッシュヒット: ${storageCacheResult.size}/${memoryMissTexts.length}件`);
            }


            // storage ヒット分を元のインデックスに戻しつつメモリキャッシュにウォームアップ
            const invalidStorageIndices = [];
            for (const [localIdx, translated] of storageCacheResult) {
                const originalIdx = memoryMissIndices[localIdx];
                const key = makeMemoryCacheKey(texts[originalIdx], JSON.stringify([targetLang, scopes[originalIdx]]), host);
                if (isValidTranslatedText(translated)) {
                    storageCached.set(originalIdx, translated);
                } else {
                    invalidStorageIndices.push(originalIdx);
                    if (memoryCache.has(key)) memoryCache.delete(key);
                    continue;
                }
                if (memoryCache.size < MEMORY_CACHE_MAX) {
                    memoryCache.set(key, translated);
                }
            }
            storageUncachedIndices = [
                ...uncached.map(localIdx => memoryMissIndices[localIdx]),
                ...invalidStorageIndices
            ];
            if (invalidStorageIndices.length > 0) {
                logger.warn('background', `無効なストレージキャッシュを再翻訳対象にしました: ${invalidStorageIndices.length}件`);
            }
        }

        logger.info('background', `キャッシュ統計: メモリ=${memoryCached.size} / ストレージ=${storageCached.size} / 未ヒット=${storageUncachedIndices.length} / 合計=${texts.length} / ヒット率=${Math.round(100 * (memoryCached.size + storageCached.size) / Math.max(1, texts.length))}%`);

        // API 呼び出し（両キャッシュともミスした分のみ）
        let apiTranslations = [];
        if (storageUncachedIndices.length > 0) {
            const uncachedTexts = storageUncachedIndices.map(i => texts[i]);
            if (settings.googlePreviewEnabled && settings.googleTranslateApiKey &&
                message.previewRequestId && sender.tab?.id != null && consumer()) {
                previewController = new AbortController();
                // Bound the whole preview operation, including queueing and response bodies.
                previewTimer = setTimeout(() => previewController.abort(), 8000);
                const destination = sender.documentId
                    ? { documentId: sender.documentId } : { frameId: sender.frameId || 0 };
                previewPromise = translateGooglePreview(uncachedTexts, targetLang, settings.googleTranslateApiKey, {
                    signal: previewController.signal, isNeeded: consumer,
                    onChunk: entries => {
                        if (!consumer() || previewController.signal.aborted) return;
                        return chrome.tabs.sendMessage(sender.tab.id, {
                            type: 'TRANSLATION_PREVIEW', requestId: message.previewRequestId,
                            entries: entries.filter(entry => isValidTranslatedText(entry.text))
                                .map(entry => ({ index: storageUncachedIndices[entry.index], text: entry.text }))
                        }, destination).catch(() => {});
                    }
                }).catch(() => {
                    if (!previewController.signal.aborted) {
                        logger.warn('background', 'Google仮翻訳に失敗しました。Google CloudのAPIキー・API有効化・割り当てを確認してください。LLM翻訳を継続します。');
                    }
                });
            }
            const uncachedRoles = Array.isArray(roles)
                ? storageUncachedIndices.map(i => roles[i] || 'body')
                : undefined;
            logger.info('background', `翻訳開始: ${uncachedTexts.length}件, 言語=${targetLang}, プロバイダー=${provider}, モデル=${model}`);
            const apiStartTime = Date.now();
            const translateBatch = getTranslateBatch(provider);
            // Gatewayの料金を別プロバイダーの同名モデルの価格と混同しない。
            const onUsage = (usage) => recordUsage(provider === 'lolipop' ? `lolipop/${usage.model || model}` : model, usage.inputTokens, usage.outputTokens);
            const promptOptions = { roles: uncachedRoles, pageContext: pageContext || null,
                onDiagnostic: detail => {
                    if (detail.event === 'translation-error' && detail.message) translationError = detail.message;
                    logger.warn('background', `${provider}応答診断: ${JSON.stringify(detail)}`);
                } };
            const sharedKeys = storageUncachedIndices.map(i =>
                makeMemoryCacheKey(texts[i], JSON.stringify([targetLang, scopes[i]]), host));
            apiTranslations = await shareTranslationBatch(sharedKeys, async (indices, isNeeded, priority) => {
                const requestFetch = (url, init, timeout) => scheduledTranslationFetch(url, init, timeout, isNeeded, priority);
                const ownedTexts = indices.map(i => uncachedTexts[i]);
                const ownedRoles = indices.map(i => uncachedRoles?.[i] || 'body');
                let translated;
                if (provider === 'lmstudio') {
                    translated = await translateLocalApiWithLimitedParallelism({
                        translateBatch, texts: ownedTexts, targetLang, endpoint: apiKey,
                        model, onUsage, sourceLang: lmstudioSourceLang,
                        roles: ownedRoles, pageContext: promptOptions.pageContext, requestFetch
                    });
                } else {
                    translated = await translateBatch(ownedTexts, targetLang, apiKey, model,
                        onUsage, { ...promptOptions, roles: ownedRoles, requestFetch });
                }
                // Publish memory results before releasing reservations.
                indices.forEach((index, j) => {
                    if (isValidTranslatedText(translated[j]) && memoryCache.size < MEMORY_CACHE_MAX)
                        memoryCache.set(sharedKeys[index], translated[j]);
                });
                return translated;
            }, consumer);
            const apiElapsed = Date.now() - apiStartTime;

            const avgMs = uncachedTexts.length > 0 ? Math.round(apiElapsed / uncachedTexts.length) : 0;
            const nullCount = apiTranslations.filter(t => t == null).length;
            const invalidCount = apiTranslations.filter(t => t != null && !isValidTranslatedText(t)).length;
            if (invalidCount) {
                translationError ||= 'LLMの応答に翻訳用マーカーが残り、有効な訳文として扱えませんでした';
                logger.warn('background', `翻訳形式不正: ${invalidCount}/${apiTranslations.length}件（マーカー残留または空文字）`);
            }

            if (nullCount > 0) {
                logger.warn('background', `翻訳失敗: ${nullCount}/${apiTranslations.length}件がnull (プロバイダー=${provider}, モデル=${model})`);
            }
            logger.info(
                'background',
                `API応答: ${apiElapsed}ms (${uncachedTexts.length}件, 平均${avgMs}ms/件) プロバイダー=${provider}`,
                `モデル=${model}, 言語=${targetLang}`
            );

            // API結果をメモリキャッシュに保存
            for (let j = 0; j < storageUncachedIndices.length; j++) {
                const key = makeMemoryCacheKey(texts[storageUncachedIndices[j]], JSON.stringify([targetLang, scopes[storageUncachedIndices[j]]]), host);
                const translated = apiTranslations[j];
                if (isValidTranslatedText(translated)) {
                    if (memoryCache.size < MEMORY_CACHE_MAX) {
                        memoryCache.set(key, translated);
                    }
                } else if (memoryCache.has(key)) {
                    memoryCache.delete(key);
                }
            }

            // 保存結果を確定してから応答する。失敗しても翻訳結果は返す。
            const savedCount = apiTranslations.filter(isValidTranslatedText).length;
            const cacheableTranslations = apiTranslations.map(t => isValidTranslatedText(t) ? t : null);
            await saveBatchToCache(uncachedTexts, targetLang, cacheableTranslations, host, storageUncachedIndices.map(i => scopes[i]))
                .then(stats => logger.info('background', `キャッシュ保存完了: ${stats?.saved ?? savedCount}件 / 容量超過による削除=${stats?.evicted ?? 0}件 / 大きすぎる項目=${stats?.skipped ?? 0}件 / サイト容量=${((stats?.bytes ?? 0) / 1024 / 1024).toFixed(2)}MiB / 20MiB`))
                .catch(e => logger.error('background', `キャッシュ保存エラー: ${e.message}`));
        }

        // 全キャッシュ・API結果をマージ
        const translatedTexts = new Array(texts.length);
        const apiByOriginalIndex = new Map(storageUncachedIndices.map((index, j) => [index, apiTranslations[j]]));
        for (let i = 0; i < texts.length; i++) {
            if (memoryCached.has(i)) {
                translatedTexts[i] = memoryCached.get(i);
            } else if (storageCached.has(i)) {
                translatedTexts[i] = storageCached.get(i);
            } else {
                const translated = apiByOriginalIndex.get(i);
                translatedTexts[i] = isValidTranslatedText(translated) ? translated : null;
            }
        }

        const translatedCount = translatedTexts.filter(isValidTranslatedText).length;
        // A failed/partial LLM response may still benefit from the bounded preview.
        if (translatedCount < texts.length && previewPromise) await previewPromise;
        stopPreview();
        if (translatedCount === 0) {
            const err = translationError || `${provider} から有効な翻訳結果を取得できませんでした（モデル=${model}）`;
            logger.error('background', err);
            sendResponse({ success: false, error: err });
            return;
        }

        sendResponse({ success: true, translatedTexts,
            ...(translatedCount < texts.length && translationError ? { error: translationError } : {}) });

    } catch (error) {
        if (previewPromise) await previewPromise;
        stopPreview();
        logger.error('background', `翻訳エラー: ${error.message}`, error.stack);
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

/** Coalesce load/history events; ordinary anchors are not new pages.
 * Keep #/ and #! routes for apps that actually route through the fragment. */
function translationPageKey(url) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (!/^#(?:\/|!)/.test(parsed.hash)) parsed.hash = '';
    return parsed.href;
}
const automaticStarts = new Map();
async function scheduleAutomaticTranslation(tabId, url) {
    let pageKey;
    try { pageKey = translationPageKey(url); } catch { return; }
    if (!pageKey || automaticStarts.get(tabId)?.pageKey === pageKey) return;
    const request = { pageKey };
    automaticStarts.set(tabId, request);
    try {
        const settings = await settingsStorage.get(['targetLang', 'autoTranslate', 'batchMaxChars', 'contextAwareParallel', 'contextParallelism']);
        if (!settings.autoTranslate || !await getActiveProviderCredential()) {
            if (automaticStarts.get(tabId) === request) automaticStarts.delete(tabId);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 800));
        if (automaticStarts.get(tabId) !== request) return;
        const tab = await chrome.tabs.get(tabId);
        if (translationPageKey(tab.url) !== pageKey) return;
        await ensureContentScript(tabId);
        if (automaticStarts.get(tabId) !== request) return;
        await logger.info('background', `自動翻訳開始: ${pageKey}`);
        await chrome.tabs.sendMessage(tabId, {
            type: 'START_TRANSLATION', automatic: true, pageKey,
            targetLang: settings.targetLang || '日本語',
            batchMaxChars: resolveBatchMaxChars(settings.batchMaxChars),
            contextAwareParallel: !!settings.contextAwareParallel,
            contextParallelism: normalizeContextParallelism(settings.contextParallelism)
        }, { frameId: 0 });
    } catch (error) {
        if (automaticStarts.get(tabId) === request) automaticStarts.delete(tabId);
        await logger.error('background', `自動翻訳開始エラー: ${error.message}`);
    }
}
chrome.webNavigation.onCommitted?.addListener(details => {
    if (details.frameId === 0) translationDocuments.set(details.tabId, new Map());
    if (details.documentId) {
        if (!translationDocuments.has(details.tabId)) translationDocuments.set(details.tabId, new Map());
        translationDocuments.get(details.tabId).set(details.frameId, details.documentId);
    }
    if (details.frameId === 0) {
        automaticStarts.delete(details.tabId);
        retireTranslationRoute(details.tabId, details.url, true);
    }
});
chrome.tabs.onRemoved?.addListener(tabId => {
    automaticStarts.delete(tabId);
    translationRoutes.delete(tabId);
    translationDocuments.delete(tabId);
    drainTranslationNetwork();
});
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
    if (details.frameId === 0) {
        retireTranslationRoute(details.tabId, details.url);
        return scheduleAutomaticTranslation(details.tabId, details.url);
    }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) return scheduleAutomaticTranslation(tabId, tab.url);
});
