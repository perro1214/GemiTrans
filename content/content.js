/**
 * Content Script
 * ページ内のテキストを抽出・翻訳・置換する
 */

// 多重注入防止
if (window.__LLM_TRANSLATOR_LOADED__) {
    // 既に読み込み済み
} else {
    window.__LLM_TRANSLATOR_LOADED__ = true;

    // Content Script 用ロガー（Background経由でログを保存）
    const contentLogger = {
        _send(level, message, detail) {
            chrome.runtime.sendMessage({
                type: 'LOG',
                level,
                source: 'content',
                logMessage: message,
                detail: detail || null
            }).catch(() => { });
        },
        info(msg, detail) { this._send('info', msg, detail); },
        warn(msg, detail) { this._send('warn', msg, detail); },
        error(msg, detail) { this._send('error', msg, detail); }
    };

    // 翻訳状態の管理
    const state = {
        isTranslating: false,
        isTranslated: false,
        isCancelled: false,
        originalTexts: new Map(), // element -> originalText
        translatedElements: new Set()
    };

    // 翻訳対象外のタグ
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
        'EMBED', 'APPLET', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
        'SELECT', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO',
        'IMG', 'BR', 'HR'
    ]);

    // 最小テキスト長（これ以下は翻訳しない）
    const MIN_TEXT_LENGTH = 2;

    // ステータスバッジ
    let statusBadge = null;

    /**
     * ステータスバッジを作成/更新する
     */
    function showStatusBadge(text, type = 'translating') {
        if (!statusBadge) {
            statusBadge = document.createElement('div');
            statusBadge.id = 'llm-translate-badge';
            document.body.appendChild(statusBadge);
        }

        statusBadge.textContent = text;
        statusBadge.className = `llm-badge llm-badge-${type}`;
        statusBadge.style.display = 'flex';
    }

    /**
     * ステータスバッジを非表示にする
     */
    function hideStatusBadge() {
        if (statusBadge) {
            statusBadge.style.display = 'none';
        }
    }

    /**
     * ページ内の翻訳対象テキストノードを収集する
     * @returns {Array<{node: Text, text: string}>}
     */
    function collectTextNodes() {
        const textNodes = [];
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    if (!node.parentElement) return NodeFilter.FILTER_REJECT;
                    if (SKIP_TAGS.has(node.parentElement.tagName)) return NodeFilter.FILTER_REJECT;
                    if (node.parentElement.closest('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
                    if (node.parentElement.classList.contains('llm-translate-tooltip')) return NodeFilter.FILTER_REJECT;
                    if (node.parentElement.id === 'llm-translate-badge') return NodeFilter.FILTER_REJECT;

                    const text = node.textContent.trim();
                    if (!text || text.length < MIN_TEXT_LENGTH) return NodeFilter.FILTER_REJECT;

                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        let node;
        while ((node = walker.nextNode())) {
            textNodes.push({
                node,
                text: node.textContent.trim()
            });
        }

        return textNodes;
    }

    /**
     * テキストを文字数ベースでバッチに分割する
     * @param {Array} items
     * @param {number} maxChars
     * @returns {Array<Array>}
     */
    function chunkByChars(items, maxChars = 3000) {
        const chunks = [];
        let currentChunk = [];
        let currentLength = 0;

        for (const item of items) {
            const textLength = item.text.length + 7;
            if (currentChunk.length > 0 && currentLength + textLength > maxChars) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentLength = 0;
            }
            currentChunk.push(item);
            currentLength += textLength;
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    /**
     * ページを翻訳する
     * @param {string} targetLang - 翻訳先の言語
     * @param {number} batchMaxChars - バッチあたりの最大文字数
     * @param {function} onProgress - 進捗コールバック (current, total)
     */
    async function translatePage(targetLang, batchMaxChars = 3000, onProgress) {
        if (state.isTranslating) return;

        state.isTranslating = true;
        state.isCancelled = false;

        showStatusBadge('🔄 翻訳中...', 'translating');

        try {
            const textNodes = collectTextNodes();
            const total = textNodes.length;

            contentLogger.info(`テキストノード収集完了: ${total}件`);

            if (total === 0) {
                throw new Error('翻訳可能なテキストが見つかりませんでした');
            }

            // 文字数ベースで動的バッチ分割
            const maxChars = batchMaxChars === 0 ? Infinity : batchMaxChars;
            const batches = chunkByChars(textNodes, maxChars);
            let processed = 0;

            for (const batch of batches) {
                // キャンセルチェック
                if (state.isCancelled) {
                    contentLogger.info('翻訳がキャンセルされました');
                    showStatusBadge('⏹ キャンセル', 'cancelled');
                    setTimeout(() => hideStatusBadge(), 2000);
                    return;
                }

                const texts = batch.map(item => item.text);

                const response = await chrome.runtime.sendMessage({
                    type: 'TRANSLATE',
                    texts,
                    targetLang
                });

                if (!response.success) {
                    contentLogger.error(`バッチ翻訳失敗: ${response.error}`);
                    throw new Error(response.error);
                }

                // キャンセルチェック（API応答後）
                if (state.isCancelled) {
                    contentLogger.info('翻訳がキャンセルされました（API応答後）');
                    showStatusBadge('⏹ キャンセル', 'cancelled');
                    setTimeout(() => hideStatusBadge(), 2000);
                    return;
                }

                const { translatedTexts } = response;
                for (let i = 0; i < batch.length; i++) {
                    const { node } = batch[i];
                    const originalText = node.textContent;
                    const translated = translatedTexts[i];

                    if (translated && translated !== originalText) {
                        state.originalTexts.set(node, originalText);
                        node.textContent = translated;

                        const parent = node.parentElement;
                        if (parent) {
                            parent.classList.add('llm-translated');
                            parent.setAttribute('data-original-text', originalText);
                            state.translatedElements.add(parent);
                        }
                    }
                }

                processed += batch.length;
                const percent = Math.round((processed / total) * 100);
                showStatusBadge(`🔄 ${percent}%`, 'translating');
                if (onProgress) {
                    onProgress(processed, total);
                }
            }

            state.isTranslated = true;
            showStatusBadge('✅ 翻訳完了', 'done');
            setTimeout(() => hideStatusBadge(), 3000);
            contentLogger.info(`翻訳完了: ${total}件のテキストを翻訳しました`);
        } catch (error) {
            showStatusBadge('❌ エラー', 'error');
            setTimeout(() => hideStatusBadge(), 3000);
            contentLogger.error(`翻訳エラー: ${error.message}`);
            throw error;
        } finally {
            state.isTranslating = false;
        }
    }

    /**
     * 翻訳をキャンセルする
     */
    function cancelTranslation() {
        if (state.isTranslating) {
            state.isCancelled = true;
            contentLogger.info('翻訳キャンセルリクエストを受信');
        }
    }

    /**
     * 翻訳を元に戻す
     */
    function restoreOriginal() {
        for (const [node, originalText] of state.originalTexts) {
            try {
                node.textContent = originalText;
            } catch (e) {
                // ノードが既にDOMから削除されている場合は無視
            }
        }

        for (const element of state.translatedElements) {
            try {
                element.classList.remove('llm-translated');
                element.removeAttribute('data-original-text');
            } catch (e) {
                // 要素が既にDOMから削除されている場合は無視
            }
        }

        state.originalTexts.clear();
        state.translatedElements.clear();
        state.isTranslated = false;
        hideStatusBadge();
    }

    /**
     * 選択テキストを翻訳する
     */
    async function translateSelection(targetLang) {
        const selection = window.getSelection();
        const selectedText = selection?.toString()?.trim();

        if (!selectedText || selectedText.length < MIN_TEXT_LENGTH) {
            contentLogger.warn('選択テキストが短すぎます');
            return;
        }

        showStatusBadge('🔄 翻訳中...', 'translating');

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'TRANSLATE',
                texts: [selectedText],
                targetLang
            });

            if (!response.success) {
                throw new Error(response.error);
            }

            const translated = response.translatedTexts[0];

            if (translated && translated !== selectedText) {
                // 選択範囲を翻訳結果で置換
                const range = selection.getRangeAt(0);
                const span = document.createElement('span');
                span.classList.add('llm-translated');
                span.setAttribute('data-original-text', selectedText);
                span.textContent = translated;

                range.deleteContents();
                range.insertNode(span);
                state.translatedElements.add(span);
                // 原文復元用に保存
                state.originalTexts.set(span.firstChild, selectedText);
            }

            showStatusBadge('✅ 翻訳完了', 'done');
            setTimeout(() => hideStatusBadge(), 2000);
        } catch (error) {
            showStatusBadge('❌ エラー', 'error');
            setTimeout(() => hideStatusBadge(), 3000);
            contentLogger.error(`選択テキスト翻訳エラー: ${error.message}`);
        }
    }

    /**
     * ポップアップ / Background からのメッセージを受信
     */
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'START_TRANSLATION') {
            translatePage(message.targetLang, message.batchMaxChars, (current, total) => {
                chrome.runtime.sendMessage({
                    type: 'TRANSLATION_PROGRESS',
                    current,
                    total
                }).catch(() => { });
            })
                .then(() => {
                    sendResponse({ success: true });
                    chrome.runtime.sendMessage({
                        type: 'TRANSLATION_COMPLETE'
                    }).catch(() => { });
                })
                .catch(error => {
                    sendResponse({ success: false, error: error.message });
                    chrome.runtime.sendMessage({
                        type: 'TRANSLATION_ERROR',
                        error: error.message
                    }).catch(() => { });
                });
            return true;
        }

        if (message.type === 'CANCEL_TRANSLATION') {
            cancelTranslation();
            sendResponse({ success: true });
            return false;
        }

        if (message.type === 'RESTORE_ORIGINAL') {
            restoreOriginal();
            sendResponse({ success: true });
            return false;
        }

        if (message.type === 'GET_TRANSLATION_STATE') {
            sendResponse({
                isTranslating: state.isTranslating,
                isTranslated: state.isTranslated
            });
            return false;
        }

        if (message.type === 'TRANSLATE_SELECTION') {
            translateSelection(message.targetLang)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        }
    });

} // end of multi-injection guard
