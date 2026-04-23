/**
 * Popup Script
 * ポップアップUIのロジック
 */

// DOM要素の取得
const elements = {
    apiProvider: document.getElementById('api-provider'),
    // Gemini
    geminiKeyField: document.getElementById('gemini-key-field'),
    apiKey: document.getElementById('api-key'),
    toggleKey: document.getElementById('toggle-key'),
    toggleIcon: document.getElementById('toggle-icon'),
    keyStatus: document.getElementById('key-status'),
    geminiModelField: document.getElementById('gemini-model-field'),
    modelSelect: document.getElementById('model-select'),
    geminiRefresh: document.getElementById('gemini-refresh'),
    // OpenRouter
    openrouterKeyField: document.getElementById('openrouter-key-field'),
    openrouterApiKey: document.getElementById('openrouter-api-key'),
    toggleOpenrouterKey: document.getElementById('toggle-openrouter-key'),
    toggleOpenrouterIcon: document.getElementById('toggle-openrouter-icon'),
    openrouterKeyStatus: document.getElementById('openrouter-key-status'),
    openrouterModelField: document.getElementById('openrouter-model-field'),
    openrouterModelSelect: document.getElementById('openrouter-model-select'),
    // SambaNova
    sambanovaKeyField: document.getElementById('sambanova-key-field'),
    sambanovaApiKey: document.getElementById('sambanova-api-key'),
    toggleSambanovaKey: document.getElementById('toggle-sambanova-key'),
    toggleSambanovaIcon: document.getElementById('toggle-sambanova-icon'),
    sambanovaKeyStatus: document.getElementById('sambanova-key-status'),
    sambanovaModelField: document.getElementById('sambanova-model-field'),
    sambanovaModelSelect: document.getElementById('sambanova-model-select'),
    sambanovaRefresh: document.getElementById('sambanova-refresh'),
    // LM Studio
    lmstudioEndpointField: document.getElementById('lmstudio-endpoint-field'),
    lmstudioEndpoint: document.getElementById('lmstudio-endpoint'),
    lmstudioKeyStatus: document.getElementById('lmstudio-key-status'),
    lmstudioModelField: document.getElementById('lmstudio-model-field'),
    lmstudioModelSelect: document.getElementById('lmstudio-model-select'),
    lmstudioRefresh: document.getElementById('lmstudio-refresh'),
    lmstudioSourceLangField: document.getElementById('lmstudio-source-lang-field'),
    lmstudioSourceLang: document.getElementById('lmstudio-source-lang'),
    // 共通
    targetLang: document.getElementById('target-lang'),
    batchSize: document.getElementById('batch-size'),
    saveSettings: document.getElementById('save-settings'),
    autoTranslate: document.getElementById('auto-translate'),
    verboseLog: document.getElementById('verbose-log'),
    translateBtn: document.getElementById('translate-btn'),
    cancelBtn: document.getElementById('cancel-btn'),
    restoreBtn: document.getElementById('restore-btn'),
    progressContainer: document.getElementById('progress-container'),
    progressText: document.getElementById('progress-text'),
    progressPercent: document.getElementById('progress-percent'),
    progressFill: document.getElementById('progress-fill'),
    statusMessage: document.getElementById('status-message'),
    toggleLogs: document.getElementById('toggle-logs'),
    logViewer: document.getElementById('log-viewer'),
    logList: document.getElementById('log-list'),
    clearLogs: document.getElementById('clear-logs'),
    toggleUsage: document.getElementById('toggle-usage'),
    usageViewer: document.getElementById('usage-viewer'),
    usageContent: document.getElementById('usage-content'),
    clearUsage: document.getElementById('clear-usage'),
    clearCache: document.getElementById('clear-cache'),
    cacheSitesPanel: document.getElementById('cache-sites-panel'),
    toggleCacheSites: document.getElementById('toggle-cache-sites'),
    cacheSitesList: document.getElementById('cache-sites-list')
};

// ログフィルター状態
const logFilter = {
    levels: new Set(['INFO', 'WARN', 'ERROR']),
    source: 'all'
};

// 取得済みログのキャッシュ（フィルター再適用用）
let allFetchedLogs = [];
const settingsStorage = chrome.storage.local;
const MESSAGE_TIMEOUT_MS = 30000;

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

// 初期化
document.addEventListener('DOMContentLoaded', init);

async function init() {
    // 保存済み設定を読み込む
    await loadSettings();

    // 現在のタブの翻訳状態を確認
    await checkTranslationState();

    // イベントリスナーの設定
    setupEventListeners();
}

/**
 * 保存済み設定を読み込む
 */
