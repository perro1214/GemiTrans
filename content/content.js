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
        originalTexts: new Map(), // node -> originalText
        translatedElements: new Set()
    };

    // MutationObserver 関連（動的コンテンツ監視）
    let mutationObserver = null;
    let mutationDebounceTimer = null;
    const pendingMutationNodes = new Map(); // node -> text のバッファ（重複防止）

    // 翻訳対象外のタグ
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
        'EMBED', 'APPLET', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
        'SELECT', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO',
        'IMG', 'BR', 'HR'
    ]);

    // 最小テキスト長（これ以下は翻訳しない）
    const MIN_TEXT_LENGTH = 2;

    /**
     * ページの言語を検出する
     * @returns {'ja' | 'other' | 'unknown'}
     */
    function detectPageLanguage() {
        // HTML lang属性を最優先で確認
        const lang = document.documentElement.lang?.toLowerCase() || '';
        if (lang.startsWith('ja')) return 'ja';

        // メタタグの content-language を確認
        const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.content?.toLowerCase() || '';
        if (metaLang.startsWith('ja')) return 'ja';

        // ページ冒頭テキストで日本語文字（ひらがな・カタカナ・漢字）の比率を計算
        const sampleText = (document.body?.innerText || '').slice(0, 500);
        if (!sampleText) return 'unknown';

        const japaneseChars = (sampleText.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g) || []).length;
        const ratio = japaneseChars / sampleText.length;

        // 10%以上が日本語文字であれば日本語ページと判定
        return ratio > 0.1 ? 'ja' : 'other';
    }

    /**
     * 翻訳先言語が日本語かどうか判定する
     * @param {string} targetLang
     * @returns {boolean}
     */
    function isTargetJapanese(targetLang) {
        const jaNames = ['日本語', 'Japanese', 'japanese', 'ja', 'JP'];
        return jaNames.includes(targetLang);
    }

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

        // 既翻訳状態の場合はリセット（SPA遷移後の再翻訳に対応）
        if (state.isTranslated) {
            stopMutationObserver();
            restoreOriginal();
        }

        // 翻訳先が日本語の場合、日本語ページはスキップしてAPIリクエストを節約
        if (isTargetJapanese(targetLang)) {
            const pageLang = detectPageLanguage();
            if (pageLang === 'ja') {
                contentLogger.info('日本語ページのため翻訳をスキップします（APIリクエスト節約）');
                return;
            }
        }

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

            // 翻訳完了後に動的コンテンツを監視開始（Ajax・無限スクロール対応）
            startMutationObserver(targetLang, batchMaxChars);
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
        stopMutationObserver(); // 動的コンテンツ監視も停止

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
     * MutationObserver でテキストノードを受け入れるか判定する
     * @param {Text} node
     * @returns {boolean}
     */
    function acceptMutationNode(node) {
        if (!node.parentElement) return false;
        if (SKIP_TAGS.has(node.parentElement.tagName)) return false;
        if (node.parentElement.closest('[contenteditable="true"]')) return false;
        if (node.parentElement.classList.contains('llm-translate-tooltip')) return false;
        if (node.parentElement.id === 'llm-translate-badge') return false;
        if (state.originalTexts.has(node)) return false; // 既翻訳ノードはスキップ

        const text = node.textContent.trim();
        return text.length >= MIN_TEXT_LENGTH;
    }

    /**
     * 追加された DOM ノードからテキストノードを収集して pendingMutationNodes に積む
     * @param {Node} rootNode
     */
    function collectFromAddedNode(rootNode) {
        // 翻訳バッジや独自要素は除外
        if (rootNode.nodeType === Node.ELEMENT_NODE) {
            if (rootNode.id === 'llm-translate-badge') return;
            if (rootNode.classList.contains('llm-translate-tooltip')) return;
        }

        if (rootNode.nodeType === Node.TEXT_NODE) {
            if (acceptMutationNode(rootNode)) {
                pendingMutationNodes.set(rootNode, rootNode.textContent.trim());
            }
            return;
        }

        if (rootNode.nodeType !== Node.ELEMENT_NODE) return;

        const walker = document.createTreeWalker(
            rootNode,
            NodeFilter.SHOW_TEXT,
            { acceptNode: (node) => acceptMutationNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
        );

        let node;
        while ((node = walker.nextNode())) {
            pendingMutationNodes.set(node, node.textContent.trim());
        }
    }

    /**
     * 動的に追加されたコンテンツを翻訳する（デバウンス後に実行）
     * @param {string} targetLang
     * @param {number} batchMaxChars
     */
    async function flushPendingMutations(targetLang, batchMaxChars) {
        if (pendingMutationNodes.size === 0) return;

        // 接続中かつ未翻訳のノードのみに絞る
        const validItems = [];
        for (const [node, text] of pendingMutationNodes) {
            if (node.isConnected && !state.originalTexts.has(node)) {
                validItems.push({ node, text });
            }
        }
        pendingMutationNodes.clear();

        if (validItems.length === 0) return;

        contentLogger.info(`動的コンテンツ翻訳: ${validItems.length}件`);

        const maxChars = batchMaxChars === 0 ? Infinity : batchMaxChars;
        const batches = chunkByChars(validItems, maxChars);

        for (const batch of batches) {
            if (state.isCancelled) break;

            const texts = batch.map(item => item.text);
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'TRANSLATE',
                    texts,
                    targetLang
                });

                if (!response.success) {
                    contentLogger.error(`動的コンテンツバッチ翻訳失敗: ${response.error}`);
                    continue;
                }

                const { translatedTexts } = response;
                for (let i = 0; i < batch.length; i++) {
                    const { node } = batch[i];
                    if (!node.isConnected) continue; // DOM から切り離されていたらスキップ

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
            } catch (e) {
                contentLogger.error(`動的コンテンツ翻訳エラー: ${e.message}`);
            }
        }
    }

    /**
     * MutationObserver を起動して動的コンテンツを監視する
     * @param {string} targetLang
     * @param {number} batchMaxChars
     */
    function startMutationObserver(targetLang, batchMaxChars) {
        if (mutationObserver) return; // 既に起動中

        mutationObserver = new MutationObserver((mutations) => {
            let hasNewNodes = false;

            for (const mutation of mutations) {
                for (const addedNode of mutation.addedNodes) {
                    collectFromAddedNode(addedNode);
                    if (pendingMutationNodes.size > 0) hasNewNodes = true;
                }
            }

            if (!hasNewNodes) return;

            // 連続する DOM 変更をまとめて処理（デバウンス 500ms）
            clearTimeout(mutationDebounceTimer);
            mutationDebounceTimer = setTimeout(() => {
                flushPendingMutations(targetLang, batchMaxChars);
            }, 500);
        });

        mutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        contentLogger.info('MutationObserver 起動: 動的コンテンツ監視開始');
    }

    /**
     * MutationObserver を停止する
     */
    function stopMutationObserver() {
        if (mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
            contentLogger.info('MutationObserver 停止');
        }
        clearTimeout(mutationDebounceTimer);
        pendingMutationNodes.clear();
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
