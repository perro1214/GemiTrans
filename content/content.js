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
        originalTexts: new Map(), // node -> originalText（元テキスト復元用／翻訳済みノード識別用）
        translatedElements: new Set(),
        /**
         * 翻訳結果のコンテンツスクリプト側キャッシュ。
         * React/Vue 等が同じ原文のテキストノードを再生成した際、API 往復なしで
         * 即座に再適用できるようにする。キーは trim 済みの原文。
         */
        translatedTextCache: new Map()
    };

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

    // 翻訳不要パターン: 数値・パーセント・通貨・時刻・日付・スコアなどのみで構成されるテキスト
    // 例: "0%", "$12.50", "3:45", "98/100", "1,234", "+5", "−3.2", "12:30:00"
    const NUMERIC_ONLY_RE = /^[\s\d%$€¥£₩.,/:;\-+−×xX*#()\[\]{}°℃℉]+$/;

    // 翻訳不要判定: Unicode の「文字（letter）」を一切含まない場合はスキップ。
    // 絵文字・記号・矢印・アイコンフォント文字・< > などを列挙せずに網羅できる。
    const HAS_LETTER_RE = /\p{L}/u;

    // 高頻度で更新される要素を追跡するためのカウンタ
    // parentElement -> { count, firstSeen }
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
    function getPageContext() {
        try {
            const title = (document.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            const hostname = (location?.hostname || '').slice(0, 120);
            const pageLang = (document.documentElement?.lang || '').trim().slice(0, 16);
            return { title, hostname, pageLang };
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

        const japaneseChars = (sampleText.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g) || []).length;
        const latinLetters = (sampleText.match(/[a-zA-Z]/g) || []).length;
        const len = sampleText.length;
        const jaRatio = japaneseChars / len;

        // 冒頭テキストが主にラテン文字なら英語等とみなす（lang=ja-JP でもスキップしない）
        if (latinLetters >= 60 && jaRatio < 0.06 && japaneseChars < latinLetters * 0.12) {
            return 'other';
        }

        // 日本語文字が十分多ければ日本語ページ
        if (jaRatio > 0.1) return 'ja';

        // html lang / meta が日本向けだが、本文に日本語が少しはあるケース
        const lang = document.documentElement.lang?.toLowerCase() || '';
        const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.content?.toLowerCase() || '';
        if ((lang.startsWith('ja') || metaLang.startsWith('ja')) && jaRatio > 0.03) {
            return 'ja';
        }

        // 英語混在の日本語コンテンツ（比率だけでは lang ほど出ない）
        if (jaRatio > 0.05) return 'ja';

        return 'other';
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
     * TreeWalker 用: テキストノードを翻訳対象とするか
     * @param {Text} node
     * @returns {boolean}
     */
    function isTranslatableTextNode(node) {
        if (!node.parentElement) return false;
        if (SKIP_TAGS.has(node.parentElement.tagName)) return false;
        if (node.parentElement.closest('pre, code')) return false;
        if (node.parentElement.closest('[contenteditable="true"]')) return false;
        if (node.parentElement.id === 'llm-translate-tooltip') return false;
        if (node.parentElement.id === 'llm-translate-badge') return false;
        // notranslate クラスまたは translate="no" 属性を持つ祖先はスキップ
        if (node.parentElement.closest('.notranslate, [translate="no"]')) return false;
        // aria-hidden="true" の要素はスクリーンリーダーから隠されており翻訳不要
        if (node.parentElement.closest('[aria-hidden="true"]')) return false;
        // role="presentation" / "none" は装飾要素
        const role = node.parentElement.closest('[role]')?.getAttribute('role');
        if (role === 'presentation' || role === 'none') return false;
        // Material Icons / Google Symbols / Font Awesome などアイコンフォントのクラスはスキップ
        const el = node.parentElement.closest('[class]');
        if (el) {
            const cls = el.className;
            if (/\b(material-icons?|material-symbols?[-\w]*|google-symbols?|fa[srbldc]?\s|glyphicon|bi\s|codicon)\b/.test(cls)) return false;
        }
        const text = node.textContent.trim();
        if (text.length < MIN_TEXT_LENGTH) return false;
        // 数値・パーセント・通貨のみで構成されるテキストは翻訳不要
        if (NUMERIC_ONLY_RE.test(text)) return false;
        // 翻訳可能な文字（letter）を含まない場合はスキップ（絵文字・記号・アイコン等を網羅）
        if (!HAS_LETTER_RE.test(text)) return false;
        // aria-live や role="timer" など、リアルタイム更新される領域はスキップ
        const liveAncestor = node.parentElement.closest('[aria-live], [role="timer"], [role="status"], [role="progressbar"]');
        if (liveAncestor) {
            const ariaLive = liveAncestor.getAttribute('aria-live');
            // aria-live="polite" は通知用途なのでスキップ、"off" は対象外
            if (ariaLive === 'assertive' || ariaLive === 'polite') return false;
            const role = liveAncestor.getAttribute('role');
            if (role === 'timer' || role === 'progressbar') return false;
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
    function collectTextNodes() {
        if (!document.body) return [];
        return collectTextNodesInTree(document.body);
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
     * 翻訳結果を 1 つのテキストノードに適用する共通処理。
     * 先頭/末尾の空白（インデント・改行）を保持しながら置換し、マーカーを付与する。
     * @param {Text} node
     * @param {string} translated - 翻訳後テキスト（trim 済み）
     * @param {string} [expectedOriginal] - 翻訳リクエスト時の原文（trim 済み）。
     *   指定された場合、ノードの現在テキストが変化していたら適用をスキップする。
     *   動的サイトで API 応答が返るまでにテキストが変わった場合の誤上書きを防ぐ。
     * @returns {boolean} DOM を書き換えた場合 true
     */
    function applyTranslationToNode(node, translated, expectedOriginal) {
        if (!node || !node.isConnected) return false;
        if (!translated) return false;
        const origFull = node.textContent;

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
        if (newText === origFull) return false;

        state.originalTexts.set(node, origFull);
        node.textContent = newText;
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
            const translated = state.translatedTextCache.get(text);
            if (translated) {
                applyTranslationToNode(node, translated);
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
        const maxApiBatches = typeof opts.maxApiBatches === 'number' ? opts.maxApiBatches : Infinity;
        const fresh = collectTextNodes();
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
            const cached = state.translatedTextCache.get(item.text);
            if (cached) {
                if (applyTranslationToNode(item.node, cached)) cachedApplied++;
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
            if (!textToNodes.has(item.text)) textToNodes.set(item.text, []);
            textToNodes.get(item.text).push(item);
        }
        const uniqueItems = [...textToNodes.keys()].map((text) => {
            const first = textToNodes.get(text)[0];
            return { node: first.node, text, role: first.role || 'body' };
        });

        const maxChars = batchMaxChars === 0 ? Infinity : batchMaxChars;
        let batches = chunkByChars(uniqueItems, maxChars);
        if (Number.isFinite(maxApiBatches)) batches = batches.slice(0, maxApiBatches);

        const pageContext = getPageContext();
        const CONCURRENCY_LIMIT = 3;
        const results = await runWithConcurrency(batches, CONCURRENCY_LIMIT, async (batch) => {
            if (state.isCancelled) return null;
            const texts = batch.map((item) => item.text);
            const roles = batch.map((item) => item.role || 'body');
            const response = await safeSendMessage({
                type: 'TRANSLATE', texts, roles, pageContext, targetLang, host: location.hostname
            });
            if (!response.success) throw new Error(response.error);
            return { batch, translatedTexts: response.translatedTexts };
        });

        let apiApplied = 0;
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
                state.translatedTextCache.set(batch[j].text, translated);
                const nodes = textToNodes.get(batch[j].text) || [batch[j]];
                for (const { node } of nodes) {
                    if (applyTranslationToNode(node, translated, batch[j].text)) apiApplied++;
                }
            }
        }

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

        const startTime = performance.now();
        let collectElapsed = 0;
        let apiElapsed = 0;
        let domElapsed = 0;

        try {
            const collectStart = performance.now();
            const allTextNodes = collectTextNodes();
            collectElapsed = performance.now() - collectStart;

            // デデュープ: テキスト → ノード群のマップ（同一テキストは1回だけAPIに送信）
            const textToNodes = new Map();
            for (const item of allTextNodes) {
                if (!textToNodes.has(item.text)) textToNodes.set(item.text, []);
                textToNodes.get(item.text).push(item);
            }

            // ユニークなテキストのみバッチ処理
            const uniqueItems = [...textToNodes.keys()].map(text => {
                const first = textToNodes.get(text)[0];
                return { node: first.node, text, role: first.role || 'body' };
            });
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

            const pageContext = getPageContext();
            const apiStart = performance.now();
            // 並列でAPIリクエストを送信
            const batchResults = await runWithConcurrency(batches, CONCURRENCY_LIMIT, async (batch) => {
                if (state.isCancelled) return null;
                const texts = batch.map(item => item.text);
                const roles = batch.map(item => item.role || 'body');
                const response = await safeSendMessage({
                    type: 'TRANSLATE', texts, roles, pageContext, targetLang, host: location.hostname
                });
                if (!response.success) throw new Error(response.error);
                return { batch, translatedTexts: response.translatedTexts };
            });
            apiElapsed = performance.now() - apiStart;

            // キャンセルチェック
            if (state.isCancelled) {
                contentLogger.info('翻訳がキャンセルされました');
                showStatusBadge('⏹ キャンセル', 'cancelled');
                setTimeout(() => hideStatusBadge(), 2000);
                return { outcome: 'cancelled' };
            }

            // 全バッチ完了後にまとめてDOM更新
            const domStart = performance.now();
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
                    if (!translated) {
                        // null の場合は訳文未取得。API 失敗だけでなく無効キャッシュも含む。
                        contentLogger.warn(`翻訳結果なし: "${batch[j].text.slice(0, 50)}..."`);
                        continue;
                    }
                    // 再レンダー時の即時再適用のため、原文 → 訳文をキャッシュしておく
                    state.translatedTextCache.set(batch[j].text, translated);
                    // 同一テキストを持つ全ノードに翻訳を適用
                    const nodes = textToNodes.get(batch[j].text) || [batch[j]];
                    for (const { node } of nodes) {
                        applyTranslationToNode(node, translated, batch[j].text);
                    }
                }
                processed += batch.length;
                const percent = Math.round((processed / total) * 100);
                showStatusBadge(`🔄 ${percent}%`, 'translating');
                if (onProgress) {
                    onProgress(processed, total);
                }
            }

            domElapsed = performance.now() - domStart;

            // 再レンダー取りこぼし回収パス。
            // React/Next.js などのハイドレーションは初回 API 応答前後に発生し、
            // applyTranslationToNode が持つ Text ノード参照が DOM から外れてしまう結果、
            // ユーザー視点では「ほとんど翻訳されないままのページ」になってしまうことがある。
            // ここで DOM を再スキャンし、キャッシュに訳文があるものは即時反映、
            // ハイドレーション後に新しく現れた未知の原文は追加 API 呼び出しで補う。
            // 進行中ハイドレーションを拾うため、短い間隔で最大3パス試みる。
            // 部分失敗時も成功した訳文のキャッシュを再レンダー後の DOM に反映したいので、
            // 失敗チェックより前に実行する。
            const reconcileStart = performance.now();
            let reconcileTotalCached = 0;
            let reconcileTotalApi = 0;
            let reconcileApiCalls = 0;
            for (let pass = 0; pass < 3; pass++) {
                if (state.isCancelled) break;
                // 1回目は DOM 反映直後に素早く、2回目以降はハイドレーション完了を
                // 待つため少し待機する。
                if (pass > 0) await new Promise((r) => setTimeout(r, 400));
                // 追加の API 呼び出しは累計で最大 4 バッチに制限（暴走防止）
                const budgetLeft = Math.max(0, 4 - reconcileApiCalls);
                const stats = await reconcileDomWithCache(targetLang, batchMaxChars, {
                    maxApiBatches: budgetLeft
                });
                reconcileTotalCached += stats.cachedApplied;
                reconcileTotalApi += stats.apiApplied;
                reconcileApiCalls += stats.apiCalls;
                if (stats.cachedApplied === 0 && stats.apiApplied === 0) break;
            }
            const reconcileElapsed = performance.now() - reconcileStart;

            if (failedBatchCount > 0) {
                if (processed > 0 || reconcileTotalCached > 0 || reconcileTotalApi > 0) {
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
            const totalElapsed = performance.now() - startTime;
            contentLogger.info(
                `翻訳完了: ${allTextNodes.length}件のテキスト / ${batches.length}バッチ ` +
                `| 合計 ${totalElapsed.toFixed(0)}ms ` +
                `(収集 ${collectElapsed.toFixed(0)}ms, API ${apiElapsed.toFixed(0)}ms, ` +
                `DOM更新 ${domElapsed.toFixed(0)}ms, 再スキャン ${reconcileElapsed.toFixed(0)}ms ` +
                `[キャッシュ復元 ${reconcileTotalCached}件 / 追加API ${reconcileTotalApi}件])`
            );

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
        if (state.originalTexts.has(node)) return false;
        if (!isTranslatableTextNode(node)) return false;

        // 高頻度更新ノードの検出: 同じ親要素のテキストが短期間に何度も変化している場合はスキップ
        const parent = node.parentElement;
        if (parent) {
            const now = Date.now();
            const entry = volatileNodeTracker.get(parent);
            if (entry) {
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
                volatileNodeTracker.set(parent, { firstSeen: now, count: 1 });
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
    }

    /**
     * open ShadowRoot に MutationObserver を張る（同一 shadow に二重登録しない）
     * @param {Node} root
     */
    function observeOpenShadowRootsUnder(root) {
        if (!mutationObserver || !root) return;
        const elWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
        let el;
        while ((el = elWalker.nextNode())) {
            const sr = el.shadowRoot;
            if (sr && !observedShadowRoots.has(sr)) {
                observedShadowRoots.add(sr);
                mutationObserver.observe(sr, { childList: true, subtree: true });
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
        if (pendingMutationNodes.size === 0) return;

        // 接続中かつ未翻訳のノードのみに絞る
        const validItems = [];
        for (const [node, meta] of pendingMutationNodes) {
            if (node.isConnected && !state.originalTexts.has(node)) {
                validItems.push({ node, text: meta.text, role: meta.role });
            }
        }
        pendingMutationNodes.clear();

        if (validItems.length === 0) return;

        // 最初にコンテンツスクリプト内キャッシュで拾えるものを同期適用（再レンダー耐性）
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
        const batches = chunkByChars(uncachedItems, maxChars);
        const pageContext = getPageContext();

        for (const batch of batches) {
            if (state.isCancelled) break;

            const texts = batch.map(item => item.text);
            const roles = batch.map(item => item.role || 'body');
            try {
                const response = await safeSendMessage({
                    type: 'TRANSLATE',
                    texts,
                    roles,
                    pageContext,
                    targetLang,
                    host: location.hostname
                });

                if (!response.success) {
                    contentLogger.error(`動的コンテンツバッチ翻訳失敗: ${response.error}`);
                    continue;
                }

                const { translatedTexts } = response;
                for (let i = 0; i < batch.length; i++) {
                    const translated = translatedTexts[i];
                    if (!translated) continue;
                    // 以降の再レンダーで即時復元できるようキャッシュ
                    state.translatedTextCache.set(batch[i].text, translated);
                    applyTranslationToNode(batch[i].node, translated, batch[i].text);
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

        observedShadowRoots = new WeakSet();

        mutationObserver = new MutationObserver((mutations) => {
            let hasNewNodes = false;

            for (const mutation of mutations) {
                for (const addedNode of mutation.addedNodes) {
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
            return { element: el, text, start, end };
        } catch {
            return null;
        }
    }

    /**
     * 選択テキストを翻訳する（通常DOM選択 / input・textarea 内選択の両方に対応）
     */
    async function translateSelection(targetLang) {
        // 1) input / textarea 内の選択を優先チェック
        const inputSel = getInputSelection();
        // 2) 通常の DOM 選択
        const domSelection = window.getSelection();
        const domSelectedText = domSelection?.toString()?.trim() || '';

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

            const translated = response.translatedTexts[0];
            const domStart = performance.now();

            if (translated && translated !== selectedText) {
                if (isInputMode) {
                    // input / textarea: 選択範囲を翻訳結果で置換
                    const el = inputSel.element;
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
                    const range = domSelection.getRangeAt(0);
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
            }

            const domElapsed = performance.now() - domStart;
            const totalElapsed = performance.now() - startTime;
            showStatusBadge('✅ 翻訳完了', 'done');
            setTimeout(() => hideStatusBadge(), 2000);
            contentLogger.info(
                `選択テキスト翻訳完了${isInputMode ? '(入力欄)' : ''}: ${selectedText.length}文字 ` +
                `| 合計 ${totalElapsed.toFixed(0)}ms ` +
                `(API ${apiElapsed.toFixed(0)}ms, DOM更新 ${domElapsed.toFixed(0)}ms)`
            );
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