async function loadSettings() {
    try {
        await cleanupRemovedProviderSettings();
        const result = await settingsStorage.get([
            'apiKey', 'openrouterApiKey', 'apiProvider',
            'targetLang', 'model', 'openrouterModel', 'sambanovaApiKey', 'sambanovaModel',
            'lmstudioEndpoint', 'lmstudioModel', 'lmstudioSourceLang',
            'autoTranslate', 'batchMaxChars', 'verboseLog'
        ]);

        // プロバイダー設定
        const provider = normalizeProvider(result.apiProvider);
        elements.apiProvider.value = provider;
        updateProviderUI(provider);

        if (result.apiKey) {
            elements.apiKey.value = result.apiKey;
        }

        if (result.openrouterApiKey) {
            elements.openrouterApiKey.value = result.openrouterApiKey;
        }

        if (result.sambanovaApiKey) {
            elements.sambanovaApiKey.value = result.sambanovaApiKey;
        }

        if (result.lmstudioEndpoint) {
            elements.lmstudioEndpoint.value = result.lmstudioEndpoint;
        }

        if (result.lmstudioSourceLang) {
            elements.lmstudioSourceLang.value = result.lmstudioSourceLang;
        }

        // 有効なクレデンシャルがあれば翻訳ボタンを有効化
        let activeKey;
        if (provider === 'openrouter') activeKey = result.openrouterApiKey;
        else if (provider === 'sambanova') activeKey = result.sambanovaApiKey;
        else if (provider === 'lmstudio') activeKey = result.lmstudioEndpoint || elements.lmstudioEndpoint.value;
        else activeKey = result.apiKey;
        if (activeKey) {
            elements.translateBtn.disabled = false;
        }

        if (result.targetLang) {
            elements.targetLang.value = result.targetLang;
        }

        if (provider === 'gemini' && result.apiKey) {
            await loadGeminiModels(result.apiKey, result.model);
        } else if (result.model && [...elements.modelSelect.options].some(o => o.value === result.model)) {
            elements.modelSelect.value = result.model;
        }

        if (provider === 'openrouter') {
            await loadOpenRouterModels(result.openrouterModel);
        } else if (result.openrouterModel && [...elements.openrouterModelSelect.options].some(o => o.value === result.openrouterModel)) {
            elements.openrouterModelSelect.value = result.openrouterModel;
        }

        if (provider === 'sambanova') {
            await loadSambaNovaModels(result.sambanovaModel);
        } else if (result.sambanovaModel && [...elements.sambanovaModelSelect.options].some(o => o.value === result.sambanovaModel)) {
            elements.sambanovaModelSelect.value = result.sambanovaModel;
        }

        if (provider === 'lmstudio') {
            await loadLMStudioModels(result.lmstudioModel);
        }

        if (result.batchMaxChars !== undefined) {
            elements.batchSize.value = String(result.batchMaxChars);
        }

        elements.autoTranslate.checked = !!result.autoTranslate;
        elements.verboseLog.checked = !!result.verboseLog;
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

/**
 * プロバイダーに応じてUIの表示/非表示を切り替える
 */
function updateProviderUI(provider) {
    const isOpenRouter = provider === 'openrouter';
    const isSambaNova = provider === 'sambanova';
    const isLMStudio = provider === 'lmstudio';
    const isGemini = provider === 'gemini';

    elements.geminiKeyField.classList.toggle('hidden', !isGemini);
    elements.geminiModelField.classList.toggle('hidden', !isGemini);
    elements.openrouterKeyField.classList.toggle('hidden', !isOpenRouter);
    elements.openrouterModelField.classList.toggle('hidden', !isOpenRouter);
    elements.sambanovaKeyField.classList.toggle('hidden', !isSambaNova);
    elements.sambanovaModelField.classList.toggle('hidden', !isSambaNova);
    elements.lmstudioEndpointField.classList.toggle('hidden', !isLMStudio);
    elements.lmstudioModelField.classList.toggle('hidden', !isLMStudio);
    elements.lmstudioSourceLangField.classList.toggle('hidden', !isLMStudio);
}

const GEMINI_FALLBACK_MODELS = [
    { id: 'gemini-2.0-flash',              name: 'Gemini 2.0 Flash（高速）' },
    { id: 'gemini-2.0-flash-lite',         name: 'Gemini 2.0 Flash Lite（最速）' },
    { id: 'gemini-2.5-flash-preview-04-17',name: 'Gemini 2.5 Flash Preview' },
    { id: 'gemini-2.5-pro-preview-05-06',  name: 'Gemini 2.5 Pro（高精度）' },
];

/**
 * Gemini API からモデル一覧を取得してドロップダウンを構築する
 */
async function loadGeminiModels(apiKey, savedModel) {
    const select = elements.modelSelect;
    if (!apiKey) {
        showKeyStatus('APIキーを入力してください', 'error');
        return;
    }

    const btn = elements.geminiRefresh;
    const btnText = btn?.querySelector('.btn-text');
    if (btn) { btn.disabled = true; if (btnText) btnText.textContent = '🔄 取得中…'; }

    try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`,
            { signal: controller.signal }
        );
        clearTimeout(tid);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const NON_TEXT_RE = /embedding|imagen|veo|aqa|tts|speech|vision-only/i;
        const models = (data.models || [])
            .filter(m => Array.isArray(m.supportedGenerationMethods) &&
                         m.supportedGenerationMethods.includes('generateContent') &&
                         !NON_TEXT_RE.test(m.name))
            .map(m => ({
                id: m.name.replace(/^models\//, ''),
                name: m.displayName || m.name.replace(/^models\//, '')
            }))
            .sort((a, b) => a.id.localeCompare(b.id));

        if (models.length === 0) throw new Error('利用可能なモデルが見つかりません');

        select.innerHTML = '';
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            select.appendChild(opt);
        });

        const target = savedModel || 'gemini-2.0-flash';
        if ([...select.options].some(o => o.value === target)) {
            select.value = target;
        }

        showKeyStatus(`✅ ${models.length}件のモデルを取得しました`, 'success');
    } catch (err) {
        // フォールバック: ハードコードリストを使用
        const currentVal = select.value;
        if (select.options.length === 0) {
            select.innerHTML = '';
            GEMINI_FALLBACK_MODELS.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.name;
                select.appendChild(opt);
            });
            const target = savedModel || 'gemini-2.0-flash';
            if ([...select.options].some(o => o.value === target)) select.value = target;
        } else if (currentVal) {
            select.value = currentVal;
        }
        showKeyStatus(`⚠️ モデル一覧の取得に失敗: ${err.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; if (btnText) btnText.textContent = '🔄 APIキーでモデル一覧を取得'; }
    }
}

/**
 * LM Studio のモデル一覧を取得してドロップダウンを構築する
 */
async function loadLMStudioModels(savedModel) {
    const select = elements.lmstudioModelSelect;
    const endpoint = (elements.lmstudioEndpoint.value || 'http://localhost:1234').replace(/\/+$/, '');

    try {
        const response = await fetch(`${endpoint}/v1/models`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const models = (data.data || []).filter(m => (m.type === 'llm' || !m.type));

        select.innerHTML = '';
        if (models.length === 0) {
            const opt = document.createElement('option');
            opt.value = 'translategemma-4b-it';
            opt.textContent = 'translategemma-4b-it (未ロード)';
            select.appendChild(opt);
        } else {
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                const state = m.state ? ` [${m.state}]` : '';
                opt.textContent = `${m.id}${state}`;
                select.appendChild(opt);
            });
        }

        if (savedModel && [...select.options].some(o => o.value === savedModel)) {
            select.value = savedModel;
        } else {
            const tg = [...select.options].find(o => /translategemma/i.test(o.value));
            if (tg) select.value = tg.value;
        }
        showLMStudioKeyStatus(`✅ ${models.length}件のモデルが見つかりました`, 'success');
    } catch (error) {
        select.innerHTML = '<option value="translategemma-4b-it">translategemma-4b-it</option>';
        if (savedModel) {
            const opt = document.createElement('option');
            opt.value = savedModel;
            opt.textContent = savedModel;
            select.appendChild(opt);
            select.value = savedModel;
        }
        showLMStudioKeyStatus(`⚠️ LM Studio に接続できません: ${error.message}`, 'error');
    }
}

