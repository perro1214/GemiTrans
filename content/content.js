/**
 * Content Script
 * ページ内のテキストを抽出・翻訳・置換する
 */

// 多重注入防止
if (window.__LLM_TRANSLATOR_LOADED__) {
    // 既に読み込み済み
} else {
    window.__LLM_TRANSLATOR_LOADED__ = true;

    const isNotebookDocument = /(^|\.)kaggleusercontent\.com$/.test(location.hostname) &&
        (location.pathname || '').startsWith('/kf/');
    const isKaggleNotebookPage = /^(www\.)?kaggle\.com$/.test(location.hostname) &&
        (location.pathname || '').startsWith('/code/');
    const NOTEBOOK_MARKDOWN = '.text_cell_render, .jp-MarkdownOutput';
    const NOTEBOOK_NON_PROSE = '.code_cell, .jp-CodeCell, .input_area, .output_area, .jp-OutputArea, .MathJax, .katex, mjx-container, [role="math"]';
    let notebookHost = location.hostname;
    let notebookSessionId = null;
    let notebookOperation = null;

    function relayNotebookControl(message) {
        if (!isKaggleNotebookPage) return Promise.resolve({ success: true, frames: 0 });
        return safeSendMessage({ type: 'NOTEBOOK_CONTROL', action: message.type,
            targetLang: message.targetLang, batchMaxChars: message.batchMaxChars, contextAwareParallel: !!message.contextAwareParallel, contextParallelism: normalizeContextParallelism(message.contextParallelism) });
    }

    /**
     * chrome.runtime.sendMessage の安全なラッパー
     * 拡張機能リロード時に同期で投げられる "Extension context invalidated" を捕捉する
     */
    function safeSendMessage(message) {
        try {
            if (message.type === 'TRANSLATE') {
                message = { ...message, sourcePageUrl: state.sourcePageUrl || location.href };
            }
            if (isNotebookDocument && message.type === 'TRANSLATE') {
                message = { ...message, host: notebookHost };
            }
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
        automaticPageKey: null,
        translationTargetLang: null,
        sourcePageLanguage: 'unknown',
        contextAwareParallel: false,
        contextParallelism: 3,
        contextOutline: '',
        isTranslating: false,
        notebookTranslating: false,
        isTranslated: false,
        isCancelled: false,
        generation: 0, // 復元・キャンセル・再翻訳より前の非同期応答を無効化
        previewTexts: new Map(), // node -> original source while the Google preview is displayed
        appliedTexts: new Map(), // node -> 最後に拡張が適用した全文
        originalTexts: new Map(), // node -> originalText（元テキスト復元用／翻訳済みノード識別用）
        translatedElements: new Set(),
        /**
         * 翻訳結果のコンテンツスクリプト側キャッシュ。
         * React/Vue 等が同じ原文のテキストノードを再生成した際、API 往復なしで
         * 即座に再適用できるようにする。キーは原文・文章の役割・ページ文脈。
         */
        translatedTextCache: new Map()
    };

    function isCurrentGeneration(generation) {
        return state.generation === generation && !state.isCancelled;
    }

    // サイト側で変更されたノードの古い復元情報を破棄する。
    function forgetChangedTranslation(node) {
        if (!state.originalTexts.has(node) || node.textContent === state.appliedTexts.get(node)) return;
        removeTranslationUnderline(node);
        state.previewTexts.delete(node);
        state.originalTexts.delete(node);
        state.appliedTexts.delete(node);
        const parent = node.parentElement;
        if (parent && !Array.from(parent.childNodes).some(n => state.originalTexts.has(n))) {
            parent.classList.remove('llm-translated');
            parent.removeAttribute('data-original-text');
            state.translatedElements.delete(parent);
        }
    }

    // Each page batch owns its preview callback. A completed/cancelled request can
    // never accept a late Google result, even if the LLM finished first.
    let previewSequence = 0;
    const previewRequests = new Map();
    async function requestPageTranslation(message, batch, textToNodes) {
        const generation = state.generation;
        const requestId = `${generation}:${++previewSequence}`;
        previewRequests.set(requestId, { generation, batch, textToNodes });
        try {
            return await safeSendMessage({ ...message, previewRequestId: requestId });
        } finally {
            previewRequests.delete(requestId);
        }
    }

    function receiveTranslationPreview(message) {
        const pending = previewRequests.get(message.requestId);
        if (!pending || !isCurrentGeneration(pending.generation) || !Array.isArray(message.entries)) return;
        let applied = false;
        for (const entry of message.entries) {
            if (!Number.isInteger(entry.index)) continue;
            const item = pending.batch[entry.index];
            if (!item || !isSafeTranslationText(entry.text)) continue;
            const nodes = pending.textToNodes?.get(item.cacheKey) || [item];
            for (const { node } of nodes) {
                if (applyTranslationToNode(node, entry.text, item.text, true)) applied = true;
            }
        }
        if (applied) {
            pending.previewApplied = true;
            showStatusBadge('🔄 Google仮訳を表示中・LLM翻訳中', 'translating', 'preview');
        }
    }

    // MutationObserver 関連（動的コンテンツ監視）
    let mutationObserver = null;
    let mutationDebounceTimer = null;
    let mutationFirstPendingAt = 0; // 連続ミューテーション発生時の debounce 上限計算用
    const pendingMutationNodes = new Map(); // node -> {text, role} のバッファ（重複防止）
    /** @type {WeakSet<ShadowRoot>} body および各 open shadow root へ observer を一本化するための登録済みセット */
    let observedShadowRoots = new WeakSet();

    // 動的コンテンツの debounce 設定
    // React などが高頻度で再レンダーするサイトでは連続 mutation で debounce が永遠にリセット
    // されてしまうため、初回 pending から MUTATION_DEBOUNCE_MAX_MS を超えたら強制的に flush する。
    const MUTATION_DEBOUNCE_MS = 500;
    const MUTATION_DEBOUNCE_MAX_MS = 1500;

    // 翻訳対象外のタグ
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
        'EMBED', 'APPLET', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
        'SELECT', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO',
        'IMG', 'BR', 'HR'
    ]);

    // 最小テキスト長（これ以下は翻訳しない）
    const MIN_TEXT_LENGTH = 2;

    const LEAKED_TRANSLATION_MARKER_RE = /<\/?(?:translation|link|body|button|h[1-6]|heading|label|caption|option|tab|menu[-_ ]?item|selection|em|emphasis|strong|code|title|header|footer|nav|aside|list[-_ ]?item|quote|table[-_ ]?header|table[-_ ]?cell|term|definition|summary|citation)(?:@group-\d+)?(?:\s+[^>]*)?>/i;
    const LEAKED_PAREN_ROLE_RE = /\((?:translation|link|body|button|h[1-6]|heading|label|caption|option|tab|menu[-_ ]?item|selection|em|emphasis|strong|code|title|header|footer|nav|aside|list[-_ ]?item|quote|table[-_ ]?header|table[-_ ]?cell|term|definition|summary|citation)(?:@group-\d+)?\)/i;

    function isSafeTranslationText(value) {
        if (typeof value !== 'string') return false;
        const trimmed = value.trim();
        if (!trimmed) return false;
        if (LEAKED_TRANSLATION_MARKER_RE.test(trimmed)) return false;
        if (LEAKED_PAREN_ROLE_RE.test(trimmed)) return false;
        if (/^<?\s*translation\s*>?$/i.test(trimmed)) return false;
        return true;
    }

    // 翻訳不要パターン: 数値・パーセント・通貨・時刻・日付・スコアなどのみで構成されるテキスト
    // 例: "0%", "$12.50", "3:45", "98/100", "1,234", "+5", "−3.2", "12:30:00"
    const NUMERIC_ONLY_RE = /^[\s\d%$€¥£₩.,/:;\-+−×xX*#()\[\]{}°℃℉]+$/;

    // 翻訳不要判定: Unicode の「文字（letter）」を一切含まない場合はスキップ。
    // 絵文字・記号・矢印・アイコンフォント文字・< > などを列挙せずに網羅できる。
    const HAS_LETTER_RE = /\p{L}/u;

    // 高頻度で更新される要素を追跡するためのカウンタ
    // Text node -> { count, firstSeen, text }
    const volatileNodeTracker = new Map();
    const VOLATILE_WINDOW_MS = 3000;   // この期間内に
    const VOLATILE_THRESHOLD = 3;       // この回数以上変化したら揮発性と判定
    let volatileCleanupTimer = null;

    /**
     * 翻訳プロンプトに「そのページが何か」を伝えるためのメタ情報を作る。
     * タイトルとドメインと html lang を渡しておくと、翻訳モデルが
     * トーン（マーケ/技術/ニュースなど）や固有名詞の扱いを安定させやすい。
     * @returns {{title: string, hostname: string, pageLang: string}}
     */
    function originalHeadingText(element) {
        if (!element) return '';
        const read = node => state.originalTexts.get(node) ??
            (node.nodeType === 3 ? node.textContent : Array.from(node.childNodes || []).map(read).join(''));
        return read(element);
    }
    function contentCacheKey(item) {
        return JSON.stringify([item.text, item.role || 'body', getPageContext(), state.contextAwareParallel ? [state.contextOutline, item.reference || semanticReference(item)] : null]);
    }

    function getPageContext() {
        try {
            const title = ((isNotebookDocument ? originalHeadingText(document.querySelector(`${NOTEBOOK_MARKDOWN} h1`)) : null) || document.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            const hostname = (isNotebookDocument ? notebookHost : (location?.hostname || '')).slice(0, 120);
            const pageLang = (document.documentElement?.lang || '').trim().slice(0, 16);
            return { title, hostname, pageLang, pathname: location.pathname || '/' };
        } catch {
            return { title: '', hostname: '', pageLang: '' };
        }
    }

    /**
     * テキストノードがどんな「役割」でページに置かれているかを 1 語で分類する。
     * バッチプロンプトで各項目に (role) を付けてモデルに渡すことで、
     * 見出しらしさ・ボタンらしさ・本文らしさ・リンクらしさを保持した翻訳を促す。
     *
     * 粒度を粗くしているのは、モデルが余計に解釈しすぎないようにするため。
     * @param {Text} textNode
     * @returns {string}
     */
    const BLOCK_ROLE_MAP = {
        H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6',
        BUTTON: 'button',
        A: 'link',
        LABEL: 'label',
        LI: 'list-item',
        STRONG: 'emphasis', B: 'emphasis', EM: 'emphasis', I: 'emphasis', MARK: 'emphasis',
        BLOCKQUOTE: 'quote', Q: 'quote',
        CAPTION: 'caption', FIGCAPTION: 'caption',
        TH: 'table-header', TD: 'table-cell',
        DT: 'term', DD: 'definition',
        SUMMARY: 'summary',
        CITE: 'citation',
        CODE: 'code',
        P: 'body'
    };

    // UIグループ検出: ドロップダウン・メニュー・タブ等の選択肢群にグループIDを付与
    // 同一コンテナ要素 → 同一 groupId で、プロンプト上で「まとまり」として認識させる
    const GROUP_CONTAINER_SELECTORS = [
        '[role="listbox"]',
        '[role="menu"]',
        '[role="menubar"]',
        '[role="tablist"]',
        '[role="radiogroup"]',
        'select',
        'ul[class*="dropdown"]', 'ul[class*="select"]', 'ul[class*="menu"]',
        'div[class*="dropdown"]', 'div[class*="select-menu"]', 'div[class*="listbox"]',
        '[data-radix-popper-content-wrapper]',
        '[class*="MuiMenu"]', '[class*="MuiSelect"]', '[class*="MuiList"]'
    ].join(', ');

    const uiGroupMap = new WeakMap(); // container element → groupId
    let uiGroupSeq = 0;

    /**
     * テキストノードがUIグループ（ドロップダウン等）に属している場合、そのグループIDを返す。
     * @param {Element} parentEl
     * @returns {string|null} グループ識別子（例: "group-1"）
     */
    function getUIGroupId(parentEl) {
        // option 要素は親 select がグループ
        const option = parentEl.closest('option');
        if (option) {
            const sel = option.closest('select');
            if (sel) return assignGroupId(sel);
        }
        // role="option" / role="menuitem" / role="tab" はグループコンテナの子
        const ariaRole = (parentEl.getAttribute('role') || '').toLowerCase();
        if (ariaRole === 'option' || ariaRole === 'menuitem' || ariaRole === 'tab') {
            const container = parentEl.closest(GROUP_CONTAINER_SELECTORS);
            if (container) return assignGroupId(container);
        }
        // LI 内のテキストでグループコンテナ直下ならグループ扱い
        const li = parentEl.closest('li');
        if (li) {
            const container = li.parentElement?.closest(GROUP_CONTAINER_SELECTORS);
            if (container) return assignGroupId(container);
        }
        // 汎用: グループコンテナ直下の要素
        const container = parentEl.closest(GROUP_CONTAINER_SELECTORS);
        if (container) return assignGroupId(container);
        return null;
    }

    function assignGroupId(containerEl) {
        if (uiGroupMap.has(containerEl)) return uiGroupMap.get(containerEl);
        const id = `group-${++uiGroupSeq}`;
        uiGroupMap.set(containerEl, id);
        return id;
    }

    function getRoleForNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent) return 'body';

        // UIグループ検出（ドロップダウン・メニュー・タブ等）
        const groupId = getUIGroupId(parent);
        if (groupId) {
            // グループ内の基本ロールを決定
            const ariaRole = (parent.getAttribute('role') || '').toLowerCase();
            let itemRole = 'option';
            if (ariaRole === 'menuitem') itemRole = 'menu-item';
            else if (ariaRole === 'tab') itemRole = 'tab';
            else if (parent.closest('[role="tab"]')) itemRole = 'tab';
            else if (parent.closest('[role="menuitem"]')) itemRole = 'menu-item';
            return `${itemRole}@${groupId}`;
        }

        // ARIA role を優先（div でもボタンやヘディングとして振る舞うケースがある）
        const ariaHost = parent.closest('[role]');
        if (ariaHost) {
            const r = (ariaHost.getAttribute('role') || '').toLowerCase();
            if (r === 'button') return 'button';
            if (r === 'heading') return 'heading';
            if (r === 'link') return 'link';
            if (r === 'menuitem') return 'menu-item';
            if (r === 'tab') return 'tab';
            if (r === 'navigation') return 'nav';
        }

        // input[type=submit|button] のようなフォーム要素
        if (parent.closest('button')) return 'button';

        // 祖先を辿って一番内側のブロック種別を採用
        let el = parent;
        while (el && el !== document.body) {
            const tag = el.tagName;
            if (BLOCK_ROLE_MAP[tag]) return BLOCK_ROLE_MAP[tag];
            if (tag === 'NAV') return 'nav';
            if (tag === 'HEADER') return 'header';
            if (tag === 'FOOTER') return 'footer';
            if (tag === 'ASIDE') return 'aside';
            el = el.parentElement;
        }
        return 'body';
    }

    /**
     * ページの言語を検出する
     * @returns {'ja' | 'other' | 'unknown'}
     * @remarks html lang は「UI 言語」だけ ja にされ本文が英語、というサイトがある（例: platform.openai.com）。
     *          そのため lang 単体ではなく、本文サンプルの文字種を優先する。
     */
    function detectPageLanguage() {
        const sampleText = (document.body?.innerText || '').slice(0, 2000);
        if (!sampleText.trim()) return 'unknown';

        // 日本語特有の仮名文字（ひらがな・カタカナ）で判定する。
        // 漢字（CJK統合漢字 \u4E00-\u9FFF）だけでは中国語ページを日本語と誤判定するため分離する。
        const kanaChars = (sampleText.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
        const latinLetters = (sampleText.match(/[a-zA-Z]/g) || []).length;
        const len = sampleText.length;
        const kanaRatio = kanaChars / len;

        // 冒頭テキストが主にラテン文字なら英語等とみなす（lang=ja-JP でもスキップしない）
        if (latinLetters >= 60 && kanaRatio < 0.06 && kanaChars < latinLetters * 0.12) {
            return 'other';
        }

        // 仮名文字が十分多ければ日本語ページ
        if (kanaRatio > 0.1) return 'ja';

        // html lang / meta が日本向けだが、本文に仮名が少しはあるケース
        const lang = document.documentElement.lang?.toLowerCase() || '';
        const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.content?.toLowerCase() || '';
        if ((lang.startsWith('ja') || metaLang.startsWith('ja')) && kanaRatio > 0.03) {
            return 'ja';
        }

        // 漢字中心の日本語ページ。中国語ページはlang=jaの根拠がない限り除外しない。
        if ((/^ja(?:-|$)/.test(lang) || /^ja(?:-|$)/.test(metaLang)) &&
            /[\u3400-\u9fff]/.test(sampleText) && latinLetters < 60) return 'ja';

        // 英語混在の日本語コンテンツ（仮名比率だけでは lang ほど出ない）
        if (kanaRatio > 0.05) return 'ja';

        return 'other';
    }

    /**
     * 翻訳先言語が日本語かどうか判定する
     * @param {string} targetLang
     * @returns {boolean}
     */
    function isTargetJapanese(targetLang) {
        return /^(?:日本語|Japanese|ja(?:[-_]JP)?|JP)$/i.test(String(targetLang || '').trim());
    }

    // One eligibility rule for initial translation, rescans and delayed DOM updates.
    // A Japanese page's brand names/navigation must not enable whole-page translation.
    function needsTargetTranslation(item, targetLang = state.translationTargetLang) {
        if (!isTargetJapanese(targetLang)) return true;
        const text = item.text || '';
        if (/[\u3040-\u30ff\uff66-\uff9f]/.test(text)) return false;
        const pageLanguage = state.sourcePageLanguage === 'unknown'
            ? detectPageLanguage() : state.sourcePageLanguage;
        if (pageLanguage !== 'ja') return true;
        if (/^(?:nav|header|footer|aside|button|menu-item|tab|option)$/.test(item.role || '')) return false;
        const parent = item.node?.parentElement;
        if (parent?.closest?.('nav, header, footer, aside, button, [role="navigation"], [role="menu"]')) return false;
        if (/(?:©|copyright|all rights reserved|https?:\/\/|www\.)/i.test(text)) return false;
        // Keep actual foreign prose (including late-loaded discussion titles),
        // but leave short labels, product names and Han-only Japanese headings alone.
        return (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length >= 6 &&
            (text.match(/[A-Za-z]/g) || []).length >= 24 && !/[\u3400-\u9fff]/.test(text);
    }

    // Range装飾はDOM構造・フォント・行の高さを変更せず、親子で二重にならない。
    const displaySettings = { translationUnderline: true, originalTooltip: true };
    const underlineRanges = new Map();
    const underlineHighlight = typeof Highlight === 'function' && typeof CSS !== 'undefined' && CSS.highlights
        ? new Highlight() : null;
    const UNDERLINE_STYLE = '::highlight(gemitrans-translated) { text-decoration: underline dashed currentColor; text-decoration-thickness: 1px; }';
    if (underlineHighlight) CSS.highlights.set('gemitrans-translated', underlineHighlight);

    function removeTranslationUnderline(node) {
        const range = underlineRanges.get(node);
        if (range) underlineHighlight?.delete(range);
        underlineRanges.delete(node);
    }

    function hasPageUnderline(node) {
        if (typeof getComputedStyle !== 'function') return false;
        for (let el = node.parentElement; el; el = el.parentElement || el.getRootNode?.().host) {
            const style = getComputedStyle(el);
            if ((style.textDecorationLine || '').includes('underline')) return true;
            // テキスト直上またはインライン祖先の罫線は、既存の下線として保持する。
            if ((el === node.parentElement || style.display === 'inline') &&
                style.borderBottomStyle && style.borderBottomStyle !== 'none' &&
                parseFloat(style.borderBottomWidth) > 0) return true;
        }
        return false;
    }

    function updateTranslationUnderline(node) {
        removeTranslationUnderline(node);
        if (!underlineHighlight || !displaySettings.translationUnderline || !node?.isConnected ||
            node.textContent !== state.appliedTexts.get(node) ||
            node.textContent === state.originalTexts.get(node) || hasPageUnderline(node)) return;
        const root = node.getRootNode?.();
        // document用CSSはmanifestで注入。open Shadow DOMには同じ装飾のみ追加する。
        if (root?.host && !root.querySelector('#gemitrans-underline-style')) {
            const style = document.createElement('style');
            style.id = 'gemitrans-underline-style';
            style.textContent = UNDERLINE_STYLE;
            root.appendChild(style);
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        underlineRanges.set(node, range);
        underlineHighlight.add(range);
    }

    function applyDisplaySettings(settings) {
        displaySettings.translationUnderline = settings.translationUnderline !== false;
        displaySettings.originalTooltip = settings.originalTooltip !== false;
        if (!displaySettings.originalTooltip) hideTooltip();
        underlineHighlight?.clear();
        underlineRanges.clear();
        if (displaySettings.translationUnderline) {
            for (const node of state.originalTexts.keys()) updateTranslationUnderline(node);
        }
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
        if (!displaySettings.originalTooltip) return;
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
        if (!displaySettings.originalTooltip) { hideTooltip(); return; }
        const el = (e.composedPath?.()[0] || e.target).closest?.('.llm-translated');
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
    let statusBadgeRevision = 0;
    let statusBadgeSource = null;

    /**
     * ステータスバッジを作成/更新する
     */
    function showStatusBadge(text, type = 'translating', source = null) {
        statusBadgeRevision++;
        statusBadgeSource = source;
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
        statusBadgeRevision++;
        if (statusBadge) {
            statusBadge.style.display = 'none';
        }
    }

    // 古い完了通知のタイマーで、新しい翻訳の表示を消さない。
    function scheduleStatusBadgeHide(delay) {
        const revision = statusBadgeRevision;
        const generation = state.generation;
        setTimeout(() => {
            if (revision === statusBadgeRevision && generation === state.generation) hideStatusBadge();
        }, delay);
    }

    // 動的追加・単独再スキャンはtranslatePageの完了処理を通らない。
    // 他のリクエストが表示した仮訳を待っている間は、進行中表示を維持する。
    function settlePreviewStatus(generation) {
        if (!isCurrentGeneration(generation) || state.isTranslating || state.notebookTranslating ||
            statusBadgeSource !== 'preview') return;
        if ([...previewRequests.values()].some(p => p.generation === generation && p.previewApplied)) return;
        const remaining = [...state.previewTexts.keys()].filter(node =>
            node.isConnected && node.textContent === state.appliedTexts.get(node)).length;
        if (remaining) {
            showStatusBadge(`⚠️ Google仮訳 ${remaining}件（LLM未完了）`, 'error', 'preview');
            scheduleStatusBadgeHide(4000);
        } else {
            hideStatusBadge();
        }
    }

    // アイコンフォント検出の正規表現（closest より safer にここへ集約）
    const ICON_CLASS_RE = /\b(material-icons?|material-symbols?[-\w]*|google-symbols?|fa[srbldc]?\s|glyphicon|bi\s|codicon)\b/;

    /**
     * TreeWalker 用: テキストノードを翻訳対象とするか
     *
     * 以前は `closest()` を属性・role・class・aria-live 用に最大7回呼んでいたため、
     * 数千ノードの大規模ページで合計数万回の親走査が発生していた。
     * ここでは親を1回だけ上がりながら全ての除外条件を合わせてチェックすることで、
     * 親走査の総コストを削減する。
     *
     * @param {Text} node
     * @returns {boolean}
     */
    function isTranslatableTextNode(node) {
        forgetChangedTranslation(node);
        const parent = node.parentElement;
        if (!parent) return false;
        if (isNotebookDocument && (!parent.closest(NOTEBOOK_MARKDOWN) || parent.closest(NOTEBOOK_NON_PROSE))) return false;
        if (SKIP_TAGS.has(parent.tagName)) return false;
        if (parent.id === 'llm-translate-tooltip') return false;
        if (parent.id === 'llm-translate-badge') return false;

        // テキスト内容のチェックは走査前に済ませて、問題あれば親を辿らず早期終了する
        const text = node.textContent.trim();
        if (text.length < MIN_TEXT_LENGTH) return false;
        if (NUMERIC_ONLY_RE.test(text)) return false;
        if (!HAS_LETTER_RE.test(text)) return false;

        // body まで一度だけ上がりつつ、全除外条件を評価する
        // icon class 判定は旧実装との整合のため、最初に class 属性を持つ祖先のみで行う。
        let iconCheckDone = false;
        for (let el = parent; el && el !== document.body && el.nodeType === 1; el = el.parentElement) {
            const tag = el.tagName;
            if (tag === 'PRE' || tag === 'CODE') return false;

            if (el.getAttribute('contenteditable') === 'true') return false;
            if (el.getAttribute('translate') === 'no') return false;
            if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('hidden') !== null) return false;
            const ariaLive = el.getAttribute('aria-live');
            if (ariaLive === 'assertive' || ariaLive === 'polite') return false;
            const role = el.getAttribute('role');
            if (role) {
                // presentation/none は要素自身の意味を外すだけで、子のメニュー文言は翻訳対象。
                if (role === 'timer' || role === 'progressbar') return false;
            }

            const cls = el.className;
            const hasClass = typeof cls === 'string' && cls.length > 0;
            if (hasClass) {
                if (el.classList && el.classList.contains('notranslate')) return false;
                if (!iconCheckDone) {
                    iconCheckDone = true;
                    if (ICON_CLASS_RE.test(cls)) return false;
                }
            }
        }
        return true;
    }

    /**
     * document / ShadowRoot など単一ツリー内のテキストを収集し、子の open shadow も再帰する
     * @param {Node} root  document.body または ShadowRoot など
     * @returns {Array<{node: Text, text: string}>}
     */
    function collectTextNodesInTree(root) {
        const textNodes = [];
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    return isTranslatableTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
            }
        );
        let node;
        while ((node = walker.nextNode())) {
            textNodes.push({ node, text: node.textContent.trim(), role: getRoleForNode(node) });
        }
        const elWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
        let el;
        while ((el = elWalker.nextNode())) {
            if (el.shadowRoot) {
                textNodes.push(...collectTextNodesInTree(el.shadowRoot));
            }
        }
        return textNodes;
    }

    /**
     * ページ内の翻訳対象テキストノードを収集する（open Shadow DOM を含む）
     * @returns {Array<{node: Text, text: string}>}
     */
    function collectTextNodes(targetLang = state.translationTargetLang) {
        if (!document.body) return [];
        return collectTextNodesInTree(document.body).filter(item => needsTargetTranslation(item, targetLang));
    }

    /**
     * テキストを文字数ベースでバッチに分割する
     * @param {Array} items
     * @param {number} maxChars
     * @returns {Array<Array>}
     */
    // Only eligible prose is used as reference: never code, inputs or outputs.
    function semanticContainer(item) {
        const p = item.node?.parentElement;
        return p?.closest?.('.text_cell_render, .jp-MarkdownOutput') ||
            p?.closest?.('tr, [role="row"]') || p?.closest?.('p, li, blockquote, section, article') || p;
    }
    function semanticReference(item) {
        const group = semanticContainer(item);
        if (!group) return '';
        const excerpt = (element, limit) => element ? collectTextNodesInTree(element)
            .map(x => state.originalTexts.get(x.node) || x.text).join(' ').replace(/\s+/g, ' ').slice(0, limit) : '';
        return [excerpt(group.previousElementSibling, 200), excerpt(group, 400),
            excerpt(group.nextElementSibling, 200)].filter(Boolean).join(' | ');
    }
    function prepareContextItems(items) {
        if (!state.contextAwareParallel) return items;
        const references = new Map();
        for (const item of items) {
            item.group = semanticContainer(item);
            if (!references.has(item.group)) references.set(item.group, semanticReference(item));
            item.reference = references.get(item.group);
        }
        return items;
    }
    function contextForBatch(batch, context) {
        if (!state.contextAwareParallel) return context;
        const excerpts = [...new Set(batch.map(x => x.reference || '').filter(Boolean))];
        return { ...context, reference: (`Headings: ${state.contextOutline}\nNearby prose: ${excerpts.join(' | ')}`).slice(0, 1200) };
    }
    function normalizeContextParallelism(value) {
        return Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 6 ? Number(value) : 3;
    }
    function planTranslationBatches(items, maxChars) {
        if (!state.contextAwareParallel) return chunkByChars(items, maxChars);
        // Stay under Gemini's internal 3000-character split; keep oversized
        // individual text nodes intact and carry reference into API fallbacks.
        const limit = Math.min(maxChars, 2600);
        const blocks = [];
        for (const item of items) {
            const last = blocks[blocks.length - 1];
            if (!last || last[0].group !== item.group) blocks.push([item]);
            else last.push(item);
        }
        const batches = [];
        let current = [], size = 0;
        for (const block of blocks) {
            const parts = chunkByChars(block, limit);
            for (const part of parts) {
                const length = part.reduce((n, x) => n + x.text.length + 7, 0);
                if (current.length && size + length > limit) { batches.push(current); current = []; size = 0; }
                current.push(...part); size += length;
            }
        }
        if (current.length) batches.push(current);
        return batches;
    }

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
     * 翻訳結果を 1 つのテキストノードに適用する共通処理。
     * 先頭/末尾の空白（インデント・改行）を保持しながら置換し、マーカーを付与する。
     * @param {Text} node
     * @param {string} translated - 翻訳後テキスト（trim 済み）
     * @param {string} [expectedOriginal] - 翻訳リクエスト時の原文（trim 済み）。
     *   指定された場合、ノードの現在テキストが変化していたら適用をスキップする。
     *   動的サイトで API 応答が返るまでにテキストが変わった場合の誤上書きを防ぐ。
     * @returns {boolean} DOM を書き換えた場合 true
     */
    function applyTranslationToNode(node, translated, expectedOriginal, provisional = false) {
        if (!node || !node.isConnected) return false;
        if (!isSafeTranslationText(translated)) {
            contentLogger.warn(`無効な翻訳結果をスキップ: "${String(translated || '').slice(0, 80)}"`);
            return false;
        }
        const currentText = node.textContent;
        const priorPreview = state.previewTexts.get(node);
        // Do not downgrade a final translation, or overwrite edits made by the site.
        if (provisional && state.originalTexts.has(node) && priorPreview === undefined) return false;
        if (priorPreview !== undefined &&
            (currentText !== state.appliedTexts.get(node) || priorPreview.trim() !== expectedOriginal)) return false;
        const origFull = priorPreview ?? currentText;

        // 翻訳リクエスト時の原文が指定されている場合、現在テキストと照合
        if (expectedOriginal !== undefined) {
            const currentTrimmed = origFull.trim();
            if (currentTrimmed !== expectedOriginal) {
                contentLogger.warn(
                    `原文変化を検出、翻訳適用をスキップ: ` +
                    `"${expectedOriginal.slice(0, 40)}…" → "${currentTrimmed.slice(0, 40)}…"`
                );
                return false;
            }
        }

        const leadingWS = origFull.match(/^\s*/)[0];
        const trailingWS = origFull.match(/\s*$/)[0];
        const newText = leadingWS + translated + trailingWS;
        // A valid unchanged result (names, identifiers, already translated text)
        // is processed, even though there is no DOM mutation or highlight.
        state.originalTexts.set(node, origFull);
        state.appliedTexts.set(node, newText);
        if (provisional) state.previewTexts.set(node, origFull);
        else state.previewTexts.delete(node);
        if (newText === currentText) return false;
        node.textContent = newText;
        updateTranslationUnderline(node);
        const parent = node.parentElement;
        if (parent) {
            parent.classList.add('llm-translated');
            parent.setAttribute('data-original-text', origFull);
            state.translatedElements.add(parent);
        }
        return true;
    }

    /**
     * translatedTextCache にヒットする項目を同期的に DOM へ反映し、残った未翻訳のみ返す。
     * React 等の再レンダーで原文に戻されたノードを、API 往復を待たずに復元するための高速パス。
     * @param {Iterable<{node: Text, text: string}>} items
     * @returns {Array<{node: Text, text: string}>} キャッシュヒットしなかった項目
     */
    function applyCachedTranslations(items) {
        const remaining = [];
        for (const item of items) {
            const { node, text } = item;
            if (!node.isConnected) continue;
            if (state.originalTexts.has(node)) continue; // 既に翻訳済み（重複処理防止）
            const translated = state.translatedTextCache.get(contentCacheKey(item));
            if (translated) {
                applyTranslationToNode(node, translated, text);
            } else {
                remaining.push(item);
            }
        }
        return remaining;
    }

    /**
     * 現在の DOM 全体から翻訳対象を再収集し、キャッシュにあるものは即時反映、
     * ないものは API で翻訳してキャッシュと DOM へ反映する。
     *
     * 初回翻訳中に React 等がハイドレーション／再レンダーでノードを差し替えた結果、
     * 翻訳結果の適用先ノードが DOM から外れてしまって「ほとんど翻訳されない」現象が
     * 発生するため、初回バッチ完了後にこの再スキャンで取りこぼしを回収する。
     *
     * @param {string} targetLang
     * @param {number} batchMaxChars
     * @param {{maxApiBatches?: number}} [opts]
     * @returns {Promise<{cachedApplied: number, apiApplied: number, apiCalls: number}>}
     */
    async function reconcileDomWithCache(targetLang, batchMaxChars, opts = {}) {
        const generation = state.generation;
        const maxApiBatches = typeof opts.maxApiBatches === 'number' ? opts.maxApiBatches : Infinity;
        const fresh = prepareContextItems(collectTextNodes(targetLang));
        const untranslated = fresh.filter(({ node }) => !state.originalTexts.has(node));
        if (untranslated.length === 0) {
            return { cachedApplied: 0, apiApplied: 0, apiCalls: 0 };
        }

        // ステップ1: キャッシュから即時反映（同期）
        let cachedApplied = 0;
        const needsApi = [];
        for (const item of untranslated) {
            if (!item.node.isConnected) continue;
            if (state.originalTexts.has(item.node)) continue;
            const cached = state.translatedTextCache.get(contentCacheKey(item));
            if (cached) {
                if (applyTranslationToNode(item.node, cached, item.text)) cachedApplied++;
            } else {
                needsApi.push(item);
            }
        }

        if (needsApi.length === 0 || maxApiBatches <= 0 || state.isCancelled) {
            return { cachedApplied, apiApplied: 0, apiCalls: 0 };
        }

        // ステップ2: API 未問い合わせの項目をまとめて送る（重複送信しないようにユニーク化）
        const textToNodes = new Map();
        for (const item of needsApi) {
            if (!textToNodes.has(contentCacheKey(item))) textToNodes.set(contentCacheKey(item), []);
            textToNodes.get(contentCacheKey(item)).push(item);
        }
        const uniqueItems = [...textToNodes.keys()].map((text) => {
            const first = textToNodes.get(text)[0];
            return { node: first.node, text: first.text, role: first.role || 'body', cacheKey: text, group: first.group, reference: first.reference };
        });

        const maxChars = batchMaxChars === 0 ? Infinity : batchMaxChars;
        let batches = planTranslationBatches(uniqueItems, maxChars);
        if (Number.isFinite(maxApiBatches)) batches = batches.slice(0, maxApiBatches);

        const pageContext = getPageContext();
        const CONCURRENCY_LIMIT = state.contextAwareParallel ? normalizeContextParallelism(state.contextParallelism) : 3;
        const results = await runWithConcurrency(batches, CONCURRENCY_LIMIT, async (batch) => {
            if (!isCurrentGeneration(generation)) return null;
            const texts = batch.map((item) => item.text);
            const roles = batch.map((item) => item.role || 'body');
            const response = await requestPageTranslation({
                type: 'TRANSLATE', texts, roles, pageContext: contextForBatch(batch, pageContext), targetLang, host: location.hostname
            }, batch, textToNodes);
            if (!response.success) throw new Error(response.error);
            return { batch, translatedTexts: response.translatedTexts };
        });

        let apiApplied = 0;
        if (!isCurrentGeneration(generation)) return { cachedApplied, apiApplied, apiCalls: batches.length };
        for (const res of results) {
            if (res?.status !== 'fulfilled' || !res.value) continue;
            const { batch, translatedTexts } = res.value;
            for (let j = 0; j < batch.length; j++) {
                const translated = translatedTexts[j];
                if (!translated) {
                    // null の場合は訳文未取得。API 失敗だけでなく未キャッシュ/無効キャッシュも含む。
                    contentLogger.warn(`再スキャン時に翻訳結果なし: "${batch[j].text.slice(0, 50)}..."`);
                    continue;
                }
                state.translatedTextCache.set(batch[j].cacheKey, translated);
                const nodes = textToNodes.get(batch[j].cacheKey) || [batch[j]];
                for (const { node } of nodes) {
                    if (applyTranslationToNode(node, translated, batch[j].text)) apiApplied++;
                }
            }
        }

        settlePreviewStatus(generation);
        return { cachedApplied, apiApplied, apiCalls: batches.length };
    }

    /**
     * 並行実行数を制限しながら非同期タスクを実行する
     * @param {Array} items - 処理対象リスト
     * @param {number} concurrency - 最大同時実行数
     * @param {function} taskFn - 各アイテムに適用する非同期関数
     * @returns {Promise<Array<{status: string, value?, reason?}>>}
     */
    async function runWithConcurrency(items, concurrency, taskFn) {
        const generation = state.generation;
        const results = new Array(items.length);
        let index = 0;

        async function worker() {
            while (index < items.length) {
                const current = index++;
                if (!isCurrentGeneration(generation)) break;
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
        // Each start needs an observer bound to its own generation, even if
        // the previous pass skipped a Japanese-looking loading shell.
        stopMutationObserver();

        // 既翻訳状態の場合はリセット（SPA遷移後の再翻訳に対応）
        if (state.isTranslated) {
            stopMutationObserver();
            restoreOriginal();
        }

        const generation = ++state.generation;
        state.sourcePageUrl = location.href;
        state.isCancelled = false;

        state.translationTargetLang = targetLang;
        state.sourcePageLanguage = detectPageLanguage();
        if (isTargetJapanese(targetLang)) {
            const eligible = collectTextNodes();
            const hasJapaneseText = eligible.length === 0 && (
                /[\u3040-\u30ff\uff66-\uff9f]/.test(document.body?.innerText || '') ||
                (document.body && collectTextNodesInTree(document.body).some(({text}) => /[\u3040-\u30ff\uff66-\uff9f]/.test(text))));
            if (eligible.length === 0 && (state.sourcePageLanguage === 'ja' || hasJapaneseText)) {
                hideStatusBadge();
                contentLogger.info('日本語ページのため翻訳をスキップします（APIリクエスト節約）');
                startMutationObserver(targetLang, batchMaxChars);
                return { outcome: 'skipped', reason: 'ja-page' };
            }
        }

        state.isTranslating = true;
        state.isCancelled = false;

        showStatusBadge('🔄 翻訳中...', 'translating');

        const startTime = performance.now();
        let collectElapsed = 0;
        let apiElapsed = 0;
        let domElapsed = 0;

        try {
            const collectStart = performance.now();
            const allTextNodes = collectTextNodes();
            if (state.contextAwareParallel) {
                state.contextOutline = allTextNodes.filter(x => /^h[1-6]$/.test(x.role)).map(x => x.text).join(' / ').slice(0, 500);
                prepareContextItems(allTextNodes);
                contentLogger.info(`文脈並列モード: 最大${normalizeContextParallelism(state.contextParallelism)}バッチ / 目標2600文字 / 参照文最大1200文字`);
            }
            collectElapsed = performance.now() - collectStart;

            // デデュープ: テキスト → ノード群のマップ（同一テキストは1回だけAPIに送信）
            const textToNodes = new Map();
            for (const item of allTextNodes) {
                if (!textToNodes.has(contentCacheKey(item))) textToNodes.set(contentCacheKey(item), []);
                textToNodes.get(contentCacheKey(item)).push(item);
            }

            // ユニークなテキストのみバッチ処理
            const uniqueItems = [...textToNodes.keys()].map(text => {
                const first = textToNodes.get(text)[0];
                return { node: first.node, text: first.text, role: first.role || 'body', cacheKey: text, group: first.group, reference: first.reference };
            });
            const total = uniqueItems.length;

            contentLogger.info(`テキストノード収集完了: ${allTextNodes.length}件 (ユニーク: ${total}件)`);

            if (total === 0 && isNotebookDocument) {
                hideStatusBadge();
                return { outcome: 'skipped', reason: 'no-markdown' };
            }
            if (total === 0) {
                throw new Error('翻訳可能なテキストが見つかりませんでした');
            }

            // 文字数ベースで動的バッチ分割
            const maxChars = batchMaxChars === 0 ? Infinity : batchMaxChars;
            const batches = planTranslationBatches(uniqueItems, maxChars);
            let processed = 0;

            const CONCURRENCY_LIMIT = state.contextAwareParallel ? normalizeContextParallelism(state.contextParallelism) : 3;

            const pageContext = getPageContext();
            const apiStart = performance.now();
            // バッチ到着ごとの DOM 反映レイテンシを測るため累積で加算する
            let domAccumMs = 0;
            let failedBatchCount = 0;
            let translationError = '';

            // 並列でAPIリクエストを送信し、到着次第 DOM を更新する。
            // 旧実装では全バッチ await 後にまとめて反映していたため、最遅バッチが
            // 返るまで画面が更新されなかった。早いバッチから可視化することで
            // ユーザー知覚レイテンシを大幅に短縮する。
            await runWithConcurrency(batches, CONCURRENCY_LIMIT, async (batch, batchIndex) => {
                if (!isCurrentGeneration(generation)) return null;
                const texts = batch.map(item => item.text);
                const roles = batch.map(item => item.role || 'body');
                let response;
                try {
                    response = await requestPageTranslation({
                        type: 'TRANSLATE', texts, roles, pageContext: contextForBatch(batch, pageContext), targetLang, host: location.hostname
                    }, batch, textToNodes);
                } catch (e) {
                    contentLogger.error(`バッチ${batchIndex}送信失敗: ${e.message}`);
                    translationError ||= e.message;
                    failedBatchCount++;
                    return null;
                }
                if (!response?.success) {
                    contentLogger.error(`バッチ${batchIndex}翻訳失敗: ${response?.error || 'unknown'}`);
                    translationError ||= response?.error || '';
                    failedBatchCount++;
                    return null;
                }
                if (!isCurrentGeneration(generation)) return null;

                translationError ||= response.error || '';

                const translatedTexts = response.translatedTexts;
                const domStart = performance.now();
                for (let j = 0; j < batch.length; j++) {
                    const translated = translatedTexts[j];
                    if (!translated) {
                        contentLogger.warn(`翻訳結果なし: "${batch[j].text.slice(0, 50)}..."`);
                        continue;
                    }
                    state.translatedTextCache.set(batch[j].cacheKey, translated);
                    const nodes = textToNodes.get(batch[j].cacheKey) || [batch[j]];
                    for (const { node } of nodes) {
                        applyTranslationToNode(node, translated, batch[j].text);
                    }
                }
                domAccumMs += performance.now() - domStart;
                processed += batch.length;
                const percent = Math.round((processed / total) * 100);
                if (processed >= total) {
                    showStatusBadge('🔄 仕上げ中...', 'translating');
                    if (onProgress) onProgress(processed, total, 'finalizing');
                } else {
                    showStatusBadge(`🔄 ${percent}%`, 'translating');
                    if (onProgress) onProgress(processed, total);
                }
                return true;
            });
            apiElapsed = performance.now() - apiStart;
            domElapsed = domAccumMs;

            // キャンセルチェック（全バッチ完了後）
            if (!isCurrentGeneration(generation)) {
                return { outcome: 'cancelled' };
            }

            // 再レンダー取りこぼし回収パス。
            // React/Next.js などのハイドレーションは初回 API 応答前後に発生し、
            // applyTranslationToNode が持つ Text ノード参照が DOM から外れてしまう結果、
            // ユーザー視点では「ほとんど翻訳されないままのページ」になってしまうことがある。
            // ここで DOM を再スキャンし、キャッシュに訳文があるものは即時反映、
            // ハイドレーション後に新しく現れた未知の原文は追加 API 呼び出しで補う。
            // 進行中ハイドレーションを拾うため、短い間隔で最大3パス試みる。
            // 部分失敗時も成功した訳文のキャッシュを再レンダー後の DOM に反映したいので、
            // 失敗チェックより前に実行する。
            // 再レンダー取りこぼし回収パス。
            // React/Next.js などのハイドレーションで取り残された未翻訳ノードを拾う。
            // ただし未翻訳ノードが無いなら即抜ける（綺麗な静的ページで 1.2s 寝てた問題の解消）。
            const reconcileStart = performance.now();
            let reconcileTotalCached = 0;
            let reconcileTotalApi = 0;

            // 最初の1パスは待機なしで即実行し、取りこぼし状況を素早く把握する
            for (let pass = 0; pass < 3; pass++) {
                if (!isCurrentGeneration(generation)) break;
                // 初回以降のみ待機（ハイドレーション完了待ち）。待ち時間は短めに。
                if (pass > 0) await new Promise((r) => setTimeout(r, 200));
                if (!isCurrentGeneration(generation)) break;
                const stats = await reconcileDomWithCache(targetLang, batchMaxChars);
                reconcileTotalCached += stats.cachedApplied;
                reconcileTotalApi += stats.apiApplied;

                // 何も拾わなかった場合、次パスも拾える見込みが低いので早期終了
                if (stats.cachedApplied === 0 && stats.apiApplied === 0) break;
            }
            if (!isCurrentGeneration(generation)) return { outcome: 'cancelled' };
            const reconcileElapsed = performance.now() - reconcileStart;

            const remainingNodes = collectTextNodes().filter(({node}) => !state.originalTexts.has(node));
            const previewRemaining = [...state.previewTexts.keys()].filter(node =>
                node.isConnected && node.textContent === state.appliedTexts.get(node)).length;
            const remaining = remainingNodes.length + previewRemaining;
            if (remainingNodes.length) contentLogger.warn(`未反映テキスト: ${remainingNodes.length}件（再スキャン後）。再翻訳で再試行できます。`);
            if (failedBatchCount > 0 && remainingNodes.length > 0) {
                if (processed > 0 || reconcileTotalCached > 0 || reconcileTotalApi > 0) {
                    state.isTranslated = true;
                    startMutationObserver(targetLang, batchMaxChars);
                }
                const msg =
                    processed === 0
                        ? `全${failedBatchCount}バッチの翻訳に失敗しました`
                        : `一部の翻訳に失敗しました（${failedBatchCount}/${batches.length}バッチ）。成功したブロックのみ反映されています`;
                showStatusBadge('⚠️ 一部失敗', 'error');
                scheduleStatusBadgeHide(4000);
                throw new Error(translationError ? `${msg}。原因: ${translationError}` : msg);
            }

            state.isTranslated = true;
            if (!state.notebookTranslating) {
                showStatusBadge(previewRemaining ? `⚠️ 仮訳 ${previewRemaining}件（LLM未完了）` : remaining ? `⚠️ 未反映 ${remaining}件` : '✅ 翻訳完了', remaining ? 'error' : 'done');
                scheduleStatusBadgeHide(3000);
            } else {
                showStatusBadge('🔄 ノートブックを翻訳中...', 'translating');
            }
            const totalElapsed = performance.now() - startTime;
            contentLogger.info(
                `${remaining ? '翻訳部分完了' : '翻訳完了'}: ${allTextNodes.length}件のテキスト / ${batches.length}バッチ ` +
                `| 合計 ${totalElapsed.toFixed(0)}ms ` +
                `(収集 ${collectElapsed.toFixed(0)}ms, API ${apiElapsed.toFixed(0)}ms, ` +
                `DOM更新 ${domElapsed.toFixed(0)}ms, 再スキャン ${reconcileElapsed.toFixed(0)}ms ` +
                `[キャッシュ復元 ${reconcileTotalCached}件 / 追加API ${reconcileTotalApi}件])`
            );

            // 翻訳完了後に動的コンテンツを監視開始（Ajax・無限スクロール対応）
            startMutationObserver(targetLang, batchMaxChars);

            return { outcome: remaining ? 'partial' : 'completed', remaining, previewRemaining,
                ...(remaining && translationError ? { error: translationError } : {}) };
        } catch (error) {
            if (!isCurrentGeneration(generation)) return { outcome: 'cancelled' };
            showStatusBadge('❌ エラー', 'error');
            scheduleStatusBadgeHide(3000);
            contentLogger.error(`翻訳エラー: ${error.message}`);
            throw error;
        } finally {
            if (state.generation === generation) state.isTranslating = false;
        }
    }

    /**
     * 翻訳をキャンセルする
     */
    function cancelTranslation() {
        state.generation++;
        previewRequests.clear();
        state.notebookTranslating = false;
        state.isCancelled = true;
        state.isTranslating = false;
        state.isTranslated = state.originalTexts.size > 0;
        stopMutationObserver();
        hideStatusBadge();
        if (!isNotebookDocument) safeSendMessage({ type: 'TRANSLATION_CANCELLED' }).catch(() => {});
        contentLogger.info('翻訳キャンセルリクエストを受信');
    }

    /**
     * 翻訳を元に戻す
     */
    function restoreOriginal() {
        state.generation++;
        previewRequests.clear();
        state.notebookTranslating = false;
        state.isCancelled = true;
        state.isTranslating = false;
        stopMutationObserver(); // 動的コンテンツ監視も停止

        for (const [node, originalText] of state.originalTexts) {
            try {
                if (node.isConnected && node.textContent === state.appliedTexts.get(node)) {
                    node.textContent = originalText;
                }
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

        underlineHighlight?.clear();
        underlineRanges.clear();
        hideTooltip();
        state.previewTexts.clear();
        state.originalTexts.clear();
        state.appliedTexts.clear();
        state.translatedElements.clear();
        state.translatedTextCache.clear();
        state.isTranslated = false;
        hideStatusBadge();
    }

    /**
     * MutationObserver でテキストノードを受け入れるか判定する
     * @param {Text} node
     * @returns {boolean}
     */
    function acceptMutationNode(node) {
        forgetChangedTranslation(node);
        if (state.originalTexts.has(node)) return false;
        if (!isTranslatableTextNode(node)) return false;
        if (!needsTargetTranslation({ node, text: node.textContent.trim(), role: getRoleForNode(node) })) return false;

        // 同じテキストの再走査や兄弟項目の追加は更新回数に含めない。
        const parent = node.parentElement;
        if (parent) {
            const now = Date.now();
            const entry = volatileNodeTracker.get(node);
            const text = node.textContent;
            if (entry) {
                if (entry.text === text) {
                    if (now - entry.firstSeen >= VOLATILE_WINDOW_MS) {
                        entry.firstSeen = now;
                        entry.count = 1;
                    }
                    return entry.count < VOLATILE_THRESHOLD;
                }
                entry.text = text;
                if (now - entry.firstSeen < VOLATILE_WINDOW_MS) {
                    entry.count++;
                    if (entry.count >= VOLATILE_THRESHOLD) {
                        return false; // 揮発性ノードとして除外
                    }
                } else {
                    // ウィンドウをリセット
                    entry.firstSeen = now;
                    entry.count = 1;
                }
            } else {
                volatileNodeTracker.set(node, { firstSeen: now, count: 1, text });
                // 定期的にクリーンアップ
                if (!volatileCleanupTimer) {
                    volatileCleanupTimer = setTimeout(() => {
                        volatileCleanupTimer = null;
                        const cutoff = Date.now() - VOLATILE_WINDOW_MS * 2;
                        for (const [el, e] of volatileNodeTracker) {
                            if (e.firstSeen < cutoff) volatileNodeTracker.delete(el);
                        }
                    }, VOLATILE_WINDOW_MS * 3);
                }
            }
        }

        return true;
    }

    /**
     * 追加された DOM ノードからテキストノードを収集して pendingMutationNodes に積む（Shadow DOM 含む）
     * @param {Node} rootNode
     */
    function collectFromAddedNode(rootNode) {
        if (rootNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            for (const ch of rootNode.childNodes) {
                collectFromAddedNode(ch);
            }
            return;
        }

        if (rootNode.nodeType === Node.ELEMENT_NODE) {
            if (rootNode.id === 'llm-translate-badge') return;
            if (rootNode.id === 'llm-translate-tooltip') return;
        }

        if (rootNode.nodeType === Node.TEXT_NODE) {
            if (acceptMutationNode(rootNode)) {
                pendingMutationNodes.set(rootNode, {
                    text: rootNode.textContent.trim(),
                    role: getRoleForNode(rootNode)
                });
            }
            return;
        }

        if (rootNode.nodeType !== Node.ELEMENT_NODE) return;

        function collectUnder(subRoot) {
            const walker = document.createTreeWalker(
                subRoot,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: (n) => (acceptMutationNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
                }
            );
            let n;
            while ((n = walker.nextNode())) {
                pendingMutationNodes.set(n, {
                    text: n.textContent.trim(),
                    role: getRoleForNode(n)
                });
            }
            const elWalker = document.createTreeWalker(subRoot, NodeFilter.SHOW_ELEMENT, null);
            let el;
            while ((el = elWalker.nextNode())) {
                if (el.shadowRoot) collectUnder(el.shadowRoot);
            }
        }

        collectUnder(rootNode);
        if (rootNode.shadowRoot) collectUnder(rootNode.shadowRoot);
    }

    /**
     * open ShadowRoot に MutationObserver を張る（同一 shadow に二重登録しない）
     * @param {Node} root
     */
    function observeOpenShadowRootsUnder(root) {
        if (!mutationObserver || !root) return;
        if (root.shadowRoot && !observedShadowRoots.has(root.shadowRoot)) {
            observedShadowRoots.add(root.shadowRoot);
            mutationObserver.observe(root.shadowRoot, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'open', 'aria-expanded', 'data-state'] });
            observeOpenShadowRootsUnder(root.shadowRoot);
        }
        const elWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
        let el;
        while ((el = elWalker.nextNode())) {
            const sr = el.shadowRoot;
            if (sr && !observedShadowRoots.has(sr)) {
                observedShadowRoots.add(sr);
                mutationObserver.observe(sr, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'open', 'aria-expanded', 'data-state'] });
                observeOpenShadowRootsUnder(sr);
            }
        }
    }

    /**
     * 動的に追加されたコンテンツを翻訳する（デバウンス後に実行）
     * @param {string} targetLang
     * @param {number} batchMaxChars
     */
    async function flushPendingMutations(targetLang, batchMaxChars) {
        const generation = state.generation;
        if (!isCurrentGeneration(generation)) return;
        if (pendingMutationNodes.size === 0) return;

        // 接続中かつ未翻訳のノードのみに絞る
        const validItems = [];
        for (const [node, meta] of pendingMutationNodes) {
            if (node.isConnected && !state.originalTexts.has(node) &&
                needsTargetTranslation({ node, text: meta.text, role: meta.role }, targetLang)) {
                validItems.push({ node, text: meta.text, role: meta.role });
            }
        }
        pendingMutationNodes.clear();

        if (validItems.length === 0) return;

        // 最初にコンテンツスクリプト内キャッシュで拾えるものを同期適用（再レンダー耐性）
        prepareContextItems(validItems);
        const uncachedItems = applyCachedTranslations(validItems);
        if (uncachedItems.length === 0) {
            contentLogger.info(`動的コンテンツ翻訳: ${validItems.length}件すべてキャッシュヒット（API 呼び出しなし）`);
            return;
        }
        if (uncachedItems.length !== validItems.length) {
            contentLogger.info(`動的コンテンツ翻訳: ${validItems.length}件中 ${validItems.length - uncachedItems.length}件をキャッシュから適用、${uncachedItems.length}件を API へ`);
        } else {
            contentLogger.info(`動的コンテンツ翻訳: ${uncachedItems.length}件`);
        }

        const maxChars = batchMaxChars === 0 ? Infinity : batchMaxChars;
        uncachedItems.forEach(item => { item.cacheKey = contentCacheKey(item); });
        const batches = planTranslationBatches(uncachedItems, maxChars);
        const pageContext = getPageContext();

        for (const batch of batches) {
            if (!isCurrentGeneration(generation)) break;

            const texts = batch.map(item => item.text);
            const roles = batch.map(item => item.role || 'body');
            try {
                const response = await requestPageTranslation({
                    type: 'TRANSLATE',
                    texts,
                    roles,
                    pageContext: contextForBatch(batch, pageContext),
                    targetLang,
                    host: location.hostname
                }, batch);

                if (!isCurrentGeneration(generation)) return;
                if (!response.success) {
                    contentLogger.error(`動的コンテンツバッチ翻訳失敗: ${response.error}`);
                    continue;
                }

                const { translatedTexts } = response;
                for (let i = 0; i < batch.length; i++) {
                    const translated = translatedTexts[i];
                    if (!translated) continue;
                    // 以降の再レンダーで即時復元できるようキャッシュ
                    state.translatedTextCache.set(batch[i].cacheKey, translated);
                    applyTranslationToNode(batch[i].node, translated, batch[i].text);
                }
            } catch (e) {
                contentLogger.error(`動的コンテンツ翻訳エラー: ${e.message}`);
            } finally {
                if (isCurrentGeneration(generation) && batch.some(({ node }) =>
                    state.previewTexts.has(node) && node.isConnected && node.textContent === state.appliedTexts.get(node))) {
                    contentLogger.warn('動的コンテンツにGoogle仮訳が残っています。再翻訳でLLM翻訳を再試行できます。');
                }
                settlePreviewStatus(generation);
            }
        }
    }

    /**
     * MutationObserver を起動して動的コンテンツを監視する
     * @param {string} targetLang
     * @param {number} batchMaxChars
     */
    function startMutationObserver(targetLang, batchMaxChars) {
        state.translationTargetLang = targetLang;
        if (mutationObserver) return; // 既に起動中

        observedShadowRoots = new WeakSet();
        const generation = state.generation;

        mutationObserver = new MutationObserver((mutations) => {
            if (!isCurrentGeneration(generation)) return;
            let hasNewNodes = false;

            for (const mutation of mutations) {
                if (mutation.type === 'attributes') {
                    collectFromAddedNode(mutation.target);
                    if (pendingMutationNodes.size > 0) hasNewNodes = true;
                }
                if (mutation.type === 'characterData') {
                    collectFromAddedNode(mutation.target);
                    if (pendingMutationNodes.size > 0) hasNewNodes = true;
                }
                for (const addedNode of mutation.addedNodes || []) {
                    collectFromAddedNode(addedNode);
                    if (addedNode.nodeType === Node.ELEMENT_NODE) {
                        observeOpenShadowRootsUnder(addedNode);
                    } else if (addedNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                        for (const ch of addedNode.childNodes) {
                            if (ch.nodeType === Node.ELEMENT_NODE) observeOpenShadowRootsUnder(ch);
                        }
                    }
                    if (pendingMutationNodes.size > 0) hasNewNodes = true;
                }
            }

            if (!hasNewNodes) return;

            // React/Vue などの再レンダーで「以前に翻訳したテキストの新しいノード」が入ってくるケースは、
            // API 往復を待たずここで即座に復元する。こうしておかないと debounce 待ちの間に
            // 次の再レンダーで再び消されてユーザーには「翻訳できなかった」ように見える。
            if (state.translatedTextCache.size > 0 && pendingMutationNodes.size > 0) {
                const snapshot = Array.from(pendingMutationNodes, ([node, meta]) => ({
                    node, text: meta.text, role: meta.role
                }));
                prepareContextItems(snapshot);
                const remaining = applyCachedTranslations(snapshot);
                pendingMutationNodes.clear();
                for (const item of remaining) {
                    pendingMutationNodes.set(item.node, { text: item.text, role: item.role });
                }
                if (pendingMutationNodes.size === 0) {
                    clearTimeout(mutationDebounceTimer);
                    mutationDebounceTimer = null;
                    mutationFirstPendingAt = 0;
                    return;
                }
            }

            // 連続する DOM 変更をデバウンスでまとめるが、高頻度再レンダーでも
            // MUTATION_DEBOUNCE_MAX_MS 以内に必ず flush されるよう上限を設ける。
            const now = Date.now();
            if (!mutationFirstPendingAt) mutationFirstPendingAt = now;
            const elapsed = now - mutationFirstPendingAt;
            const remainingCap = Math.max(0, MUTATION_DEBOUNCE_MAX_MS - elapsed);
            const delay = Math.min(MUTATION_DEBOUNCE_MS, remainingCap);

            clearTimeout(mutationDebounceTimer);
            mutationDebounceTimer = setTimeout(() => {
                mutationDebounceTimer = null;
                mutationFirstPendingAt = 0;
                flushPendingMutations(targetLang, batchMaxChars).catch(() => { });
            }, delay);
        });

        mutationObserver.observe(document.body, {
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'open', 'aria-expanded', 'data-state'],
            subtree: true
        });
        observeOpenShadowRootsUnder(document.body);

        contentLogger.info('MutationObserver 起動: 動的コンテンツ監視開始（Shadow DOM 含む）');
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
        mutationDebounceTimer = null;
        mutationFirstPendingAt = 0;
        pendingMutationNodes.clear();
        observedShadowRoots = new WeakSet();
    }

    /**
     * フォーカス中の input / textarea から選択テキスト情報を取得する。
     * 取得できなければ null を返す。
     * @returns {{ element: HTMLInputElement|HTMLTextAreaElement, text: string, start: number, end: number } | null}
     */
    function getInputSelection() {
        const el = document.activeElement;
        if (!el) return null;
        const tag = el.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') return null;
        // type="text" など選択可能な input のみ（number, email 等は selectionStart 非対応）
        if (tag === 'INPUT') {
            const selectable = new Set(['text', 'search', 'url', 'tel', 'password', '']);
            if (!selectable.has(el.type || '')) return null;
        }
        try {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            if (start == null || end == null || start === end) return null;
            const text = el.value.slice(start, end).trim();
            if (!text) return null;
            return { element: el, text, start, end, value: el.value };
        } catch {
            return null;
        }
    }

    /**
     * 選択テキストを翻訳する（通常DOM選択 / input・textarea 内選択の両方に対応）
     */
    async function translateSelection(targetLang) {
        state.sourcePageUrl = location.href;
        // 1) input / textarea 内の選択を優先チェック
        const inputSel = getInputSelection();
        // 2) 通常の DOM 選択
        const domSelection = window.getSelection();
        const generation = state.generation;
        const selectedRange = !inputSel && domSelection?.rangeCount
            ? domSelection.getRangeAt(0).cloneRange() : null;
        const rangeText = selectedRange?.toString() || '';
        const domSelectedText = rangeText.trim();

        const selectedText = inputSel ? inputSel.text : domSelectedText;

        if (!selectedText || selectedText.length < MIN_TEXT_LENGTH) {
            contentLogger.warn('選択テキストが短すぎます');
            return;
        }

        const isInputMode = !!inputSel;
        showStatusBadge('🔄 翻訳中...', 'translating');

        const startTime = performance.now();
        let apiElapsed = 0;

        try {
            const apiStart = performance.now();
            const response = await safeSendMessage({
                type: 'TRANSLATE',
                texts: [selectedText],
                roles: ['selection'],
                pageContext: getPageContext(),
                targetLang,
                host: location.hostname
            });
            apiElapsed = performance.now() - apiStart;

            if (!response.success) {
                throw new Error(response.error);
            }

            if (state.generation !== generation) return;
            const translated = response.translatedTexts[0];
            const domStart = performance.now();

            if (translated && translated !== selectedText) {
                if (isInputMode) {
                    // input / textarea: 選択範囲を翻訳結果で置換
                    const el = inputSel.element;
                    if (!el.isConnected || el.value !== inputSel.value) { hideStatusBadge(); return; }
                    const before = el.value.slice(0, inputSel.start);
                    const after = el.value.slice(inputSel.end);
                    el.value = before + translated + after;
                    // カーソルを置換後テキストの末尾に置く
                    const newEnd = inputSel.start + translated.length;
                    el.setSelectionRange(newEnd, newEnd);
                    // input イベントを発火させてフレームワークの状態を同期
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    // 通常DOM: 選択範囲を翻訳結果の span で置換
                    const range = selectedRange;
                    const current = window.getSelection();
                    const currentRange = current?.rangeCount ? current.getRangeAt(0) : null;
                    if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected ||
                        range.toString() !== rangeText || !currentRange ||
                        currentRange.startContainer !== range.startContainer ||
                        currentRange.startOffset !== range.startOffset ||
                        currentRange.endContainer !== range.endContainer ||
                        currentRange.endOffset !== range.endOffset) { hideStatusBadge(); return; }
                    const span = document.createElement('span');
                    span.classList.add('llm-translated');
                    span.setAttribute('data-original-text', selectedText);
                    span.textContent = translated;

                    range.deleteContents();
                    range.insertNode(span);
                    state.translatedElements.add(span);
                    // 原文復元用に保存
                    state.originalTexts.set(span.firstChild, selectedText);
                    state.appliedTexts.set(span.firstChild, translated);
                    updateTranslationUnderline(span.firstChild);
                }
            }

            const domElapsed = performance.now() - domStart;
            const totalElapsed = performance.now() - startTime;
            showStatusBadge('✅ 翻訳完了', 'done');
            scheduleStatusBadgeHide(2000);
            contentLogger.info(
                `選択テキスト翻訳完了${isInputMode ? '(入力欄)' : ''}: ${selectedText.length}文字 ` +
                `| 合計 ${totalElapsed.toFixed(0)}ms ` +
                `(API ${apiElapsed.toFixed(0)}ms, DOM更新 ${domElapsed.toFixed(0)}ms)`
            );
        } catch (error) {
            if (state.generation !== generation) return;
            showStatusBadge('❌ エラー', 'error');
            scheduleStatusBadgeHide(3000);
            contentLogger.error(`選択テキスト翻訳エラー: ${error.message}`);
        }
    }

    /**
     * ポップアップ / Background からのメッセージを受信
     */
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type === 'TRANSLATION_PREVIEW') {
            receiveTranslationPreview(message);
            sendResponse({ success: true });
            return false;
        }
        if (message.type === 'TRANSLATION_PAGE_CHANGED') {
            cancelTranslation();
            state.automaticPageKey = null;
            sendResponse({ success: true });
            return false;
        }
        if (message.type === 'START_NOTEBOOK_TRANSLATION' && isNotebookDocument) {
            if (message.notebookSessionId === notebookSessionId && notebookOperation) {
                notebookOperation.then(sendResponse);
                return true;
            }
            // 新しい開始操作は、以前の翻訳応答を無効化してから実行する。
            restoreOriginal();
            notebookSessionId = message.notebookSessionId;
            notebookHost = message.notebookHost || location.hostname;
            state.contextAwareParallel = !!message.contextAwareParallel;
            state.contextParallelism = normalizeContextParallelism(message.contextParallelism);
            notebookOperation = translatePage(message.targetLang, message.batchMaxChars)
                .then(result => ({ success: result.outcome !== 'partial', outcome: result.outcome, error: result.outcome === 'partial' ? `ノートブックに未反映${result.remaining}件${result.error ? `。原因: ${result.error}` : ''}` : undefined }))
                .catch(error => ({ success: false, error: error.message }));
            notebookOperation.then(sendResponse);
            return true;
        }

        if (message.type === 'START_TRANSLATION') {
            if (message.automatic && message.pageKey) {
                if (state.automaticPageKey === message.pageKey) {
                    sendResponse({ success: true, alreadyStarted: true });
                    return false;
                }
                // A real SPA route supersedes work for the previous page.
                if (state.isTranslating || state.notebookTranslating) restoreOriginal();
                state.automaticPageKey = message.pageKey;
            }
            if (state.isTranslating || state.notebookTranslating) {
                sendResponse({ success: true, alreadyTranslating: true });
                return false;
            }

            state.contextAwareParallel = !!message.contextAwareParallel;
            state.contextParallelism = normalizeContextParallelism(message.contextParallelism);
            sendResponse({ success: true, started: true });

            const localOperation = translatePage(message.targetLang, message.batchMaxChars, (current, total, phase) => {
                safeSendMessage({
                    type: 'TRANSLATION_PROGRESS',
                    current,
                    total,
                    phase: phase || null
                }).catch(() => { });
            });
            const generation = state.generation;
            state.notebookTranslating = isKaggleNotebookPage;
            const frameOperation = relayNotebookControl(message).then(result => {
                if (state.generation === generation) state.notebookTranslating = false;
                if (!result?.success) throw new Error(result?.error || 'ノートブック翻訳に失敗しました');
                if (result.frames > 0 && state.generation === generation) state.isTranslated = true;
                return result;
            }, error => {
                if (state.generation === generation) state.notebookTranslating = false;
                throw error;
            });
            Promise.all([localOperation, frameOperation]).then(([result, frames]) => {
                    if (result.outcome === 'skipped' && frames.frames > 0) result = { outcome: 'completed' };
                    if (state.generation !== generation) return;
                    const o = result?.outcome;
                    if (o === 'completed') {
                        if (isKaggleNotebookPage) {
                            showStatusBadge('✅ 翻訳完了', 'done');
                            scheduleStatusBadgeHide(3000);
                        }
                        safeSendMessage({ type: 'TRANSLATION_COMPLETE' }).catch(() => { });
                    } else if (o === 'partial') {
                        safeSendMessage({ type: 'TRANSLATION_ERROR', error: `LLM翻訳が${result.remaining}件未完了です${result.previewRemaining ? `（うち${result.previewRemaining}件はGoogle仮訳を表示中）` : ''}。${result.error ? `原因: ${result.error}` : '再翻訳で再試行してください。'}` }).catch(() => {});
                    } else if (o === 'skipped') {
                        safeSendMessage({ type: 'TRANSLATION_SKIPPED', reason: result.reason }).catch(() => { });
                    } else if (o === 'cancelled') {
                        safeSendMessage({ type: 'TRANSLATION_CANCELLED' }).catch(() => { });
                    }
                })
                .catch(error => {
                    if (state.generation !== generation) return;
                    showStatusBadge('❌ エラー', 'error');
                    safeSendMessage({
                        type: 'TRANSLATION_ERROR',
                        error: error.message
                    }).catch(() => { });
                });
            return false;
        }

        if (message.type === 'CANCEL_TRANSLATION') {
            cancelTranslation();
            relayNotebookControl(message).then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        }

        if (message.type === 'RESTORE_ORIGINAL') {
            restoreOriginal();
            relayNotebookControl(message).then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        }

        if (message.type === 'GET_TRANSLATION_STATE') {
            if (isKaggleNotebookPage) {
                relayNotebookControl(message).then(frames => sendResponse({
                    isTranslating: state.isTranslating || state.notebookTranslating || !!frames?.isTranslating,
                    isTranslated: state.isTranslated || !!frames?.isTranslated
                })).catch(() => sendResponse({ isTranslating: state.isTranslating, isTranslated: state.isTranslated }));
                return true;
            }
            sendResponse({ isTranslating: state.isTranslating, isTranslated: state.isTranslated });
            return false;
        }

        if (message.type === 'TRANSLATE_SELECTION') {
            translateSelection(message.targetLang)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        }
    });

    let displaySettingsRevision = 0;
    chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area !== 'local' || (!changes.translationUnderline && !changes.originalTooltip)) return;
        displaySettingsRevision++;
        applyDisplaySettings({
            translationUnderline: changes.translationUnderline ? changes.translationUnderline.newValue : displaySettings.translationUnderline,
            originalTooltip: changes.originalTooltip ? changes.originalTooltip.newValue : displaySettings.originalTooltip
        });
    });
    const initialDisplayRevision = displaySettingsRevision;
    chrome.storage?.local?.get(['translationUnderline', 'originalTooltip']).then(settings => {
        if (displaySettingsRevision === initialDisplayRevision) applyDisplaySettings(settings);
    }).catch(() => {});

    // iframeは親ページより遅れて生成されるため、自分の準備完了を通知する。
    if (isNotebookDocument && window.top !== window) {
        safeSendMessage({ type: 'NOTEBOOK_FRAME_READY' }).then(result => {
            if (!result?.success) contentLogger.warn(`ノートブック初期化: ${result?.error || 'failed'}`);
        }).catch(() => {});
    }

} // end of multi-injection guard
