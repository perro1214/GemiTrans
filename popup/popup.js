/**
 * Popup Script
 * ポップアップUIのロジック
 */

// DOM要素の取得
const elements = {
    apiKey: document.getElementById('api-key'),
    toggleKey: document.getElementById('toggle-key'),
    toggleIcon: document.getElementById('toggle-icon'),
    keyStatus: document.getElementById('key-status'),
    targetLang: document.getElementById('target-lang'),
    modelSelect: document.getElementById('model-select'),
    batchSize: document.getElementById('batch-size'),
    saveSettings: document.getElementById('save-settings'),
    autoTranslate: document.getElementById('auto-translate'),
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
    clearLogs: document.getElementById('clear-logs')
};

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
        const result = await chrome.storage.sync.get(['apiKey', 'targetLang', 'model', 'autoTranslate', 'batchMaxChars']);

        if (result.apiKey) {
            elements.apiKey.value = result.apiKey;
            elements.translateBtn.disabled = false;
        }

        if (result.targetLang) {
            elements.targetLang.value = result.targetLang;
        }

        if (result.model) {
            elements.modelSelect.value = result.model;
        }

        if (result.batchMaxChars !== undefined) {
            elements.batchSize.value = String(result.batchMaxChars);
        }

        elements.autoTranslate.checked = !!result.autoTranslate;
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
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
    // APIキーの表示/非表示
    elements.toggleKey.addEventListener('click', () => {
        const isPassword = elements.apiKey.type === 'password';
        elements.apiKey.type = isPassword ? 'text' : 'password';
        elements.toggleIcon.textContent = isPassword ? '🔒' : '👁';
    });

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
        await chrome.storage.sync.set({ autoTranslate: elements.autoTranslate.checked });
    });

    // ログ表示トグル
    elements.toggleLogs.addEventListener('click', toggleLogViewer);

    // ログクリア
    elements.clearLogs.addEventListener('click', handleClearLogs);

    // Background Script からの進捗メッセージを受信
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'TRANSLATION_PROGRESS') {
            updateProgress(message.current, message.total);
        }
        if (message.type === 'TRANSLATION_COMPLETE') {
            onTranslationComplete();
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
    const apiKey = elements.apiKey.value.trim();
    const targetLang = elements.targetLang.value;
    const model = elements.modelSelect.value;
    const batchMaxChars = parseInt(elements.batchSize.value, 10);

    if (!apiKey) {
        showKeyStatus('APIキーを入力してください', 'error');
        return;
    }

    // 保存ボタンをローディング状態にする
    const saveBtn = elements.saveSettings;
    const originalText = saveBtn.querySelector('.btn-text').textContent;
    saveBtn.querySelector('.btn-text').textContent = '⏳ 検証中...';
    saveBtn.disabled = true;

    // まず設定を保存する
    await chrome.storage.sync.set({ apiKey, targetLang, model, batchMaxChars });
    elements.translateBtn.disabled = false;

    try {
        // APIキーをテスト
        const response = await chrome.runtime.sendMessage({
            type: 'TEST_API_KEY',
            apiKey,
            model
        });

        if (response.success && response.isValid) {
            showKeyStatus('✅ APIキーが有効です。設定を保存しました。', 'success');
        } else {
            const detail = response.error || '接続テストに失敗しました';
            showKeyStatus(`⚠️ 設定を保存しました。検証結果: ${detail}`, 'error');
        }
    } catch (error) {
        showKeyStatus('✅ 設定を保存しました（検証スキップ）', 'success');
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
            await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSLATION_STATE' });
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

        const settings = await chrome.storage.sync.get(['batchMaxChars']);
        const response = await chrome.tabs.sendMessage(tab.id, {
            type: 'START_TRANSLATION',
            targetLang,
            batchMaxChars: settings.batchMaxChars || 3000
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
 * APIキーステータスを表示
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
 * ログを読み込んで表示する
 */
async function loadLogs() {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_LOGS',
            limit: 50
        });

        if (!response.success) {
            elements.logList.innerHTML = '<p class="log-empty">ログの取得に失敗しました</p>';
            return;
        }

        const logs = response.logs;

        if (!logs || logs.length === 0) {
            elements.logList.innerHTML = '<p class="log-empty">ログはありません</p>';
            return;
        }

        elements.logList.innerHTML = logs.map(log => {
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
    } catch (error) {
        elements.logList.innerHTML = '<p class="log-empty">ログの取得に失敗しました</p>';
    }
}

/**
 * ログをクリアする
 */
async function handleClearLogs() {
    try {
        await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
        elements.logList.innerHTML = '<p class="log-empty">ログはありません</p>';
    } catch (error) {
        console.error('Failed to clear logs:', error);
    }
}

/**
 * HTMLエスケープ
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