const SAMBANOVA_FALLBACK_MODELS = [
    { id: 'DeepSeek-V3.1', name: 'DeepSeek-V3.1（推奨）' },
    { id: 'Meta-Llama-3.3-70B-Instruct', name: 'Meta-Llama-3.3-70B-Instruct' },
    { id: 'Meta-Llama-3.1-8B-Instruct', name: 'Meta-Llama-3.1-8B-Instruct' },
    { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
    { id: 'gpt-oss-120b', name: 'gpt-oss-120b' },
    { id: 'Qwen3-32B', name: 'Qwen3-32B' },
    { id: 'Llama-4-Maverick-17B-128E-Instruct', name: 'Llama-4-Maverick-17B-128E-Instruct' }
];

const SAMBANOVA_MODEL_PREFERENCE = [
    'DeepSeek-V3.1',
    'DeepSeek-R1-0528',
    'Meta-Llama-3.3-70B-Instruct',
    'Meta-Llama-3.1-8B-Instruct',
    'MiniMax-M2.5',
    'gpt-oss-120b',
    'Qwen3-32B',
    'Llama-4-Maverick-17B-128E-Instruct'
];

function isSambaNovaChatModel(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (!id) return false;
    if (id.includes('whisper')) return false;
    if (id.includes('e5-mistral')) return false;
    if (id.includes('embedding')) return false;
    return true;
}

function sortSambaNovaModels(models) {
    const order = new Map(SAMBANOVA_MODEL_PREFERENCE.map((id, index) => [id, index]));
    return [...models].sort((a, b) => {
        const ai = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
        const bi = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.id.localeCompare(b.id);
    });
}

async function loadSambaNovaModels(savedModel) {
    const select = elements.sambanovaModelSelect;
    select.innerHTML = '<option disabled selected>読み込み中...</option>';

    const apiKey = elements.sambanovaApiKey.value.trim();

    const applyModels = (models) => {
        select.innerHTML = '';
        models.forEach(model => {
            const opt = document.createElement('option');
            opt.value = model.id;
            opt.textContent = model.name || model.id;
            select.appendChild(opt);
        });

        if (savedModel && [...select.options].some(o => o.value === savedModel)) {
            select.value = savedModel;
        } else if (select.options.length > 0) {
            select.selectedIndex = 0;
        }
    };

    if (!apiKey) {
        applyModels(SAMBANOVA_FALLBACK_MODELS);
        return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch('https://api.sambanova.ai/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData?.error?.message || errData?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const models = sortSambaNovaModels((data.data || [])
            .filter(m => m.id && isSambaNovaChatModel(m.id))
            .map(m => ({ id: m.id, name: m.id }))
        );

        if (models.length === 0) {
            throw new Error('利用可能なチャットモデルがありません');
        }

        applyModels(models);
        showSambanovaKeyStatus(`✅ ${models.length}件のモデルを取得しました`, 'success');
    } catch (error) {
        clearTimeout(timeoutId);
        applyModels(SAMBANOVA_FALLBACK_MODELS);
        if (error.name !== 'AbortError') {
            showSambanovaKeyStatus(`⚠️ モデル取得失敗: ${error.message}`, 'error');
        }
    }
}

/**
 * 長すぎるモデル名をドロップダウン用に短縮する
 */
function truncateLabel(label, maxLength = 42) {
    if (label.length <= maxLength) {
        return label;
    }

    return `${label.slice(0, maxLength - 1)}…`;
}

/**
 * OpenRouterモデルの表示名をコンパクトに整形する
 */
function formatOpenRouterModelLabel(model) {
    const promptPrice = parseFloat(model.pricing?.prompt ?? '0') * 1_000_000;
    const displayName = (model.name || model.id)
        .replace(/^[^:]+:\s*/, '')
        .replace(/\s+\(free\)$/i, '');
    const priceLabel = promptPrice > 0 ? ` | $${promptPrice.toFixed(2)}/1M` : ' | 無料';

    return truncateLabel(`${displayName}${priceLabel}`);
}

/**
 * 選択中のOpenRouterモデルをツールチップに反映する
 */
function syncOpenRouterModelTitle() {
    const selectedOption = elements.openrouterModelSelect.selectedOptions[0];
    elements.openrouterModelSelect.title = selectedOption ? selectedOption.value : '';
}

async function loadOpenRouterModels(savedModel) {
    const select = elements.openrouterModelSelect;
    select.innerHTML = '<option disabled selected>読み込み中...</option>';

    try {
        const response = await fetch('https://openrouter.ai/api/v1/models');
        const data = await response.json();
        const models = (data.data || []).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

        const freeModels = models.filter(m => parseFloat(m.pricing?.prompt ?? '1') === 0);
        const paidModels = models.filter(m => parseFloat(m.pricing?.prompt ?? '1') > 0);

        select.innerHTML = '';

        // 無料モデルもプロバイダーごとにグループ化（同名モデルを区別するため）
        const freeProviderMap = {};
        freeModels.forEach(m => {
            const providerName = m.id.split('/')[0];
            if (!freeProviderMap[providerName]) freeProviderMap[providerName] = [];
            freeProviderMap[providerName].push(m);
        });

        Object.entries(freeProviderMap).sort().forEach(([providerName, list]) => {
            const group = document.createElement('optgroup');
            group.label = `${providerName}（無料）`;
            list.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = formatOpenRouterModelLabel(m);
                group.appendChild(opt);
            });
            select.appendChild(group);
        });

        // プロバイダーごとにグループ化（有料）
        const providerMap = {};
        paidModels.forEach(m => {
            const providerName = m.id.split('/')[0];
            if (!providerMap[providerName]) providerMap[providerName] = [];
            providerMap[providerName].push(m);
        });

        Object.entries(providerMap).sort().forEach(([providerName, list]) => {
            const group = document.createElement('optgroup');
            group.label = providerName;
            list.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = formatOpenRouterModelLabel(m);
                group.appendChild(opt);
            });
            select.appendChild(group);
        });

        // API一覧に含まれない追加モデルを補完
        const PROVIDER_MODELS = [
            { id: 'meta-llama/llama-4-scout', label: 'Llama 4 Scout 17B | $0.08/1M', group: 'meta-llama' },
            { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick 17B | $0.18/1M', group: 'meta-llama' },
        ];
        const existingIds = new Set([...select.options].map(o => o.value));
        const extraByGroup = {};
        PROVIDER_MODELS.forEach(m => {
            if (existingIds.has(m.id)) return;
            if (!extraByGroup[m.group]) extraByGroup[m.group] = [];
            extraByGroup[m.group].push(m);
        });
        Object.entries(extraByGroup).forEach(([groupName, list]) => {
            const group = document.createElement('optgroup');
            group.label = groupName;
            list.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.label;
                group.appendChild(opt);
            });
            select.appendChild(group);
        });

        // 保存済みモデルを復元
        if (savedModel && [...select.options].some(o => o.value === savedModel)) {
            select.value = savedModel;
        }
    } catch (error) {
        // フェッチ失敗時は静的フォールバック
        select.innerHTML = `
            <optgroup label="無料モデル">
                <option value="google/gemma-4-31b-it:free">Gemma 4 31B | 無料</option>
                <option value="google/gemma-4-26b-a4b-it:free">Gemma 4 26B A4B | 無料</option>
                <option value="nvidia/nemotron-3-super-120b-a12b:free">Nemotron 3 120B | 無料</option>
            </optgroup>
            <optgroup label="google">
                <option value="google/gemini-3.1-flash-lite-preview">Gemini 3.1 Flash Lite | $0.25/1M</option>
                <option value="google/gemini-3.1-pro-preview">Gemini 3.1 Pro | $2.00/1M</option>
            </optgroup>
            <optgroup label="anthropic">
                <option value="anthropic/claude-sonnet-4.6">Claude Sonnet 4.6 | $3.00/1M</option>
                <option value="anthropic/claude-opus-4.6">Claude Opus 4.6 | $5.00/1M</option>
            </optgroup>
            <optgroup label="openai">
                <option value="openai/gpt-5.4-mini">GPT-5.4 Mini | $0.75/1M</option>
                <option value="openai/gpt-5.4">GPT-5.4 | $2.50/1M</option>
            </optgroup>
            <optgroup label="meta-llama">
                <option value="meta-llama/llama-4-scout">Llama 4 Scout 17B | $0.08/1M</option>
                <option value="meta-llama/llama-4-maverick">Llama 4 Maverick 17B | $0.18/1M</option>
                <option value="meta-llama/llama-3.3-70b-instruct">Llama 3.3 70B | $0.12/1M</option>
            </optgroup>
        `;
        if (savedModel) select.value = savedModel;
    }

    syncOpenRouterModelTitle();
}

