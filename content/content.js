/**
 * Content Script
 * ページ内のテキストを抽出・翻訳・置換する
 */

// 多重注入防止
if (window.__LLM_TRANSLATOR_LOADED__) {
    // 既に読み込み済み
} else {
    window.__LLM_TRANSLATOR_LOADED__ = true;

    /**
     * chrome.runtime.sendMessage の安全なラッパー
     * 拡張機能リロード時に同期で投げられる "Extension context invalidated" を捕捉する
     */
    function safeSendMessage(message) {
        try {
            return chrome.runtime.sendMessage(message);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    // Content Script 用ロガー（Background経由でログを保存）
    const contentLogger = {
        _send(level, message, detail) {
            safeSendMessage({
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

    // ========== JS ツールチップ ==========
    let tooltipEl = null;

    function getTooltip() {
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'llm-translate-tooltip';
            document.body.appendChild(tooltipEl);
        }
        return tooltipEl;
    }

    function positionTooltip(tooltip, mouseX, mouseY) {
        // 一度表示してサイズを計測
        tooltip.style.visibility = 'hidden';
        tooltip.style.display = 'block';
        const w = tooltip.offsetWidth;
        const h = tooltip.offsetHeight;
        tooltip.style.visibility = '';

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 8;

        // カーソルの上に表示、収まらなければ下に
        let top = mouseY - h - 12;
        if (top < margin) top = mouseY + 16;

        let left = mouseX - w / 2;
        left = Math.max(margin, Math.min(left, vw - w - margin));

        // ビューポート下端を超えないよう補正
        if (top + h > vh - margin) top = vh - h - margin;

        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
    }

    function showTooltip(el, mouseX, mouseY) {
        // この要素の子テキストノードの元テキストを収集
        const parts = [];
        for (const [node, origText] of state.originalTexts) {
            if (el.contains(node)) parts.push(origText);
        }
        if (parts.length === 0) return;

        const tooltip = getTooltip();
        tooltip.textContent = parts.join('\n');
        positionTooltip(tooltip, mouseX, mouseY);
    }

    function hideTooltip() {
        if (tooltipEl) tooltipEl.style.display = 'none';
    }

    // document レベルで委譲（要素ごとのリスナー不要）
    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest('.llm-translated');
        if (el) showTooltip(el, e.clientX, e.clientY);
        else hideTooltip();
    });
    document.addEventListener('mousemove', (e) => {
        if (tooltipEl && tooltipEl.style.display !== 'none') {
            positionTooltip(tooltipEl, e.clientX, e.clientY);
        }
    });
    // ========================================

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
                    // code/pre の子孫もスキップ（シンタックスハイライト用 <span> を含む）
                    if (node.parentElement.closest('pre, code')) return NodeFilter.FILTER_REJECT;
                    if (node.parentElement.closest('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
                    if (node.parentElement.id === 'llm-translate-tooltip') return NodeFilter.FILTER_REJECT;
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
                // trim したものをAPIに送るが、前後空白は node.textContent から復元する
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
     * 並行実行数を制限しながら非同期タスクを実行する
     * @param {Array} items - 処理対象リスト
     * @param {number} concurrency - 最大同時実行数
     * @param {function} taskFn - 各アイテムに適用する非同期関数
     * @returns {Promise<Array<{status: string, value?, reason?}>>}
     */
    async function runWithConcurrency(items, concurrency, taskFn) {
        const results = new Array(items.length);
        let index = 0;

        async function worker() {
            while (index < items.length) {
                const current = index++;
                if (state.isCancelled) break;
                try {
                    results[current] = { status: 'fulfilled', value: await taskFn(items[current], current) };
                } catch (e) {
                    results[current] = { status: 'rejected', reason: e };
                }
            }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
        return results;
    }

    /**
     * ページを翻訳する
     * @param {string} targetLang - 翻訳先の言語
     * @param {number} batchMaxChars - バッチあたりの最大文字数
     * @param {function} onProgress - 進捗コールバック (current, total)
     * @returns {Promise<{ outcome: 'completed' | 'skipped' | 'cancelled' | 'busy' }>}
     */
    async function translatePage(targetLang, batchMaxChars = 3000, onProgress) {
        if (state.isTranslating) return { outcome: 'busy' };

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
                return { outcome: 'skipped', reason: 'ja-page' };
            }
        }

        state.isTranslating = true;
        state.isCancelled = false;

        showStatusBadge('🔄 翻訳中...', 'translating');

        try {
            const allTextNodes = collectTextNodes();

            // デデュープ: テキスト → ノード群のマップ（同一テキストは1回だけAPIに送信）
            const textToNodes = new Map();
            for (const item of allTextNodes) {
                if (!textToNodes.has(item.text)) textToNodes.set(item.text, []);
                textToNodes.get(item.text).push(item);
            }

            // ユニークなテキストのみバッチ処理
            const uniqueItems = [...textToNodes.keys()].map(text => ({
                node: textToNodes.get(text)[0].node,
                text
            }));
            const total = uniqueItems.length;

            contentLogger.info(`テキストノード収集完了: ${allTextNodes.length}件 (ユニーク: ${total}件)`);

            if (total === 0) {
                throw new Error('翻訳可能なテキストが見つかりませんでした');
            }

            // 文字数ベースで動的バッチ分割
            const maxChars = batchMaxChars === 0 ? Infinity : batchMaxChars;
            const batches = chunkByChars(uniqueItems, maxChars);
            let processed = 0;

            const CONCURRENCY_LIMIT = 3;

            // 並列でAPIリクエストを送信
            const batchResults = await runWithConcurrency(batches, CONCURRENCY_LIMIT, async (batch) => {
                if (state.isCancelled) return null;
                const texts = batch.map(item => item.text);
                const response = await safeSendMessage({ type: 'TRANSLATE', texts, targetLang });
                if (!response.success) throw new Error(response.error);
                return { batch, translatedTexts: response.translatedTexts };
            });

            // キャンセルチェック
            if (state.isCancelled) {
                contentLogger.info('翻訳がキャンセルされました');
                showStatusBadge('⏹ キャンセル', 'cancelled');
                setTimeout(() => hideStatusBadge(), 2000);
                return { outcome: 'cancelled' };
            }

            // 全バッチ完了後にまとめてDOM更新
            let failedBatchCount = 0;
            for (let i = 0; i < batchResults.length; i++) {
                const result = batchResults[i];
                if (result?.status !== 'fulfilled' || !result.value) {
                    contentLogger.error(`バッチ${i}翻訳失敗`);
                    failedBatchCount++;
                    continue;
                }
                const { batch, translatedTexts } = result.value;
                for (let j = 0; j < batch.length; j++) {
                    const translated = translatedTexts[j];
                    // 同一テキストを持つ全ノードに翻訳を適用
                    const nodes = textToNodes.get(batch[j].text) || [batch[j]];
                    for (const { node } of nodes) {
                        if (!translated) continue;
                        const origFull = node.textContent;
                        // 前後の空白（インデント・改行など）を保持して翻訳を適用
                        const leadingWS = origFull.match(/^\s*/)[0];
                        const trailingWS = origFull.match(/\s*$/)[0];
                        const newText = leadingWS + translated + trailingWS;
                        if (newText !== origFull) {
                            state.originalTexts.set(node, origFull);
                            node.textContent = newText;
                            const parent = node.parentElement;
                            if (parent) {
                                parent.classList.add('llm-translated');
                                parent.setAttribute('data-original-text', origFull);
                                state.translatedElements.add(parent);
                            }
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

            if (failedBatchCount > 0) {
                if (processed > 0) {
                    state.isTranslated = true;
                    startMutationObserver(targetLang, batchMaxChars);
                }
                const msg =
                    processed === 0
                        ? `全${failedBatchCount}バッチの翻訳に失敗しました`
                        : `一部の翻訳に失敗しました（${failedBatchCount}/${batchResults.length}バッチ）。成功したブロックのみ反映されています`;
                showStatusBadge('⚠️ 一部失敗', 'error');
                setTimeout(() => hideStatusBadge(), 4000);
                throw new Error(msg);
            }

            state.isTranslated = true;
            showStatusBadge('✅ 翻訳完了', 'done');
            setTimeout(() => hideStatusBadge(), 3000);
            contentLogger.info(`翻訳完了: ${allTextNodes.length}件のテキストを翻訳しました`);

            // 翻訳完了後に動的コンテンツを監視開始（Ajax・無限スクロール対応）
            startMutationObserver(targetLang, batchMaxChars);

            return { outcome: 'completed' };
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
        if (node.parentElement.closest('pre, code')) return false;
        if (node.parentElement.closest('[contenteditable="true"]')) return false;
        if (node.parentElement.id === 'llm-translate-tooltip') return false;
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
            if (rootNode.id === 'llm-translate-tooltip') return;
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
                const response = await safeSendMessage({
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

                    const translated = translatedTexts[i];
                    if (!translated) continue;

                    const origFull = node.textContent;
                    const leadingWS = origFull.match(/^\s*/)[0];
                    const trailingWS = origFull.match(/\s*$/)[0];
                    const newText = leadingWS + translated + trailingWS;

                    if (newText !== origFull) {
                        state.originalTexts.set(node, origFull);
                        node.textContent = newText;

                        const parent = node.parentElement;
                        if (parent) {
                            parent.classList.add('llm-translated');
                            parent.setAttribute('data-original-text', origFull);
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
                flushPendingMutations(targetLang, batchMaxChars).catch(() => { });
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
            const response = await safeSendMessage({
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
            if (state.isTranslating) {
                sendResponse({ success: true, alreadyTranslating: true });
                return false;
            }

            sendResponse({ success: true, started: true });

            translatePage(message.targetLang, message.batchMaxChars, (current, total) => {
                safeSendMessage({
                    type: 'TRANSLATION_PROGRESS',
                    current,
                    total
                }).catch(() => { });
            })
                .then((result) => {
                    const o = result?.outcome;
                    if (o === 'completed') {
                        safeSendMessage({ type: 'TRANSLATION_COMPLETE' }).catch(() => { });
                    } else if (o === 'skipped') {
                        safeSendMessage({ type: 'TRANSLATION_SKIPPED', reason: result.reason }).catch(() => { });
                    } else if (o === 'cancelled') {
                        safeSendMessage({ type: 'TRANSLATION_CANCELLED' }).catch(() => { });
                    }
                })
                .catch(error => {
                    safeSendMessage({
                        type: 'TRANSLATION_ERROR',
                        error: error.message
                    }).catch(() => { });
                });
            return false;
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