/**
 * 現在のタブの翻訳状態を確認
 */
async function checkTranslationState() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;

        const response = await chrome.tabs.sendMessage(tab.id, {
            type: 'GET_TRANSLATION_STATE'
        }).catch(() => null);

        if (response) {
            if (response.isTranslated) {
                elements.restoreBtn.classList.remove('hidden');
            }
            if (response.isTranslating) {
                setTranslating(true);
            }
        }
    } catch (error) {
        // Content script がまだ注入されていない場合は無視
    }
}

/**
 * イベントリスナーのセットアップ
 */
function setupEventListeners() {
    // プロバイダー切り替え
    elements.apiProvider.addEventListener('change', async () => {
        const provider = elements.apiProvider.value;
        updateProviderUI(provider);
        await settingsStorage.set({ apiProvider: provider });

        if (provider === 'gemini') {
            const saved = await settingsStorage.get(['apiKey', 'model']);
            if (saved.apiKey) await loadGeminiModels(saved.apiKey, saved.model);
        } else if (provider === 'openrouter') {
            const saved = await settingsStorage.get(['openrouterModel']);
            await loadOpenRouterModels(saved.openrouterModel);
        } else if (provider === 'sambanova') {
            const saved = await settingsStorage.get(['sambanovaModel']);
            await loadSambaNovaModels(saved.sambanovaModel);
        } else if (provider === 'lmstudio') {
            const saved = await settingsStorage.get(['lmstudioModel']);
            await loadLMStudioModels(saved.lmstudioModel);
        }

        // 翻訳ボタンの有効/無効を再評価
        const result = await settingsStorage.get(['apiKey', 'openrouterApiKey', 'sambanovaApiKey', 'lmstudioEndpoint']);
        let activeKey;
        if (provider === 'openrouter') activeKey = result.openrouterApiKey;
        else if (provider === 'sambanova') activeKey = result.sambanovaApiKey;
        else if (provider === 'lmstudio') activeKey = result.lmstudioEndpoint || elements.lmstudioEndpoint.value;
        else activeKey = result.apiKey;
        elements.translateBtn.disabled = !activeKey;
    });

    // Gemini モデル一覧の再取得
    elements.geminiRefresh.addEventListener('click', async () => {
        const saved = await settingsStorage.get(['apiKey', 'model']);
        await loadGeminiModels(saved.apiKey, saved.model);
    });

    // LM Studio モデル一覧の再取得
    elements.lmstudioRefresh.addEventListener('click', async () => {
        const btn = elements.lmstudioRefresh;
        btn.disabled = true;
        const originalText = btn.querySelector('.btn-text').textContent;
        btn.querySelector('.btn-text').textContent = '⏳ 取得中...';
        try {
            const saved = await settingsStorage.get(['lmstudioModel']);
            await loadLMStudioModels(saved.lmstudioModel);
        } finally {
            btn.querySelector('.btn-text').textContent = originalText;
            btn.disabled = false;
        }
    });

    // LM Studio エンドポイント変更時はモデル一覧を再取得
    elements.lmstudioEndpoint.addEventListener('change', async () => {
        const saved = await settingsStorage.get(['lmstudioModel']);
        await loadLMStudioModels(saved.lmstudioModel);
    });

    // APIキーの表示/非表示（Gemini）
    elements.toggleKey.addEventListener('click', () => {
        const isPassword = elements.apiKey.type === 'password';
        elements.apiKey.type = isPassword ? 'text' : 'password';
        elements.toggleIcon.textContent = isPassword ? '🔒' : '👁';
    });

    // APIキーの表示/非表示（OpenRouter）
    elements.toggleOpenrouterKey.addEventListener('click', () => {
        const isPassword = elements.openrouterApiKey.type === 'password';
        elements.openrouterApiKey.type = isPassword ? 'text' : 'password';
        elements.toggleOpenrouterIcon.textContent = isPassword ? '🔒' : '👁';
    });

    elements.toggleSambanovaKey.addEventListener('click', () => {
        const isPassword = elements.sambanovaApiKey.type === 'password';
        elements.sambanovaApiKey.type = isPassword ? 'text' : 'password';
        elements.toggleSambanovaIcon.textContent = isPassword ? '🔒' : '👁';
    });

    elements.sambanovaRefresh.addEventListener('click', async () => {
        const btn = elements.sambanovaRefresh;
        btn.disabled = true;
        const originalText = btn.querySelector('.btn-text').textContent;
        btn.querySelector('.btn-text').textContent = '⏳ 取得中...';
        try {
            const saved = await settingsStorage.get(['sambanovaModel']);
            await loadSambaNovaModels(saved.sambanovaModel);
        } finally {
            btn.querySelector('.btn-text').textContent = originalText;
            btn.disabled = false;
        }
    });

    elements.openrouterModelSelect.addEventListener('change', syncOpenRouterModelTitle);

    // 設定保存
    elements.saveSettings.addEventListener('click', saveSettings);

    // 翻訳ボタン
    elements.translateBtn.addEventListener('click', startTranslation);

    // 原文に戻すボタン
    elements.restoreBtn.addEventListener('click', restoreOriginal);

    // キャンセルボタン
    elements.cancelBtn.addEventListener('click', cancelTranslation);

    // 自動翻訳トグル
    elements.autoTranslate.addEventListener('change', async () => {
        await settingsStorage.set({ autoTranslate: elements.autoTranslate.checked });
    });

    // 詳細ログトグル
    elements.verboseLog.addEventListener('change', async () => {
        await settingsStorage.set({ verboseLog: elements.verboseLog.checked });
    });

    // 使用量表示トグル
    elements.toggleUsage.addEventListener('click', toggleUsageViewer);

    // 使用量リセット
    elements.clearUsage.addEventListener('click', handleClearUsage);

    // 翻訳キャッシュクリア
    elements.clearCache.addEventListener('click', handleClearCache);

    // サイト別キャッシュ表示トグル
    elements.toggleCacheSites.addEventListener('click', toggleCacheSitesPanel);

    // ログ表示トグル
    elements.toggleLogs.addEventListener('click', toggleLogViewer);

    // ログクリア
    elements.clearLogs.addEventListener('click', handleClearLogs);

    // ログレベルフィルター
    document.querySelectorAll('.log-chip input').forEach(input => {
        input.addEventListener('change', () => {
            const chip = input.closest('.log-chip');
            if (input.checked) {
                logFilter.levels.add(input.value);
                chip.classList.add('active');
            } else {
                logFilter.levels.delete(input.value);
                chip.classList.remove('active');
            }
            renderFilteredLogs();
        });
    });

    // ログソースフィルター
    document.querySelectorAll('.log-src-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.log-src-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            logFilter.source = btn.dataset.source;
            renderFilteredLogs();
        });
    });

    // Content / 拡張からの進捗メッセージを受信
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'TRANSLATION_PROGRESS') {
            updateProgress(message.current, message.total);
        }
        if (message.type === 'TRANSLATION_COMPLETE') {
            onTranslationComplete();
        }
        if (message.type === 'TRANSLATION_SKIPPED') {
            setTranslating(false);
            elements.progressContainer.classList.add('hidden');
            showStatus('日本語ページのため翻訳をスキップしました（APIを節約）', 'info');
        }
        if (message.type === 'TRANSLATION_CANCELLED') {
            setTranslating(false);
            elements.progressContainer.classList.add('hidden');
        }
        if (message.type === 'TRANSLATION_ERROR') {
            onTranslationError(message.error);
        }
    });
}

/**
 * 設定を保存する
 */
async function saveSettings() {
    const provider = elements.apiProvider.value;
    const apiKey = elements.apiKey.value.trim();
    const openrouterApiKey = elements.openrouterApiKey.value.trim();
    const sambanovaApiKey = elements.sambanovaApiKey.value.trim();
    const lmstudioEndpoint = (elements.lmstudioEndpoint.value || 'http://localhost:1234').trim();
    const lmstudioModel = elements.lmstudioModelSelect.value;
    const lmstudioSourceLang = elements.lmstudioSourceLang.value;
    const targetLang = elements.targetLang.value;
    const model = elements.modelSelect.value;
    const openrouterModel = elements.openrouterModelSelect.value;
    const sambanovaModel = elements.sambanovaModelSelect.value;
    const batchMaxChars = parseInt(elements.batchSize.value, 10);

    let activeKey, showKeyStatusFn, activeModel;
    if (provider === 'openrouter') {
        activeKey = openrouterApiKey;
        activeModel = openrouterModel;
        showKeyStatusFn = (msg, type) => showOpenrouterKeyStatus(msg, type);
    } else if (provider === 'sambanova') {
        activeKey = sambanovaApiKey;
        activeModel = sambanovaModel;
        showKeyStatusFn = (msg, type) => showSambanovaKeyStatus(msg, type);
    } else if (provider === 'lmstudio') {
        activeKey = lmstudioEndpoint;
        activeModel = lmstudioModel;
        showKeyStatusFn = (msg, type) => showLMStudioKeyStatus(msg, type);
    } else {
        activeKey = apiKey;
        activeModel = model;
        showKeyStatusFn = (msg, type) => showKeyStatus(msg, type);
    }

    if (!activeKey) {
        const label = provider === 'lmstudio' ? 'エンドポイントを入力してください' : 'APIキーを入力してください';
        showKeyStatusFn(label, 'error');
        return;
    }

    const saveBtn = elements.saveSettings;
    const originalText = saveBtn.querySelector('.btn-text').textContent;
    saveBtn.querySelector('.btn-text').textContent = '⏳ 検証中...';
    saveBtn.disabled = true;

    await settingsStorage.set({
        apiKey, openrouterApiKey, sambanovaApiKey, apiProvider: provider,
        targetLang, model, openrouterModel, sambanovaModel,
        lmstudioEndpoint, lmstudioModel, lmstudioSourceLang,
        batchMaxChars
    });
    elements.translateBtn.disabled = false;

    try {
        const response = await sendRuntimeMessageWithTimeout({
            type: 'TEST_API_KEY',
            apiKey: activeKey,
            model: activeModel,
            provider
        });

        if (response.success && response.isValid) {
            const label = provider === 'lmstudio' ? '✅ LM Studio に接続できました。設定を保存しました。' : '✅ APIキーが有効です。設定を保存しました。';
            showKeyStatusFn(label, 'success');
        } else {
            const detail = response.error || '接続テストに失敗しました';
            showKeyStatusFn(`⚠️ 設定を保存しました。検証結果: ${detail}`, 'error');
        }
    } catch (error) {
        showKeyStatusFn('✅ 設定を保存しました（検証スキップ）', 'success');
    } finally {
        saveBtn.querySelector('.btn-text').textContent = originalText;
        saveBtn.disabled = false;
    }
}

/**
 * 翻訳を開始する
 */
async function startTranslation() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        showStatus('アクティブなタブが見つかりません', 'error');
        return;
    }

    const targetLang = elements.targetLang.value;
    setTranslating(true);

    try {
        // Content script にメッセージを送信
        // Content script がまだ読み込まれていない場合は注入する
        try {
            await sendTabMessageWithTimeout(tab.id, { type: 'GET_TRANSLATION_STATE' }, 5000);
        } catch {
            // Content script を注入
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/content.js']
            });
            await chrome.scripting.insertCSS({
                target: { tabId: tab.id },
                files: ['styles/content.css']
            });
            // 少し待ってからメッセージを送る
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        const settings = await settingsStorage.get(['batchMaxChars']);
        const response = await sendTabMessageWithTimeout(tab.id, {
            type: 'START_TRANSLATION',
            targetLang,
            batchMaxChars: resolveBatchMaxChars(settings.batchMaxChars)
        });

        if (!response?.success) {
            onTranslationError(response?.error || '翻訳に失敗しました');
        }
    } catch (error) {
        onTranslationError(error.message);
    }
}

/**
 * 翻訳をキャンセルする
 */
async function cancelTranslation() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_TRANSLATION' });
        setTranslating(false);
        showStatus('⏹ 翻訳をキャンセルしました', 'info');
    } catch (error) {
        setTranslating(false);
    }
}

/**
 * 原文に戻す
 */
async function restoreOriginal() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'RESTORE_ORIGINAL' });
        elements.restoreBtn.classList.add('hidden');
        showStatus('原文に戻しました', 'success');
    } catch (error) {
        showStatus('復元に失敗しました: ' + error.message, 'error');
    }
}

/**
 * 翻訳中の状態を設定する
 */
function setTranslating(translating) {
    elements.translateBtn.disabled = translating;
    elements.progressContainer.classList.toggle('hidden', !translating);
    elements.cancelBtn.classList.toggle('hidden', !translating);

    if (translating) {
        elements.translateBtn.querySelector('.btn-text').textContent = '⏳ 翻訳中...';
        elements.progressFill.style.width = '0%';
        elements.progressPercent.textContent = '0%';
        elements.progressText.textContent = '翻訳中...';
        elements.statusMessage.classList.add('hidden');
    } else {
        elements.translateBtn.querySelector('.btn-text').textContent = '✨ ページを翻訳';
        elements.translateBtn.disabled = false;
    }
}

/**
 * 進捗を更新する
 */
function updateProgress(current, total) {
    const percent = Math.round((current / total) * 100);
    elements.progressFill.style.width = `${percent}%`;
    elements.progressPercent.textContent = `${percent}%`;
    elements.progressText.textContent = `翻訳中... (${current}/${total})`;
}

/**
 * 翻訳完了時の処理
 */
function onTranslationComplete() {
    setTranslating(false);
    elements.progressContainer.classList.add('hidden');
    elements.restoreBtn.classList.remove('hidden');
    showStatus('✅ 翻訳が完了しました！', 'success');
}

/**
 * 翻訳エラー時の処理
 */
function onTranslationError(error) {
    setTranslating(false);
    elements.progressContainer.classList.add('hidden');
    showStatus(`❌ エラー: ${error}`, 'error');
}

/**
 * APIキーステータスを表示（Gemini）
 */
function showKeyStatus(message, type) {
    elements.keyStatus.textContent = message;
    elements.keyStatus.className = `key-status ${type}`;
    elements.keyStatus.classList.remove('hidden');

    setTimeout(() => {
        elements.keyStatus.classList.add('hidden');
    }, 5000);
}

/**
 * APIキーステータスを表示（OpenRouter）
 */
function showOpenrouterKeyStatus(message, type) {
    elements.openrouterKeyStatus.textContent = message;
    elements.openrouterKeyStatus.className = `key-status ${type}`;
    elements.openrouterKeyStatus.classList.remove('hidden');

    setTimeout(() => {
        elements.openrouterKeyStatus.classList.add('hidden');
    }, 5000);
}

function showSambanovaKeyStatus(message, type) {
    elements.sambanovaKeyStatus.textContent = message;
    elements.sambanovaKeyStatus.className = `key-status ${type}`;
    elements.sambanovaKeyStatus.classList.remove('hidden');

    setTimeout(() => {
        elements.sambanovaKeyStatus.classList.add('hidden');
    }, 5000);
}

/**
 * LM Studio 接続ステータスを表示
 */
function showLMStudioKeyStatus(message, type) {
    elements.lmstudioKeyStatus.textContent = message;
    elements.lmstudioKeyStatus.className = `key-status ${type}`;
    elements.lmstudioKeyStatus.classList.remove('hidden');

    setTimeout(() => {
        elements.lmstudioKeyStatus.classList.add('hidden');
    }, 5000);
}

/**
 * ステータスメッセージを表示
 */
function showStatus(message, type) {
    elements.statusMessage.textContent = message;
    elements.statusMessage.className = `status-message ${type}`;
    elements.statusMessage.classList.remove('hidden');

    if (type === 'success') {
        setTimeout(() => {
            elements.statusMessage.classList.add('hidden');
        }, 4000);
    }
}

/**
 * ログビューアーの表示/非表示を切り替える
 */
async function toggleLogViewer() {
    const isHidden = elements.logViewer.classList.contains('hidden');

    if (isHidden) {
        elements.logViewer.classList.remove('hidden');
        elements.toggleLogs.querySelector('.btn-text').textContent = '📋 ログを非表示';
        await loadLogs();
    } else {
        elements.logViewer.classList.add('hidden');
        elements.toggleLogs.querySelector('.btn-text').textContent = '📋 ログを表示';
    }
}

/**
 * ログを読み込む（最大200件取得してフィルタリング用にキャッシュ）
 */
async function loadLogs() {
    try {
        const response = await sendRuntimeMessageWithTimeout({
            type: 'GET_LOGS',
            limit: 200
        });

        if (!response.success) {
            elements.logList.innerHTML = '<p class="log-empty">ログの取得に失敗しました</p>';
            return;
        }

        allFetchedLogs = response.logs || [];
        renderFilteredLogs();
    } catch (error) {
        elements.logList.innerHTML = '<p class="log-empty">ログの取得に失敗しました</p>';
    }
}

/**
 * 現在のフィルター条件でログを再描画する
 */
function renderFilteredLogs() {
    const filtered = allFetchedLogs.filter(log =>
        logFilter.levels.has(log.level) &&
        (logFilter.source === 'all' || log.source === logFilter.source)
    );

    if (filtered.length === 0) {
        elements.logList.innerHTML = '<p class="log-empty">ログはありません</p>';
        return;
    }

    elements.logList.innerHTML = filtered.map(log => {
        const time = new Date(log.timestamp).toLocaleString('ja-JP', {
            month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const detailHtml = log.detail
            ? `<div class="log-detail">${escapeHtml(log.detail)}</div>`
            : '';
        return `
            <div class="log-entry">
                <div class="log-entry-header">
                    <span class="log-badge ${log.level}">${log.level}</span>
                    <span class="log-source">${escapeHtml(log.source)}</span>
                    <span class="log-time">${time}</span>
                </div>
                <div class="log-message">${escapeHtml(log.message)}</div>
                ${detailHtml}
            </div>
        `;
    }).join('');
}

/**
 * ログをクリアする
 */
async function handleClearLogs() {
    try {
        await sendRuntimeMessageWithTimeout({ type: 'CLEAR_LOGS' });
        allFetchedLogs = [];
        elements.logList.innerHTML = '<p class="log-empty">ログはありません</p>';
    } catch (error) {
        console.error('Failed to clear logs:', error);
    }
}

/**
 * 使用量ビューアーの表示/非表示を切り替える
 */
async function toggleUsageViewer() {
    const isHidden = elements.usageViewer.classList.contains('hidden');
    if (isHidden) {
        elements.usageViewer.classList.remove('hidden');
        elements.toggleUsage.querySelector('.btn-text').textContent = '📊 使用量を非表示';
        await loadUsage();
    } else {
        elements.usageViewer.classList.add('hidden');
        elements.toggleUsage.querySelector('.btn-text').textContent = '📊 使用量を表示';
    }
}

/**
 * 翻訳キャッシュをクリアする（全サイト）
 */
async function handleClearCache() {
    try {
        const btn = elements.clearCache;
        btn.disabled = true;
        btn.querySelector('.btn-text').textContent = '🗑 クリア中...';
        await sendRuntimeMessageWithTimeout({ type: 'CLEAR_CACHE' });
        btn.querySelector('.btn-text').textContent = '✅ クリア完了';
        loadCacheSites();
        setTimeout(() => {
            btn.querySelector('.btn-text').textContent = '🗑 全キャッシュをクリア';
            btn.disabled = false;
        }, 2000);
    } catch (error) {
        elements.clearCache.querySelector('.btn-text').textContent = '🗑 全キャッシュをクリア';
        elements.clearCache.disabled = false;
    }
}

/**
 * サイト別キャッシュ一覧を読み込んで表示する
 */
async function loadCacheSites() {
    try {
        const response = await sendRuntimeMessageWithTimeout({ type: 'GET_CACHE_SITES' });
        if (!response.success || !response.sites || response.sites.length === 0) {
            elements.cacheSitesList.innerHTML = '<div class="cache-site-empty">キャッシュされたサイトはありません</div>';
            return;
        }
        renderCacheSites(response.sites);
    } catch {
        elements.cacheSitesList.innerHTML = '<div class="cache-site-empty">読み込みに失敗しました</div>';
    }
}

/**
 * サイト一覧をDOMに描画する
 */
function renderCacheSites(sites) {
    const list = elements.cacheSitesList;
    list.innerHTML = '';
    for (const site of sites) {
        const sizeKB = (site.size / 1024).toFixed(1);
        const row = document.createElement('div');
        row.className = 'cache-site-row';
        row.innerHTML = `
            <span class="cache-site-host" title="${site.host}">${site.host}</span>
            <span class="cache-site-stats">${site.count}件 (${sizeKB}KB)</span>
            <button class="btn btn-danger btn-xs cache-site-delete" data-host="${site.host}">
                <span class="btn-text">削除</span>
            </button>
        `;
        row.querySelector('.cache-site-delete').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const host = btn.dataset.host;
            btn.disabled = true;
            btn.querySelector('.btn-text').textContent = '...';
            try {
                await sendRuntimeMessageWithTimeout({ type: 'CLEAR_CACHE', host });
                row.remove();
                // リストが空になったらメッセージ表示
                if (list.children.length === 0) {
                    list.innerHTML = '<div class="cache-site-empty">キャッシュされたサイトはありません</div>';
                }
            } catch {
                btn.disabled = false;
                btn.querySelector('.btn-text').textContent = '削除';
            }
        });
        list.appendChild(row);
    }
}

/**
 * サイト別キャッシュパネルの表示/非表示を切り替える
 */
function toggleCacheSitesPanel() {
    const list = elements.cacheSitesList;
    const btn = elements.toggleCacheSites;
    if (list.style.display === 'none') {
        list.style.display = '';
        btn.querySelector('.btn-text').textContent = '▲ 閉じる';
        loadCacheSites();
    } else {
        list.style.display = 'none';
        btn.querySelector('.btn-text').textContent = '▼ 表示';
    }
}

/**
 * 使用量をリセットする
 */
async function handleClearUsage() {
    try {
        await sendRuntimeMessageWithTimeout({ type: 'CLEAR_USAGE' });
        elements.usageContent.innerHTML = '<p class="usage-empty">使用データがありません</p>';
    } catch (error) {
        console.error('Failed to clear usage:', error);
    }
}

/**
 * 使用量データを読み込んで表示する
 */
async function loadUsage() {
    try {
        const response = await sendRuntimeMessageWithTimeout({ type: 'GET_USAGE' });
        if (!response.success || !response.usage) {
            elements.usageContent.innerHTML = '<p class="usage-empty">使用データがありません</p>';
            return;
        }
        renderUsage(response.usage, response.pricing || {});
    } catch (error) {
        elements.usageContent.innerHTML = '<p class="usage-empty">データの取得に失敗しました</p>';
    }
}

/**
 * 使用量データを描画する
 */
function renderUsage(usage, pricing) {
    // モデルごとのコストを計算
    let totalCost = 0;
    const modelRows = Object.entries(usage.byModel || {}).map(([model, data]) => {
        const price = pricing[model];
        const cost = price
            ? (data.inputTokens * price.input + data.outputTokens * price.output) / 1_000_000
            : null;
        if (cost !== null) totalCost += cost;
        return { model, data, cost };
    });

    const formatTokens = n => n >= 1_000_000
        ? (n / 1_000_000).toFixed(2) + 'M'
        : n >= 1000
            ? (n / 1000).toFixed(1) + 'K'
            : String(n);

    const formatCost = c => {
        if (c === null) return 'N/A';
        return c < 0.0001 ? '< $0.0001' : `$${c.toFixed(4)}`;
    };

    const since = new Date(usage.since).toLocaleString('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });

    const modelRowsHtml = modelRows.map(({ model, data, cost }) => `
        <div class="usage-model-row">
            <span class="usage-model-name">${escapeHtml(model)}</span>
            <span class="usage-model-tokens">${formatTokens(data.inputTokens)} in / ${formatTokens(data.outputTokens)} out</span>
            <span class="usage-model-cost">${formatCost(cost)}</span>
        </div>
    `).join('');

    elements.usageContent.innerHTML = `
        <div class="usage-cost-row">
            <span class="usage-cost-label">推定コスト</span>
            <span class="usage-cost-value">${formatCost(totalCost)}</span>
            <span class="usage-cost-note">価格テーブル登録モデルのみ集計</span>
        </div>
        <div class="usage-stats">
            <div class="usage-stat">
                <span class="usage-stat-value">${formatTokens(usage.totalInputTokens)}</span>
                <span class="usage-stat-label">入力 tokens</span>
            </div>
            <div class="usage-stat">
                <span class="usage-stat-value">${formatTokens(usage.totalOutputTokens)}</span>
                <span class="usage-stat-label">出力 tokens</span>
            </div>
            <div class="usage-stat">
                <span class="usage-stat-value">${usage.totalRequests.toLocaleString()}</span>
                <span class="usage-stat-label">リクエスト</span>
            </div>
        </div>
        ${modelRows.length > 0 ? `<div class="usage-models">${modelRowsHtml}</div>` : ''}
        <div class="usage-since">計測開始: ${since}</div>
    `;
}

/**
 * HTMLエスケープ
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function withTimeout(promise, timeoutMs, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} がタイムアウトしました (${Math.round(timeoutMs / 1000)}秒)`)), timeoutMs);
        })
    ]);
}

function sendRuntimeMessageWithTimeout(message, timeoutMs = MESSAGE_TIMEOUT_MS) {
    return withTimeout(chrome.runtime.sendMessage(message), timeoutMs, '拡張機能との通信');
}

function sendTabMessageWithTimeout(tabId, message, timeoutMs = MESSAGE_TIMEOUT_MS) {
    return withTimeout(chrome.tabs.sendMessage(tabId, message), timeoutMs, 'ページとの通信');
}
