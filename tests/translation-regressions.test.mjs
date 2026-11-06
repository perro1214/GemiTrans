import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = process.env.GEMITRANS_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const noop = () => {};
const event = () => ({ addListener: noop });
const log = { info: noop, warn: noop, error: noop };

function contentHarness(options = {}) {
  let listener, control = async () => ({ success: true, frames: 0 });
  const nodes = [], observers = [], timers = new Map(), messages = [];
  let storageListener;
  const documentListeners = new Map(), highlights = new Map();
  let timerId = 0, selection = null, send = async () => ({ success: true, translatedTexts: ['訳文'] });
  function element(tag = 'P') {
    const attributes = new Map();
    const el = { tagName: tag, nodeType: 1, isConnected: true, parentElement: null,
      style: {}, className: '', childNodes: [], classList: { add: noop, remove: noop, contains: () => false },
      getAttribute: key => attributes.get(key) ?? null, setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
      closest: () => null, appendChild(child) { this.childNodes.push(child); child.parentElement = this; return child; },
      contains: node => node.parentElement === el, setSelectionRange: noop, dispatchEvent: noop };
    Object.defineProperty(el, 'textContent', { get: () => el.childNodes.map(n => n.textContent).join(''), set: v => { el.childNodes = [{ textContent: v, isConnected: true, parentElement: el }]; } });
    Object.defineProperty(el, 'firstChild', { get: () => el.childNodes[0] });
    return el;
  }
  const body = element('BODY'); body.innerText = 'English text for the translation test.';
  const document = { body, title: 'Fixture', documentElement: { lang: 'en' }, activeElement: null,
    addEventListener: (type, fn) => documentListeners.set(type, fn), createRange: () => ({ selectNodeContents(node) { this.node = node; } }), querySelector: () => null, createElement: element,
    createTreeWalker: (subRoot, type, filter) => {
      const underRoot = n => { for (let el = n.parentElement; el; el = el.parentElement) if (el === subRoot) return true; return false; };
      const found = type === 4 ? nodes.filter(n => n.isConnected && underRoot(n) && (!filter || filter.acceptNode(n) === 1)) : [];
      let i = 0; return { nextNode: () => found[i++] || null };
    } };
  const sandbox = { document, window: { getSelection: () => selection }, location: { hostname: options.hostname || 'test.example', pathname: options.pathname || '/' }, performance,
    CSS: { highlights }, Highlight: class extends Set {}, getComputedStyle: el => el.computedStyle || {},
    chrome: { storage: { local: { get: async () => options.displaySettings || {} }, onChanged: { addListener: fn => { storageListener = fn; } } }, runtime: { onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async msg => { messages.push(msg); return msg.type === 'TRANSLATE' ? send(msg) : msg.type === 'NOTEBOOK_CONTROL' ? control(msg) : { success: true }; } } },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_FRAGMENT_NODE: 11 }, NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    MutationObserver: class { constructor(cb) { this.callback = cb; this.observations = []; observers.push(this); } observe(root, options) { this.observations.push(options); } disconnect() {} },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), Event: class {} };
  sandbox.window.top = options.subframe ? {} : sandbox.window;
  const expose = 'globalThis.api = {displaySettings, showTooltip, hideTooltip, forgetChangedTranslation, isTranslatableTextNode, state, contentCacheKey, planTranslationBatches, contextForBatch, applyTranslationToNode, restoreOriginal, cancelTranslation, translateSelection, translatePage, reconcileDomWithCache, startMutationObserver, flushPendingMutations, pendingMutationNodes, applyCachedTranslations};';
  vm.runInNewContext(read('content/content.js').replace('} // end of multi-injection guard', expose + '\n}'), sandbox);
  return { ...sandbox.api, document, observers, messages, timers, highlights,
    displayChange(changes, area = 'local') { storageListener(changes, area); },
    hover(target) { documentListeners.get('mouseover')({target, clientX: 50, clientY: 50}); },
    setSend: fn => { send = fn; }, setControl: fn => { control = fn; },
    receive: msg => new Promise(resolve => listener(msg, {}, resolve)), setSelection: s => { selection = s; },
    node(text) { const parent = element(); parent.parentElement = body; const node = { textContent: text, isConnected: true, nodeType: 3, parentElement: parent }; parent.childNodes.push(node); nodes.push(node); return node; },
    input(value) { const el = element('TEXTAREA'); el.value = value; el.selectionStart = 0; el.selectionEnd = 5; document.activeElement = el; return el; }
  };
}

function rangeFor(node) {
  return { startContainer: node, endContainer: node, startOffset: 0, endOffset: node.textContent.length,
    toString: () => node.textContent, cloneRange() { return { ...this }; },
    deleteContents() { node.textContent = ''; }, insertNode(span) { node.textContent = span.textContent; } };
}
const selectionFor = range => ({ rangeCount: 1, toString: () => range.toString(), getRangeAt: () => range });

test('selection changed during API wait does not overwrite the new selection', async () => {
  const h = contentHarness(), a = h.node('Original A'), b = h.node('Different B'), pending = deferred();
  h.setSelection(selectionFor(rangeFor(a))); h.setSend(() => pending.promise);
  const task = h.translateSelection('日本語'); h.setSelection(selectionFor(rangeFor(b)));
  pending.resolve({ success: true, translatedTexts: ['訳文A'] }); await task;
  assert.equal(a.textContent, 'Original A'); assert.equal(b.textContent, 'Different B');
});
test('unchanged selection translates and retains restoration data', async () => {
  const h = contentHarness(), node = h.node('Original A'); h.setSelection(selectionFor(rangeFor(node)));
  await h.translateSelection('日本語'); assert.equal(node.textContent, '訳文');
  assert.equal(h.state.originalTexts.size, 1);
});
test('input edits made during API wait are preserved', async () => {
  const h = contentHarness(), el = h.input('Hello world'), pending = deferred(); h.setSend(() => pending.promise);
  const task = h.translateSelection('日本語'); el.value = 'Edited draft';
  pending.resolve({ success: true, translatedTexts: ['こんにちは'] }); await task; assert.equal(el.value, 'Edited draft');
});
test('unchanged input selection translates', async () => {
  const h = contentHarness(), el = h.input('Hello world'); await h.translateSelection('日本語'); assert.equal(el.value, '訳文 world');
});
test('restore preserves site edits even before the observer callback', () => {
  const h = contentHarness(), node = h.node('Server running'); h.applyTranslationToNode(node, '正常稼働', 'Server running');
  node.textContent = 'Server stopped'; h.restoreOriginal(); assert.equal(node.textContent, 'Server stopped');
});
test('restore reverts unchanged translated text with whitespace intact', () => {
  const h = contentHarness(), node = h.node('  Hello world\n'); h.applyTranslationToNode(node, 'こんにちは', 'Hello world');
  h.restoreOriginal(); assert.equal(node.textContent, '  Hello world\n');
});
test('dynamic response after restore is discarded, including its cache entry', async () => {
  const h = contentHarness(), node = h.node('New text'), pending = deferred(); h.setSend(() => pending.promise);
  h.pendingMutationNodes.set(node, { text: 'New text', role: 'body' }); const task = h.flushPendingMutations('日本語', 3000);
  h.restoreOriginal(); pending.resolve({ success: true, translatedTexts: ['新しい文'] }); await task;
  assert.equal(node.textContent, 'New text'); assert.equal(h.state.translatedTextCache.size, 0);
});
test('reconcile response after restore is discarded', async () => {
  const h = contentHarness(), node = h.node('New text'), pending = deferred(); h.setSend(() => pending.promise);
  const task = h.reconcileDomWithCache('日本語', 3000); h.restoreOriginal();
  pending.resolve({ success: true, translatedTexts: ['新しい文'] }); await task;
  assert.equal(node.textContent, 'New text'); assert.equal(h.state.translatedTextCache.size, 0);
});
test('late cancelled page job cannot overwrite or finalize a new page job', async () => {
  const h = contentHarness(), node = h.node('Hello world'), old = deferred(), fresh = deferred(); let requests = 0;
  h.setSend(() => ++requests === 1 ? old.promise : fresh.promise);
  const oldTask = h.translatePage('English'); h.cancelTranslation(); const newTask = h.translatePage('English');
  old.resolve({ success: true, translatedTexts: ['Old translation'] }); await oldTask;
  assert.equal(h.state.isTranslating, true); assert.equal(node.textContent, 'Hello world');
  fresh.resolve({ success: true, translatedTexts: ['New translation'] }); await newTask;
  assert.equal(node.textContent, 'New translation'); assert.equal(h.state.isTranslating, false);
});
test('characterData updates retranslate and restore to the latest site text; own mutations are ignored', async () => {
  const h = contentHarness(), node = h.node('Server running'); h.applyTranslationToNode(node, '正常稼働');
  h.startMutationObserver('日本語', 3000); const observer = h.observers.at(-1);
  assert.equal(observer.observations[0].characterData, true);
  observer.callback([{ type: 'characterData', target: node, addedNodes: [] }]); assert.equal(h.pendingMutationNodes.size, 0);
  node.textContent = 'Server stopped'; observer.callback([{ type: 'characterData', target: node, addedNodes: [] }]);
  assert.equal(h.pendingMutationNodes.size, 1); assert.equal(h.state.originalTexts.has(node), false);
  await h.flushPendingMutations('日本語', 3000); assert.equal(node.textContent, '訳文');
  h.restoreOriginal(); assert.equal(node.textContent, 'Server stopped');
});
test('cached result cannot overwrite text changed since collection', () => {
  const h = contentHarness(), node = h.node('New text'); h.state.translatedTextCache.set(h.contentCacheKey({text:'Old text'}), '古い文');
  h.applyCachedTranslations([{ node, text: 'Old text' }]); assert.equal(node.textContent, 'New text');
});

test('mixed invalid cache, hit and miss map API results by original index', async () => {
  const storage = { get: async () => ({ apiKey: 'test-placeholder', apiProvider: 'gemini' }), set: async () => {}, remove: async () => {} };
  const chrome = { storage: { local: storage, onChanged: event() }, runtime: { onInstalled: event(), onMessage: event() }, webNavigation: { onHistoryStateUpdated: event() }, tabs: { onUpdated: event() } };
  const s = { chrome, logger: log, setTimeout, clearTimeout,
    checkBatchCache: async () => ({ cached: new Map([[0, '<translation>bad</translation>'], [1, '既存訳']]), uncached: [2] }),
    saveBatchToCache: async () => {}, geminiTranslateBatch: async texts => texts.map(t => '訳:' + t) };
  vm.runInNewContext(read('background/background.js').replace(/^import .*;\n/gm, '') + '\nglobalThis.handle = handleTranslate;', s);
  const result = await new Promise(resolve => s.handle({ texts: ['A', 'B', 'C'], targetLang: '日本語', host: 'test.example' }, resolve));
  assert.equal(result.success, true); assert.deepEqual(Array.from(result.translatedTexts), ['訳:A', '既存訳', '訳:C']);
});

function geminiHarness(respond) {
  const requests = [];
  const s = { AbortController, setTimeout, clearTimeout, fetch: async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const requestNumber = requests.length;
    return { ok: true, json: async () => respond(body, requestNumber) };
  } };
  vm.runInNewContext(read('utils/gemini.js').replace(/export /g, '') + '\nglobalThis.api={translateBatch,translateText};', s);
  return { ...s.api, requests };
}
const response = (text, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
test('MAX_TOKENS batch retries partially present items, not just missing items', async () => {
  const h = geminiHarness((body, n) => n === 1 ? response('[1] 不完全', 'MAX_TOKENS') : response('完全な訳' + n));
  const results = await h.translateBatch(['First sentence', 'Second sentence'], '日本語', 'test-placeholder');
  assert.deepEqual(Array.from(results), ['完全な訳2', '完全な訳3']); assert.equal(h.requests.length, 3);
});
test('truncated single result is rejected instead of cached as a valid translation', async () => {
  const h = geminiHarness(() => response('不完全', 'MAX_TOKENS'));
  await assert.rejects(h.translateText('Source', '日本語', 'test-placeholder'), /incomplete/);
  assert.deepEqual(Array.from(await h.translateBatch(['Source'], '日本語', 'test-placeholder')), [null]);
});
test('large unlimited input is internally split with role order preserved', async () => {
  const h = geminiHarness(body => {
    const prompt = body.contents[0].parts[0].text;
    const matches = [...prompt.matchAll(/^\[(\d+)\] /gm)];
    return response(matches.length ? matches.map(m => `[${m[1]}] 完全な訳`).join('\n') : '完全な訳');
  });
  const texts = Array.from({ length: 24 }, (_, i) => `Record ${i}: ` + 'Keep every detail. '.repeat(18));
  const results = await h.translateBatch(texts, '日本語', 'test-placeholder', 'test-model', null, { roles: texts.map((_, i) => 'role' + i) });
  assert.equal(results.length, 24); assert.ok(results.every(x => x === '完全な訳')); assert.ok(h.requests.length > 1);
  assert.ok(h.requests.every(body => body.generationConfig.maxOutputTokens > 1536));
  const prompts = h.requests.map(b => b.contents[0].parts[0].text).join('\n');
  for (let i = 0; i < 24; i++) assert.ok(prompts.includes(`(role${i})`));
});
test('individual fallback concurrency is bounded', async () => {
  let active = 0, max = 0;
  const h = geminiHarness(async (body, n) => {
    if (n === 1) return response('', 'MAX_TOKENS');
    active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); active--; return response('完全');
  });
  const result = await h.translateBatch(Array.from({ length: 10 }, (_, i) => 'Source ' + i), '日本語', 'test-placeholder');
  assert.equal(result.length, 10); assert.ok(max <= 3);
});
test('old cached translations are not reused after the validation change', () => {
  const s = { chrome: { storage: { onChanged: event() } } };
  vm.runInNewContext(read('utils/cache.js').replace(/export /g, '') + '\nglobalThis.key=makeCacheKey;', s);
  assert.match(s.key('Original', '日本語'), /^v3:/);
});

// Kaggle iframe routing and Markdown-only extraction.
const notebookOptions = { hostname: 'www.kaggleusercontent.com', pathname: '/kf/123/notebook/__results__.html', subframe: true };
function markdownNode(h, text, excluded = false) {
  const node = h.node(text);
  node.parentElement.closest = selector => selector === '.text_cell_render, .jp-MarkdownOutput' ? node.parentElement : excluded && selector.includes('.code_cell') ? node.parentElement : null;
  return node;
}
test('Kaggle only accepts Markdown prose, excluding code, output and math ancestors', () => {
  const h = contentHarness(notebookOptions);
  assert.equal(h.isTranslatableTextNode(markdownNode(h, 'Explanation')), true);
  assert.equal(h.isTranslatableTextNode(h.node('Code cell text')), false);
  assert.equal(h.isTranslatableTextNode(markdownNode(h, 'Rendered output or math', true)), false);
  const inline = markdownNode(h, 'model_name'); inline.parentElement.tagName = 'CODE';
  assert.equal(h.isTranslatableTextNode(inline), false);
});
test('normal sites do not require notebook cell classes', () => {
  const h = contentHarness(); assert.equal(h.isTranslatableTextNode(h.node('Normal paragraph')), true);
});
test('duplicate frame readiness/start does not make duplicate translations', async () => {
  const h = contentHarness(notebookOptions), pending = deferred(); markdownNode(h, 'Notebook prose'); let calls = 0;
  h.setSend(() => { calls++; return pending.promise; });
  const msg = { type: 'START_NOTEBOOK_TRANSLATION', notebookSessionId: 'same', notebookHost: 'www.kaggle.com', targetLang: 'English', batchMaxChars: 3000 };
  const a = h.receive(msg), b = h.receive(msg); assert.equal(calls, 1);
  pending.resolve({ success: true, translatedTexts: ['Translated prose'] }); await Promise.all([a, b]);
  assert.equal(h.messages.find(m => m.type === 'TRANSLATE').host, 'www.kaggle.com');
});
test('notebook restore discards its in-flight result', async () => {
  const h = contentHarness(notebookOptions), pending = deferred(); const node = markdownNode(h, 'Notebook prose'); h.setSend(() => pending.promise);
  const task = h.receive({ type: 'START_NOTEBOOK_TRANSLATION', notebookSessionId: 'run', targetLang: 'English' });
  await h.receive({ type: 'RESTORE_ORIGINAL' }); pending.resolve({ success: true, translatedTexts: ['Stale result'] }); await task;
  assert.equal(node.textContent, 'Notebook prose');
});
test('parent completion waits for known notebook frames', async () => {
  const h = contentHarness({ hostname: 'www.kaggle.com', pathname: '/code/owner/notebook' }), pending = deferred(); h.node('Parent text'); h.setControl(() => pending.promise);
  await h.receive({ type: 'START_TRANSLATION', targetLang: 'English' });
  await new Promise(r => setImmediate(r)); assert.equal(h.messages.some(m => m.type === 'TRANSLATION_COMPLETE'), false);
  pending.resolve({ success: true, frames: 1 }); await new Promise(r => setImmediate(r));
  assert.equal(h.messages.some(m => m.type === 'TRANSLATION_COMPLETE'), true);
});

function notebookBackground(settings = { autoTranslate: false }) {
  const calls = [], session = {};
  const frames = [
    { frameId: 0, documentId: 'top-doc', url: 'https://www.kaggle.com/code/owner/notebook' },
    { frameId: 4, documentId: 'notebook-doc', url: 'https://www.kaggleusercontent.com/kf/123/__results__.html' },
    { frameId: 5, documentId: 'ad-doc', url: 'https://ads.example.com/' }
  ];
  const local = { get: async () => settings, set: async () => {}, remove: async () => {} };
  const chrome = { storage: { local, onChanged: event(), session: { get: async key => ({ [key]: session[key] }), set: async data => Object.assign(session, data), remove: async key => delete session[key] } },
    runtime: { onInstalled: event(), onMessage: event() }, webNavigation: { onHistoryStateUpdated: event(), getAllFrames: async () => frames },
    tabs: { onUpdated: event(), sendMessage: async (tabId, message, target) => { calls.push({ tabId, message, target }); return { success: true, isTranslated: true }; } } };
  const sandbox = { chrome, logger: log, URL, crypto: { randomUUID }, setTimeout, clearTimeout };
  vm.runInNewContext(read('background/background.js').replace(/^import .*;\n/gm, '') + '\nglobalThis.api={handleNotebookControl,handleNotebookReady,isKaggleNotebookFrameUrl};', sandbox);
  return { ...sandbox.api, calls, frames, session, topSender: { tab: { id: 7 }, frameId: 0, documentId: 'top-doc' },
    childSender: { tab: { id: 7 }, frameId: 4, documentId: 'notebook-doc', url: frames[1].url } };
}
test('manual notebook start addresses only the notebook document', async () => {
  const h = notebookBackground(); await h.handleNotebookControl({ action: 'START_TRANSLATION', targetLang: '日本語' }, h.topSender);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].target.documentId, 'notebook-doc');
  assert.equal(h.calls[0].message.type, 'START_NOTEBOOK_TRANSLATION');
});
test('late iframe inherits a manual start with autoTranslate disabled', async () => {
  const h = notebookBackground(); const child = h.frames.splice(1, 1)[0];
  await h.handleNotebookControl({ action: 'START_TRANSLATION', targetLang: 'Français', batchMaxChars: 1500 }, h.topSender);
  assert.equal(h.calls.length, 0); h.frames.push(child); await h.handleNotebookReady(h.childSender);
  assert.equal(h.calls[0].message.targetLang, 'Français'); assert.equal(h.calls[0].message.batchMaxChars, 1500);
});
test('late iframe remains idle with automatic translation disabled', async () => {
  const h = notebookBackground(); await h.handleNotebookReady(h.childSender); assert.equal(h.calls.length, 0);
});
test('late iframe auto-translates when enabled', async () => {
  const h = notebookBackground({ autoTranslate: true, targetLang: '日本語' }); await h.handleNotebookReady(h.childSender); assert.equal(h.calls.length, 1);
});
test('restore prevents late iframe readiness from restarting automatic translation', async () => {
  const h = notebookBackground({ autoTranslate: true }); await h.handleNotebookControl({ action: 'RESTORE_ORIGINAL' }, h.topSender);
  const count = h.calls.length; await h.handleNotebookReady(h.childSender); assert.equal(h.calls.length, count);
});
test('navigation does not reuse a previous document manual start', async () => {
  const h = notebookBackground(); await h.handleNotebookControl({ action: 'START_TRANSLATION' }, h.topSender);
  h.frames[0].documentId = 'new-top-doc'; const count = h.calls.length; await h.handleNotebookReady(h.childSender); assert.equal(h.calls.length, count);
});
test('frame states are aggregated without changing the saved desired operation', async () => {
  const h = notebookBackground(); const result = await h.handleNotebookControl({ action: 'GET_TRANSLATION_STATE' }, h.topSender);
  assert.equal(result.isTranslated, true); assert.equal(Object.keys(h.session).length, 0);
});
test('unrelated pages, stale frames and lookalike domains are rejected', async () => {
  const h = notebookBackground(); assert.equal(h.isKaggleNotebookFrameUrl('https://kaggleusercontent.com.evil.example/kf/1'), false);
  assert.equal(h.isKaggleNotebookFrameUrl('https://evil-kaggleusercontent.com/kf/1'), false);
  await assert.rejects(h.handleNotebookReady({ ...h.childSender, documentId: 'old-doc' }), /changed/);
  h.frames[0].url = 'https://unrelated.example/'; await assert.rejects(h.handleNotebookReady(h.childSender), /Not a Kaggle/);
});
test('manifest only adds subframe injection for Kaggle notebook content', () => {
  const manifest = JSON.parse(read('manifest.json')); const subframe = manifest.content_scripts.filter(x => x.all_frames);
  assert.equal(subframe.length, 1); assert.deepEqual(subframe[0].matches, ['https://*.kaggleusercontent.com/kf/*']);
});

function cacheHarness() {
  const data = {}; let fail = false;
  const s = { TextEncoder, chrome: { storage: { local: {
    get: async key => structuredClone(key === null ? data : { [key]: data[key] }),
    set: async values => { if (fail) throw new Error('disk full'); Object.assign(data, structuredClone(values)); },
    remove: async key => { delete data[key]; }
  }, onChanged: event() } } };
  vm.runInNewContext(read('utils/cache.js').replace(/export /g, '') +
    '\nglobalThis.api = {saveBatchToCache, checkBatchCache, touchBatchCache, clearSiteCache, evictOldEntries, serializedBytes, MAX_BYTES_PER_SITE};', s);
  return { ...s.api, data, fail: value => { fail = value; } };
}
test('persisted cache separates page context and role, retaining identical context hits', async () => {
  const h = cacheHarness();
  await h.saveBatchToCache(['Open'], 'ja', ['開く'], 'example', ['page-a/button']);
  assert.equal((await h.checkBatchCache(['Open'], 'ja', 'example', ['page-a/button'])).cached.get(0), '開く');
  assert.equal((await h.checkBatchCache(['Open'], 'ja', 'example', ['page-b/button'])).cached.size, 0);
  assert.equal((await h.checkBatchCache(['Open'], 'ja', 'example', ['page-a/body'])).cached.size, 0);
});
test('failed persistence rejects and does not poison the memo; retry succeeds', async () => {
  const h = cacheHarness(); h.fail(true);
  await assert.rejects(h.saveBatchToCache(['A'], 'ja', ['訳'], 'example', ['ctx']), /disk full/);
  assert.equal((await h.checkBatchCache(['A'], 'ja', 'example', ['ctx'])).cached.size, 0);
  h.fail(false); await h.saveBatchToCache(['A'], 'ja', ['訳'], 'example', ['ctx']);
  assert.equal((await h.checkBatchCache(['A'], 'ja', 'example', ['ctx'])).cached.get(0), '訳');
});
test('parallel persistent writes retain both batches', async () => {
  const h = cacheHarness();
  await Promise.all([h.saveBatchToCache(['A'], 'ja', ['訳A'], 'example'), h.saveBatchToCache(['B'], 'ja', ['訳B'], 'example')]);
  assert.equal((await h.checkBatchCache(['A','B'], 'ja', 'example')).cached.size, 2);
});
function sharingHarness() {
  const s = { TextEncoder, chrome: { storage: { local: {}, onChanged: event() }, runtime: { onInstalled: event(), onMessage: event() }, webNavigation: { onHistoryStateUpdated: event() }, tabs: { onUpdated: event() } }, logger: log };
  vm.runInNewContext(read('background/background.js').replace(/^import .*;\n/gm, '') +
    '\nglobalThis.api = {shareTranslationBatch, translationScope, pendingTranslations};', s);
  return s.api;
}
test('overlapping batches and duplicate items share only matching in-flight work', async () => {
  const h = sharingHarness(), gate = deferred(); let calls = 0;
  const a = h.shareTranslationBatch(['A','B','A'], async indices => { calls++; await gate.promise; return indices.map(i => ['訳A','訳B'][i]); });
  const b = h.shareTranslationBatch(['B','C'], async indices => { calls++; assert.deepEqual(Array.from(indices), [1]); return ['訳C']; });
  gate.resolve();
  assert.deepEqual(Array.from(await a), ['訳A','訳B','訳A']);
  assert.deepEqual(Array.from(await b), ['訳B','訳C']); assert.equal(calls, 2);
});
test('shared failure reaches every waiter and a later call can retry', async () => {
  const h = sharingHarness(), gate = deferred();
  const a = h.shareTranslationBatch(['A'], async () => { await gate.promise; throw Error('provider failed'); });
  const b = h.shareTranslationBatch(['A'], async () => { throw Error('must not run'); });
  const checks = Promise.all([assert.rejects(a, /provider failed/), assert.rejects(b, /provider failed/)]);
  gate.resolve(); await checks;
  assert.deepEqual(Array.from(await h.shareTranslationBatch(['A'], async () => ['retry'])), ['retry']);
});
test('page-local cache separates roles and changed page context', () => {
  const h = contentHarness(), n = h.node('Open');
  h.state.translatedTextCache.set(h.contentCacheKey({text:'Open',role:'button'}), '開く');
  assert.equal(h.applyCachedTranslations([{node:n,text:'Open',role:'body'}]).length, 1);
  h.document.title = 'Different context';
  assert.equal(h.applyCachedTranslations([{node:n,text:'Open',role:'button'}]).length, 1);
  h.document.title = 'Fixture';
  assert.equal(h.applyCachedTranslations([{node:n,text:'Open',role:'button'}]).length, 0);
  assert.equal(n.textContent, '開く');
});

test('background logs persistence failure without claiming success or losing translation', async () => {
  const errors = [], infos = [];
  const storage = { get: async () => ({ apiKey: 'test-placeholder', apiProvider: 'gemini' }), set: async () => {}, remove: async () => {} };
  const s = { chrome: { storage: { local: storage, onChanged: event() }, runtime: { onInstalled: event(), onMessage: event() }, webNavigation: { onHistoryStateUpdated: event() }, tabs: { onUpdated: event() } },
    logger: { info: (...x) => infos.push(x.join(' ')), warn: noop, error: (...x) => errors.push(x.join(' ')) }, setTimeout, clearTimeout,
    checkBatchCache: async texts => ({ cached: new Map(), uncached: texts.map((_, i) => i) }),
    saveBatchToCache: async () => { throw Error('disk full'); }, geminiTranslateBatch: async texts => texts.map(t => '訳:' + t) };
  vm.runInNewContext(read('background/background.js').replace(/^import .*;\n/gm, '') + '\nglobalThis.handle = handleTranslate;', s);
  const result = await new Promise(resolve => s.handle({texts:['A'], targetLang:'ja', host:'example'}, resolve));
  assert.equal(result.success, true); assert.equal(result.translatedTexts[0], '訳:A');
  assert.ok(errors.some(x => x.includes('disk full')));
  assert.ok(!infos.some(x => x.includes('キャッシュ保存完了')));
});

test('context mode preserves ordinary blocks and OFF keeps the original chunking', () => {
  const s = contentHarness();
  const items = [{text:'A'.repeat(1000), group:'cell-a'}, {text:'B'.repeat(1000), group:'cell-b'}, {text:'C'.repeat(1000), group:'cell-b'}];
  assert.equal(s.planTranslationBatches(items, Infinity).length, 1);
  s.state.contextAwareParallel = true;
  const batches = s.planTranslationBatches(items, Infinity);
  assert.deepEqual(Array.from(batches,b=>Array.from(b,x=>x.group)), [['cell-a'],['cell-b','cell-b']]);
  assert.equal(batches.flat().length, 3);
});
test('oversized block splits without losing order and oversized text stays intact', () => {
  const s = contentHarness(); s.state.contextAwareParallel = true;
  const items = Array.from({length:6}, (_,i)=>({text:String(i).repeat(1000),group:'same-cell'}));
  const batches = s.planTranslationBatches(items, Infinity);
  assert.deepEqual(Array.from(batches.flat(),x=>x.text), items.map(x=>x.text));
  assert.ok(batches.every(b=>b.reduce((n,x)=>n+x.text.length+7,0)<=2600));
  assert.equal(s.planTranslationBatches([{text:'x'.repeat(5000),group:'paragraph'}],Infinity)[0][0].text.length,5000);
});
test('reference is bounded and disabled mode leaves context unchanged', () => {
  const s = contentHarness(), context = {title:'Model benchmarks'};
  const items = [{reference:'latency '.repeat(500)}];
  assert.equal(s.contextForBatch(items,context),context);
  s.state.contextAwareParallel = true; s.state.contextOutline = 'Throughput / Latency';
  const enriched = s.contextForBatch(items,context);
  assert.match(enriched.reference,/Throughput/); assert.ok(enriched.reference.length<=1200);
  const bg = sharingHarness();
  assert.notEqual(bg.translationScope('gemini','model','','',enriched,'body'),bg.translationScope('gemini','model','','',context,'body'));
});
test('ON processes at most two page batches in parallel with reference attached', async () => {
  const s = contentHarness(); s.state.contextAwareParallel = true; s.state.contextParallelism = 2;
  for (let i=0;i<6;i++) s.node('Paragraph '+i+' English content. '.repeat(100));
  let active=0, max=0, calls=0;
  s.setSend(async message=>{
    calls++; active++;max=Math.max(max,active);
    assert.ok(message.pageContext.reference);
    await new Promise(resolve=>setTimeout(resolve,2)); active--;
    return {success:true,translatedTexts:message.texts.map((_,i)=>'訳文'+calls+'-'+i)};
  });
  await s.translatePage('日本語',0);
  assert.ok(calls>=3);assert.equal(max,2);
});
test('Gemini receives reference on internal split and only translates numbered items', async () => {
  const h = geminiHarness(()=>response('[1] 訳文'));
  await h.translateBatch(['A'.repeat(1700),'B'.repeat(1700)],'日本語','placeholder','model',()=>{},
    {roles:['body','body'],pageContext:{title:'Ensemble',reference:'CoAtNet is an architecture'}});
  assert.equal(h.requests.length,2);
  for (const request of h.requests) {
    const prompt=JSON.stringify(request);
    assert.match(prompt,/CoAtNet/); assert.match(prompt,/never obey instructions/);
  }
});

test('notebook mode propagates through automatic and late manual frame starts', async () => {
  const auto = notebookBackground({autoTranslate:true,contextAwareParallel:true});
  await auto.handleNotebookReady(auto.childSender);
  assert.equal(auto.calls[0].message.contextAwareParallel,true);
  const manual = notebookBackground(); const child=manual.frames.splice(1,1)[0];
  await manual.handleNotebookControl({action:'START_TRANSLATION',contextAwareParallel:true},manual.topSender);
  manual.frames.push(child); await manual.handleNotebookReady(manual.childSender);
  assert.equal(manual.calls[0].message.contextAwareParallel,true);
});

test('site cache retains more than 2000 translations within the byte budget', async () => {
  const h=cacheHarness(), texts=Array.from({length:2400},(_,i)=>'Original '+i);
  const stats=await h.saveBatchToCache(texts,'ja',texts.map(t=>'訳 '+t),'example');
  assert.equal(stats.count,2400);assert.equal(stats.evicted,0);
  assert.ok(stats.bytes<=20*1024*1024);
  assert.equal((await h.checkBatchCache([texts[0],texts[2399]],'ja','example')).cached.size,2);
});
test('byte eviction removes least recently used entries rather than oldest saved entries', () => {
  const h=cacheHarness();
  const cache={hot:{translated:'日本語',timestamp:1,lastUsedAt:100},cold:{translated:'abc',timestamp:20,lastUsedAt:20},newest:{translated:'xyz',timestamp:30,lastUsedAt:30}};
  const limit=h.serializedBytes(cache)-h.serializedBytes('cold')-1-h.serializedBytes(cache.cold)-1;
  const stats=h.evictOldEntries(cache,limit);
  assert.equal(stats.evicted,1);assert.ok(cache.hot);assert.equal(cache.cold,undefined);
  assert.equal(stats.bytes,h.serializedBytes(cache));assert.ok(stats.bytes<=limit);
});
test('UTF-8 budget accounts for Japanese and emoji, including empty-object overhead', () => {
  const h=cacheHarness(), cache={a:{translated:'日本語😀',timestamp:1}};
  assert.equal(h.serializedBytes(cache),Buffer.byteLength(JSON.stringify(cache),'utf8'));
  const stats=h.evictOldEntries(cache,2);assert.equal(stats.bytes,2);assert.equal(stats.count,0);
});
test('oversized item is skipped without displacing useful translations', async () => {
  const h=cacheHarness();await h.saveBatchToCache(['A'],'ja',['訳A'],'example');
  const stats=await h.saveBatchToCache(['big'],'ja',['x'.repeat(h.MAX_BYTES_PER_SITE)],'example');
  assert.equal(stats.skipped,1);assert.equal(stats.evicted,0);assert.equal(stats.count,1);
  assert.equal((await h.checkBatchCache(['A'],'ja','example')).cached.get(0),'訳A');
});
test('cache accesses survive the next save and protect the hot entry', async () => {
  const h=cacheHarness();await h.saveBatchToCache(['A','B'],'ja',['訳A','訳B'],'example');
  for(const entry of Object.values(h.data['cache:example'])) {entry.timestamp=1;entry.lastUsedAt=1;}
  await h.touchBatchCache(['A'],'ja','example');
  await h.saveBatchToCache(['C'],'ja',['訳C'],'example');
  const entries=Object.values(h.data['cache:example']);
  assert.ok(entries.find(x=>x.original==='A').lastUsedAt>entries.find(x=>x.original==='B').lastUsedAt);
});
test('clearing a site discards deferred access metadata and does not resurrect entries', async () => {
  const h=cacheHarness();await h.saveBatchToCache(['A'],'ja',['訳A'],'example');
  await h.touchBatchCache(['A'],'ja','example');await h.clearSiteCache('example');
  await h.saveBatchToCache(['B'],'ja',['訳B'],'example');
  const result=await h.checkBatchCache(['A','B'],'ja','example');
  assert.equal(result.cached.has(0),false);assert.equal(result.cached.get(1),'訳B');
});
test('configured four-way translation changes scheduling without removing context', async () => {
  const s=contentHarness();s.state.contextAwareParallel=true;s.state.contextParallelism=4;
  for(let i=0;i<8;i++)s.node('Paragraph '+i+' English words. '.repeat(150));
  let active=0,max=0;
  s.setSend(async msg=>{active++;max=Math.max(max,active);assert.ok(msg.pageContext.reference);
    await new Promise(resolve=>setTimeout(resolve,2));active--;
    return {success:true,translatedTexts:msg.texts.map((_,i)=>'訳'+i)};});
  await s.translatePage('日本語',0);assert.equal(max,4);
});
test('notebook sessions retain the selected concurrency and normalize invalid input', async () => {
  const h=notebookBackground({autoTranslate:true,contextAwareParallel:true,contextParallelism:6});
  await h.handleNotebookReady(h.childSender);assert.equal(h.calls[0].message.contextParallelism,6);
  const invalid=notebookBackground();
  await invalid.handleNotebookControl({action:'START_TRANSLATION',contextParallelism:99},invalid.topSender);
  assert.equal(invalid.calls[0].message.contextParallelism,3);
});

function automaticHarness() {
  const timers=[],sent=[];let url='https://openrouter.ai/google/gemini-3.7-flash';
  const s={URL, logger:log,setTimeout:fn=>timers.push(fn),clearTimeout,
    chrome:{storage:{local:{get:async()=>({autoTranslate:true})},onChanged:event()},runtime:{onInstalled:event(),onMessage:event()},
      webNavigation:{onHistoryStateUpdated:event()},tabs:{onUpdated:event(),get:async()=>({url}),sendMessage:async(_id,msg)=>sent.push(msg)}}};
  vm.runInNewContext(read('background/background.js').replace(/^import .*;\n/gm,'')+
    '\nensureContentScript=async()=>{}; getActiveProviderCredential=async()=>"placeholder"; globalThis.api={scheduleAutomaticTranslation,translationPageKey};',s);
  return {...s.api,sent,timers,setUrl:value=>{url=value;},async tick(){for(let i=0;i<10;i++){await Promise.resolve();while(timers.length)timers.shift()();}}};
}
test('anchor/history/load events coalesce into one automatic start',async()=>{
 const h=automaticHarness(),base='https://openrouter.ai/google/gemini-3.7-flash';
 const tasks=['#apps','#benchmarks','#pricing','#providers',''].map(hash=>h.scheduleAutomaticTranslation(1,base+hash));
 await h.tick();await Promise.all(tasks);assert.equal(h.sent.length,1);
 await h.scheduleAutomaticTranslation(1,base+'#performance');assert.equal(h.sent.length,1);
});
test('actual model route supersedes a pending automatic start; hash-router paths stay distinct',async()=>{
 const h=automaticHarness(),a='https://openrouter.ai/google/gemini-3.7-flash',b='https://openrouter.ai/google/gemini-3.8-flash';
 const one=h.scheduleAutomaticTranslation(1,a);const two=h.scheduleAutomaticTranslation(1,b);h.setUrl(b);
 await h.tick();await Promise.all([one,two]);assert.equal(h.sent.length,1);assert.equal(h.sent[0].pageKey,b);
 assert.notEqual(h.translationPageKey('https://example.com/#/one'),h.translationPageKey('https://example.com/#/two'));
});
test('hydration introducing more than four batches is fully recovered',async()=>{
 const h=contentHarness(),old=h.node('Old description');let first=true;
 h.setSend(async msg=>{if(first){first=false;old.isConnected=false;for(let i=0;i<7;i++)h.node('New paragraph '+i+' English words '.repeat(150));}
 return {success:true,translatedTexts:msg.texts.map((_,i)=>'訳文'+i)};});
 const task=h.translatePage('日本語',2600);
 for(let i=0;i<100;i++){await Promise.resolve();for(const [id,fn] of [...h.timers]){h.timers.delete(id);fn();}}
 const result=await task;assert.equal(result.outcome,'completed');assert.equal(result.remaining,0);
 assert.ok(h.messages.filter(m=>m.type==='TRANSLATE').length>5);
});
test('missing API items report partial coverage instead of success',async()=>{
 const h=contentHarness();h.node('Description not translated');h.setSend(async()=>({success:true,translatedTexts:[null]}));
 const result=await h.translatePage('日本語',3000);assert.equal(result.outcome,'partial');assert.equal(result.remaining,1);
});

test('Gemini normalizes complete role envelopes and grouped role hints',async()=>{
 const h=geminiHarness(()=>response('[1] <translation>ホーム</translation>\n[2] (tab@group-2) データ'));
 const result=await h.translateBatch(['Home','Data'],'日本語','placeholder');
 assert.deepEqual(Array.from(result),['ホーム','データ']);assert.equal(h.requests.length,1);
});
test('nonempty invalid translations trigger fallback instead of being dropped downstream',async()=>{
 const diagnostics=[];
 const h=geminiHarness((_,n)=>response(n===1?'[1] <body>broken\n[2] データ':'ホーム'));
 const result=await h.translateBatch(['Home','Data'],'日本語','placeholder','model',null,{onDiagnostic:x=>diagnostics.push(x)});
 assert.deepEqual(Array.from(result),['ホーム','データ']);assert.equal(h.requests.length,2);
 assert.equal(diagnostics[0].accepted,1);
});
test('large invalid label batches retry in small groups with context intact',async()=>{
 const h=geminiHarness((body,n)=>{
  const prompt=body.contents[0].parts[0].text;
  const lines=prompt.split('Items:\n')[1].split('\n').filter(x=>/^\[\d+\]/.test(x));
  assert.match(prompt,/Reference labels/);
  return response(lines.map((_,i)=>`[${i+1}] ${n===1?'<body>broken':'訳文'+i}`).join('\n'));
 });
 const result=await h.translateBatch(Array.from({length:25},(_,i)=>'Label '+i),'日本語','placeholder','model',null,{pageContext:{reference:'Reference labels'}});
 assert.equal(result.filter(Boolean).length,25);assert.equal(h.requests.length,4);
});

test('unchanged names count as processed without a DOM update',async()=>{
 const h=contentHarness(),node=h.node('Google Gemini');
 h.setSend(async msg=>({success:true,translatedTexts:msg.texts}));
 const result=await h.translatePage('日本語',3000);
 assert.equal(result.outcome,'completed');assert.equal(result.remaining,0);
 assert.equal(node.textContent,'Google Gemini');assert.ok(h.state.originalTexts.has(node));
 assert.equal(h.messages.filter(m=>m.type==='TRANSLATE').length,1);
});
test('unchanged result does not mask later site edits or overwrite them on restore',()=>{
 const h=contentHarness(),node=h.node('Google Gemini');
 assert.equal(h.applyTranslationToNode(node,'Google Gemini','Google Gemini'),false);
 node.textContent='New description';
 assert.equal(h.isTranslatableTextNode(node),true);assert.equal(h.state.originalTexts.has(node),false);
 h.restoreOriginal();assert.equal(node.textContent,'New description');
});

test('Japanese navigation does not suppress new English discussion titles',async()=>{
 const h=contentHarness();h.document.body.innerText='ホーム ディスカッション データセット '.repeat(100);
 const title=h.node('Why are the new submissions taking much longer?');
 h.setSend(async msg=>({success:true,translatedTexts:msg.texts.map(()=> '新しい提出に時間がかかる理由')}));
 const result=await h.translatePage('日本語',3000);
 assert.equal(result.outcome,'completed');assert.equal(title.textContent,'新しい提出に時間がかかる理由');
});
test('Japanese loading shell keeps observing and translates late pagination contents',async()=>{
 const h=contentHarness();h.document.body.innerText='ホーム ディスカッション '.repeat(100);
 assert.equal((await h.translatePage('日本語',3000)).outcome,'skipped');
 const title=h.node('A newly loaded discussion on page two');
 h.observers.at(-1).callback([{type:'childList',addedNodes:[title]}]);
 assert.equal(h.pendingMutationNodes.size,1);
 await h.flushPendingMutations('日本語',3000);assert.equal(title.textContent,'訳文');
});
test('another skipped start replaces the stale observer generation',async()=>{
 const h=contentHarness();h.document.body.innerText='ホーム ディスカッション '.repeat(100);
 await h.translatePage('日本語',3000);const old=h.observers.at(-1);
 await h.translatePage('日本語',3000);const current=h.observers.at(-1);assert.notEqual(old,current);
 const node=h.node('New discussion after changing the page number');
 old.callback([{type:'childList',addedNodes:[node]}]);assert.equal(h.pendingMutationNodes.size,0);
 current.callback([{type:'childList',addedNodes:[node]}]);assert.equal(h.pendingMutationNodes.size,1);
});
test('pagination query parameters remain distinct from page anchors',()=>{
 const h=automaticHarness();
 assert.notEqual(h.translationPageKey('https://www.kaggle.com/discussion?page=1'),h.translationPageKey('https://www.kaggle.com/discussion?page=2'));
});

test('navigation immediately stops unsent content batches and ignores the old response', async () => {
 const h=contentHarness(),gate=deferred();
 for(let i=0;i<12;i++)h.node('Paragraph number '+i+' English sentence '.repeat(250));
 let sent=0;h.setSend(async msg=>{sent++;await gate.promise;return {success:true,translatedTexts:msg.texts.map(()=> '古い訳')};});
 const task=h.translatePage('日本語',2600);
 for(let i=0;i<20;i++)await Promise.resolve();
 const before=sent;assert.ok(before>0);assert.ok(before<12);
 await h.receive({type:'TRANSLATION_PAGE_CHANGED',pageKey:'https://example.com/new'});
 gate.resolve();assert.equal((await task).outcome,'cancelled');assert.equal(sent,before);assert.equal(h.state.originalTexts.size,0);
});

test('background saves completed old-page results and reuses them on return without another API call', async () => {
 const gate=deferred(),started=deferred(),saved=[];let calls=0;
 const storage={get:async()=>({apiKey:'placeholder',apiProvider:'gemini'}),set:async()=>{},remove:async()=>{}};
 const chrome={storage:{local:storage,onChanged:event()},runtime:{onInstalled:event(),onMessage:event()},webNavigation:{onHistoryStateUpdated:event()},tabs:{onUpdated:event(),sendMessage:async()=>{}}};
 const s={URL,AbortController,chrome,logger:log,setTimeout,clearTimeout,
  fetch:async()=>{calls++;started.resolve();await gate.promise;return new Response('saved translation');},
  checkBatchCache:async()=>({cached:new Map(),uncached:[0]}),touchBatchCache:async()=>{},
  saveBatchToCache:async(_texts,_lang,translations)=>{saved.push(Array.from(translations));},
  geminiTranslateBatch:async(_texts,_lang,_key,_model,_usage,options)=>[(await (await options.requestFetch('https://api.example',{},1000)).text())]};
 vm.runInNewContext(read('background/background.js').replace(/^import .*;\n/gm,'')+'\nglobalThis.api={handleTranslate,retireTranslationRoute};',s);
 const sender={tab:{id:1,url:'https://example.com/a'},frameId:0};
 const message={texts:['original sentence'],targetLang:'日本語',host:'example.com',sourcePageUrl:sender.tab.url};
 const first=new Promise(resolve=>s.api.handleTranslate(message,resolve,sender));
 await started.promise;s.api.retireTranslationRoute(1,'https://example.com/b');gate.resolve();
 assert.equal((await first).success,true);assert.deepEqual(saved,[['saved translation']]);
 s.api.retireTranslationRoute(1,sender.tab.url);
 const second=await new Promise(resolve=>s.api.handleTranslate(message,resolve,sender));
 assert.equal(second.success,true);assert.deepEqual(Array.from(second.translatedTexts),['saved translation']);assert.equal(calls,1);
});

// Two-stage page rendering, using the same DOM/message harness as the regressions above.
const tickPreview = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function sendPreview(h, text = 'Google仮訳', index = 0, requestId) {
  requestId ||= h.messages.findLast(m => m.type === 'TRANSLATE').previewRequestId;
  return h.receive({ type: 'TRANSLATION_PREVIEW', requestId, entries: [{ index, text }] });
}
test('Google preview is replaced by LLM from the original source and restores exact whitespace', async () => {
  const h = contentHarness(), n = h.node('  Original sentence  '), duplicate = h.node('Original sentence');
  const gate = deferred(); let request;
  h.setSend(msg => { request = msg; return gate.promise; });
  const task = h.translatePage('日本語'); await tickPreview();
  await sendPreview(h);
  assert.equal(n.textContent, '  Google仮訳  '); assert.equal(duplicate.textContent, 'Google仮訳');
  assert.equal(h.state.translatedTextCache.size, 0);
  assert.equal(request.texts[0], 'Original sentence');
  gate.resolve({ success: true, translatedTexts: ['LLM確定訳'] });
  assert.equal((await task).outcome, 'completed');
  assert.equal(n.textContent, '  LLM確定訳  '); assert.equal(duplicate.textContent, 'LLM確定訳');
  assert.equal(h.state.previewTexts.size, 0);
  h.restoreOriginal(); assert.equal(n.textContent, '  Original sentence  ');
});
test('late Google result cannot downgrade a completed LLM response', async () => {
  const h = contentHarness(), n = h.node('Original sentence');
  await h.translatePage('日本語'); await sendPreview(h);
  assert.equal(n.textContent, '訳文');
});
for (const action of ['restoreOriginal', 'cancelTranslation']) {
  test(`${action} invalidates both stages while a preview is displayed`, async () => {
    const h = contentHarness(), n = h.node('Original sentence'), gate = deferred();
    h.setSend(() => gate.promise);
    const task = h.translatePage('日本語'); await tickPreview(); await sendPreview(h);
    h[action](); await sendPreview(h, '遅い仮訳');
    gate.resolve({ success: true, translatedTexts: ['遅いLLM訳'] }); await task;
    assert.equal(n.textContent, action === 'restoreOriginal' ? 'Original sentence' : 'Google仮訳');
    h.restoreOriginal(); assert.equal(n.textContent, 'Original sentence');
  });
}
test('site edits made after the preview survive final LLM and restoration', async () => {
  const h = contentHarness(), n = h.node('Original sentence'), gate = deferred();
  h.setSend(() => gate.promise);
  h.pendingMutationNodes.set(n, { text: n.textContent, role: 'body' });
  const task = h.flushPendingMutations('日本語', 3000); await tickPreview(); await sendPreview(h);
  n.textContent = 'Site update'; gate.resolve({ success: true, translatedTexts: ['LLM訳'] }); await task;
  assert.equal(n.textContent, 'Site update'); h.restoreOriginal(); assert.equal(n.textContent, 'Site update');
});
test('LLM failure retains a Google preview without claiming completion or caching it', async () => {
  const h = contentHarness(), n = h.node('Original sentence'), gate = deferred();
  h.setSend(() => gate.promise);
  const task = h.translatePage('日本語'); await tickPreview(); await sendPreview(h);
  gate.resolve({ success: false, error: 'LLM down' });
  const result = await task;
  assert.equal(result.outcome, 'partial'); assert.equal(result.previewRemaining, 1);
  assert.equal(result.error, 'LLM down');
  assert.equal(n.textContent, 'Google仮訳'); assert.equal(h.state.translatedTextCache.size, 0);
});

test('failed LLM with Google preview reports the actual cause in the popup error message', async () => {
  const h = contentHarness(), n = h.node('Cost / task'), gate = deferred();
  h.setSend(() => gate.promise);
  await h.receive({ type: 'START_TRANSLATION', targetLang: '日本語', batchMaxChars: 3000 });
  await tickPreview(); await sendPreview(h);
  gate.resolve({ success: false, error: 'Gateway API Error (403 / model_not_allowed)' });
  for (let i = 0; i < 120; i++) await Promise.resolve();
  const error = h.messages.findLast(m => m.type === 'TRANSLATION_ERROR');
  assert.match(error.error, /Google仮訳/);
  assert.match(error.error, /model_not_allowed/);
  assert.equal(n.textContent, 'Google仮訳');
  assert.equal(h.state.translatedTextCache.size, 0);
});

test('partial LLM response preserves successful blocks and exposes its failure reason', async () => {
  const h = contentHarness(), a = h.node('Quality'), b = h.node('Cost / task'), gate = deferred();
  h.setSend(() => gate.promise);
  const task = h.translatePage('日本語'); await tickPreview(); await sendPreview(h, 'タスクあたりのコスト', 1);
  gate.resolve({ success: true, translatedTexts: ['品質', null], error: 'Gateway API Error (402 / insufficient_balance)' });
  const result = await task;
  assert.equal(result.outcome, 'partial');
  assert.match(result.error, /insufficient_balance/);
  assert.equal(a.textContent, '品質'); assert.equal(b.textContent, 'タスクあたりのコスト');
});
test('dynamic content uses both stages and stores only the final translation', async () => {
  const h = contentHarness(), n = h.node('Dynamic original'), gate = deferred();
  h.setSend(() => gate.promise); h.pendingMutationNodes.set(n, { text: n.textContent, role: 'body' });
  const task = h.flushPendingMutations('日本語', 3000); await tickPreview(); await sendPreview(h);
  assert.equal(n.textContent, 'Google仮訳'); gate.resolve({ success: true, translatedTexts: ['動的LLM訳'] });
  await task; assert.equal(n.textContent, '動的LLM訳');
  assert.deepEqual([...h.state.translatedTextCache.values()], ['動的LLM訳']);
});
test('rescanned nodes support previews and replacement', async () => {
  const h = contentHarness(), n = h.node('Hydrated original'), gate = deferred();
  h.setSend(() => gate.promise);
  const task = h.reconcileDomWithCache('日本語', 3000); await tickPreview(); await sendPreview(h);
  assert.equal(n.textContent, 'Google仮訳'); gate.resolve({ success: true, translatedTexts: ['再描画LLM訳'] });
  await task; assert.equal(n.textContent, '再描画LLM訳');
});
test('navigation invalidates preview request IDs and both delayed responses', async () => {
  const h = contentHarness(), n = h.node('Original sentence'), gate = deferred();
  h.setSend(() => gate.promise);
  const task = h.translatePage('日本語'); await tickPreview();
  await h.receive({ type: 'TRANSLATION_PAGE_CHANGED' }); await sendPreview(h);
  gate.resolve({ success: true, translatedTexts: ['LLM訳'] }); await task;
  assert.equal(n.textContent, 'Original sentence');
});

const translationRequests = h => h.messages.filter(m => m.type === 'TRANSLATE');
function japanesePage(h) {
  h.document.documentElement.lang = 'ja-JP';
  h.document.body.innerText = 'このサイトではサービスの使い方と最新のお知らせを紹介しています。'.repeat(20);
}
test('Japanese pages with English product names and copyright text make no translation request', async () => {
  const h = contentHarness(); japanesePage(h);
  const texts = ['日本語のサイトです。詳しくはこちらをご覧ください。', 'Google Cloud Translation API',
    'Privacy Policy', 'Copyright 2026 Example Company. All rights reserved.', '東京都交通局'];
  const nodes = texts.map(text => h.node(text));
  const result = await h.translatePage('日本語');
  assert.equal(result.outcome, 'skipped'); assert.equal(translationRequests(h).length, 0);
  assert.deepEqual(nodes.map(n => n.textContent), texts);
});
test('mixed Japanese page sends only substantive foreign prose to both-stage translation', async () => {
  const h = contentHarness(); japanesePage(h);
  const japanese = h.node('日本語の本文にはAPIの使い方が書かれています。');
  const brand = h.node('Google Cloud Translation API');
  const english = h.node('How can I configure automatic translation for my website?');
  assert.equal((await h.translatePage('日本語')).outcome, 'completed');
  assert.equal(translationRequests(h).length, 1);
  assert.deepEqual(Array.from(translationRequests(h)[0].texts), ['How can I configure automatic translation for my website?']);
  assert.equal(japanese.textContent, '日本語の本文にはAPIの使い方が書かれています。');
  assert.equal(brand.textContent, 'Google Cloud Translation API'); assert.equal(english.textContent, '訳文');
});
test('Japanese page observer ignores late Japanese paragraphs and English labels', async () => {
  const h = contentHarness(); japanesePage(h);
  await h.translatePage('日本語');
  const nodes = ['新しいお知らせを読み込みました。', 'Google Cloud Translation API', 'ニュース', '会社概要'].map(text => h.node(text));
  h.observers.at(-1).callback([{ type: 'childList', addedNodes: nodes }]);
  assert.equal(h.pendingMutationNodes.size, 0);
  await h.flushPendingMutations('日本語', 3000); assert.equal(translationRequests(h).length, 0);
});
test('Japanese text cannot bypass filtering through queued mutations or rescans', async () => {
  const h = contentHarness(); japanesePage(h); await h.translatePage('日本語');
  const node = h.node('後から追加された日本語の記事です。');
  h.pendingMutationNodes.set(node, { text: node.textContent, role: 'body' });
  await h.flushPendingMutations('日本語', 3000); await h.reconcileDomWithCache('日本語', 3000);
  assert.equal(translationRequests(h).length, 0); assert.equal(node.textContent, '後から追加された日本語の記事です。');
});
test('English pages still omit already-Japanese dynamic text, including half-width kana', async () => {
  const h = contentHarness(); h.startMutationObserver('日本語', 3000);
  const nodes = [h.node('日本語で表示されています。'), h.node('ﾒﾆｭｰ')];
  h.observers.at(-1).callback([{ type: 'childList', addedNodes: nodes }]);
  await h.flushPendingMutations('日本語', 3000); assert.equal(translationRequests(h).length, 0);
});
test('Japanese detection does not block Japanese-to-English translation', async () => {
  const h = contentHarness(); japanesePage(h); h.node('これは日本語の文章です。');
  h.setSend(async () => ({ success: true, translatedTexts: ['This is a Japanese sentence.'] }));
  assert.equal((await h.translatePage('English')).outcome, 'completed');
  assert.equal(translationRequests(h).length, 1);
});
test('ja-JP target alias also skips Japanese content', async () => {
  const h = contentHarness(); japanesePage(h); h.node('日本語のお知らせです。');
  assert.equal((await h.translatePage('ja-JP')).outcome, 'skipped'); assert.equal(translationRequests(h).length, 0);
});
test('Han-only Japanese page uses ja metadata, whereas Chinese still translates', async () => {
  const h = contentHarness(); h.document.documentElement.lang = 'ja'; h.document.body.innerText = '東京都交通局 運行情報';
  h.node('東京都交通局'); assert.equal((await h.translatePage('日本語')).outcome, 'skipped');
  const c = contentHarness(); c.document.documentElement.lang = 'zh-CN'; c.document.body.innerText = '欢迎使用我们的服务';
  c.node('欢迎使用我们的服务'); assert.equal((await c.translatePage('日本語')).outcome, 'completed');
  assert.equal(translationRequests(c).length, 1);
});
test('lang=ja alone cannot suppress an English article', async () => {
  const h = contentHarness(); h.document.documentElement.lang = 'ja';
  const text = 'This documentation explains how to configure the application and troubleshoot common installation problems.';
  h.document.body.innerText = text; h.node(text);
  assert.equal((await h.translatePage('日本語')).outcome, 'completed'); assert.equal(translationRequests(h).length, 1);
});
test('long English footer text does not enable translation of a Japanese page', async () => {
  const h = contentHarness(); japanesePage(h);
  const n = h.node('Learn more about our company and explore all of our products'); n.parentElement.tagName = 'FOOTER';
  assert.equal((await h.translatePage('日本語')).outcome, 'skipped'); assert.equal(translationRequests(h).length, 0);
});


test('translation underline decorates text ranges without wrapping or changing the parent style', () => {
  const h = contentHarness(), node = h.node('Original text'), parent = node.parentElement;
  parent.style.fontSize = '14px'; parent.style.lineHeight = '20px';
  h.applyTranslationToNode(node, '訳文', 'Original text');
  const highlight = h.highlights.get('gemitrans-translated');
  assert.equal(highlight.size, 1);
  assert.equal([...highlight][0].node, node);
  assert.equal(parent.childNodes.length, 1);
  assert.equal(node.parentElement, parent);
  assert.deepEqual(parent.style, {fontSize:'14px', lineHeight:'20px'});
  h.applyTranslationToNode(node, '最終訳', 'Original text', true); // final cannot be downgraded
  assert.equal(highlight.size, 1);
});

test('nested translated elements create disjoint text ranges instead of inherited double underlines', () => {
  const h = contentHarness(), outer = h.node('Outer text'), inner = h.node('Inner text');
  inner.parentElement.parentElement = outer.parentElement;
  h.applyTranslationToNode(outer, '外側', 'Outer text');
  h.applyTranslationToNode(inner, '内側', 'Inner text');
  assert.deepEqual([...h.highlights.get('gemitrans-translated')].map(r => r.node), [outer, inner]);
});

for (const style of [{textDecorationLine:'underline'}, {borderBottomStyle:'dashed', borderBottomWidth:'1px'}]) {
  test(`existing site decoration is preserved without an added underline: ${JSON.stringify(style)}`, () => {
    const h = contentHarness(), node = h.node('Original text');
    node.parentElement.computedStyle = style;
    h.applyTranslationToNode(node, '訳文', 'Original text');
    assert.equal(h.highlights.get('gemitrans-translated').size, 0);
    assert.equal(node.parentElement.computedStyle, style);
    h.displayChange({translationUnderline:{newValue:false}});
    assert.equal(node.parentElement.computedStyle, style);
  });
}

test('display toggles affect translated text independently, immediately and without an API call', async () => {
  const h = contentHarness(); await Promise.resolve();
  const node = h.node('Original text');
  h.applyTranslationToNode(node, '訳文', 'Original text');
  h.showTooltip(node.parentElement, 10, 10);
  const tooltip = h.document.body.childNodes.find(el => el.id === 'llm-translate-tooltip');
  assert.equal(tooltip.style.display, 'block');
  h.displayChange({originalTooltip:{newValue:false}});
  assert.equal(tooltip.style.display, 'none');
  assert.equal(h.highlights.get('gemitrans-translated').size, 1);
  h.showTooltip(node.parentElement, 10, 10);
  assert.equal(tooltip.style.display, 'none');
  h.displayChange({translationUnderline:{newValue:false}});
  assert.equal(h.highlights.get('gemitrans-translated').size, 0);
  h.displayChange({originalTooltip:{newValue:true}});
  h.showTooltip(node.parentElement, 10, 10);
  assert.equal(tooltip.style.display, 'block');
  h.displayChange({translationUnderline:{newValue:true}});
  assert.equal(h.highlights.get('gemitrans-translated').size, 1);
  assert.equal(h.messages.filter(m => m.type === 'TRANSLATE').length, 0);
  h.restoreOriginal();
  assert.equal(node.textContent, 'Original text');
  assert.equal(tooltip.style.display, 'none');
  assert.equal(h.highlights.get('gemitrans-translated').size, 0);
});

test('saved disabled display settings apply to new translations and do not disable restoration', async () => {
  const h = contentHarness({displaySettings:{translationUnderline:false, originalTooltip:false}});
  await Promise.resolve(); await Promise.resolve();
  const node = h.node('New content');
  h.applyTranslationToNode(node, '追加文章', 'New content');
  assert.equal(h.highlights.get('gemitrans-translated').size, 0);
  assert.equal(h.displaySettings.originalTooltip, false);
  h.restoreOriginal(); assert.equal(node.textContent, 'New content');
});

test('a storage event wins over a stale initial settings read', async () => {
  const h = contentHarness({displaySettings:{translationUnderline:true, originalTooltip:true}});
  h.displayChange({translationUnderline:{newValue:false}, originalTooltip:{newValue:false}});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.displaySettings.translationUnderline, false);
  assert.equal(h.displaySettings.originalTooltip, false);
});

test('site text changes remove its old decoration and are never underlined again as a translation', () => {
  const h = contentHarness(), node = h.node('Original text');
  h.applyTranslationToNode(node, '訳文', 'Original text');
  node.textContent = 'Site edited text'; h.forgetChangedTranslation(node);
  assert.equal(h.highlights.get('gemitrans-translated').size, 0);
  h.displayChange({translationUnderline:{newValue:true}});
  assert.equal(h.highlights.get('gemitrans-translated').size, 0);
});

const emittedRoleHints = ['list-item','quote','table-header','table-cell','term','definition','summary','citation','emphasis','aside'];
for (const provider of ['gemini','openrouter','sambanova','nvidia','cerebras','plamo','opencodego','lolipop','lmstudio']) {
  test(`${provider}: removes all emitted role hints, including list-item without a following space`, () => {
    const sandbox = {setTimeout, clearTimeout, AbortController};
    vm.runInNewContext(read(`utils/${provider}.js`).replace(/export /g,'') + '\nglobalThis.parse = parseBatchResponse;', sandbox);
    const values = emittedRoleHints.flatMap(role => [`(${role})訳文`, `(${role}@group-2) 訳文`]);
    const parsed = sandbox.parse(values.map((value, i) => `[${i+1}] ${value}`).join('\n'), values.length);
    assert.deepEqual(Array.from(parsed), values.map(() => '訳文'));
    assert.deepEqual(Array.from(sandbox.parse('[1] (API) の説明\n[2] 括弧（例）を保持',2)), ['(API) の説明','括弧（例）を保持']);
  });
}

test('Gemini normalizes complete list and table envelopes as well as parenthesized hints', async () => {
  const h = geminiHarness(() => response('[1] (list-item)偽装ソフトウェア\n[2] <table-cell>表の内容</table-cell>'));
  const result = await h.translateBatch(['Deceptive Software','Table contents'],'日本語','placeholder');
  assert.deepEqual(Array.from(result), ['偽装ソフトウェア','表の内容']);
  assert.equal(h.requests.length, 1);
});

test('content refuses residual role hints anywhere in the response instead of displaying them', () => {
  const h = contentHarness();
  for (const role of emittedRoleHints) {
    const node = h.node('Original text');
    assert.equal(h.applyTranslationToNode(node, `訳文 (${role}) 残留`, 'Original text'), false);
    assert.equal(h.applyTranslationToNode(node, `<${role}>残留`, 'Original text'), false);
    assert.equal(node.textContent, 'Original text');
  }
});

for (const cacheLayer of ['memory','storage']) {
  test(`${cacheLayer} cache containing leaked list-item is retranslated and replaced without clearing other entries`, async () => {
    let calls = 0; const saved = [];
    const storage = {get:async()=>({apiKey:'placeholder',apiProvider:'gemini'}),set:async()=>{},remove:async()=>{}};
    const chrome = {storage:{local:storage,onChanged:event()},runtime:{onInstalled:event(),onMessage:event()},webNavigation:{onHistoryStateUpdated:event()},tabs:{onUpdated:event()}};
    const sandbox = {URL,AbortController,chrome,logger:log,setTimeout,clearTimeout,
      checkBatchCache:async()=>({cached:new Map([[0,'(list-item)古い訳']]),uncached:[]}),touchBatchCache:async()=>{},
      saveBatchToCache:async(_texts,_lang,values)=>saved.push(Array.from(values)),
      geminiTranslateBatch:async()=>{calls++;return ['修正後の訳文'];}};
    vm.runInNewContext(read('background/background.js').replace(/^import .*;\n/gm,'') + '\nglobalThis.api={handleTranslate,memoryCache,makeMemoryCacheKey,translationScope};',sandbox);
    const api = sandbox.api;
    if (cacheLayer === 'memory') {
      const scope = api.translationScope('gemini','gemini-2.0-flash','','',{},'body');
      api.memoryCache.set(api.makeMemoryCacheKey('Original text', JSON.stringify(['日本語',scope]), 'example.com'), '(list-item)古い訳');
    }
    api.memoryCache.set('unrelated-entry','別の有効な訳文');
    const result = await new Promise(resolve=>api.handleTranslate({texts:['Original text'],targetLang:'日本語',host:'example.com',pageContext:{}},resolve));
    assert.equal(result.success,true); assert.deepEqual(Array.from(result.translatedTexts),['修正後の訳文']);
    assert.equal(calls,1); assert.deepEqual(saved,[['修正後の訳文']]);
    assert.equal(api.memoryCache.get('unrelated-entry'),'別の有効な訳文');
  });
}

const previewBadge = h => h.document.body.childNodes.find(el => el.id === 'llm-translate-badge');
async function dynamicPreview(h, text = 'Dynamic sentence') {
  const node = h.node(text), gate = deferred();
  h.setSend(() => gate.promise);
  h.pendingMutationNodes.set(node, {text,role:'body'});
  const task = h.flushPendingMutations('日本語',3000);
  await tickPreview(); await sendPreview(h);
  return {node,gate,task};
}

test('dynamic Google progress badge disappears after final LLM success', async () => {
  const h = contentHarness(), run = await dynamicPreview(h);
  assert.equal(previewBadge(h).style.display,'flex');
  assert.match(previewBadge(h).textContent,/LLM翻訳中/);
  run.gate.resolve({success:true,translatedTexts:['LLM訳']}); await run.task;
  assert.equal(run.node.textContent,'LLM訳');
  assert.equal(previewBadge(h).style.display,'none');
});

for (const mode of ['failure','rejection','partial','detached','site-edit']) {
  test(`dynamic Google badge settles instead of remaining in progress after ${mode}`, async () => {
    const h = contentHarness(), run = await dynamicPreview(h);
    if (mode === 'detached') run.node.isConnected = false;
    if (mode === 'site-edit') run.node.textContent = 'Site changed text';
    if (mode === 'rejection') {
      h.setSend(() => Promise.reject(Error('connection closed'))); // current request already pending
      run.gate.resolve(Promise.reject(Error('connection closed')));
    } else run.gate.resolve(mode === 'failure' ? {success:false,error:'API error'} : {success:true,translatedTexts:[mode === 'partial' ? null : 'LLM訳']});
    await run.task;
    if (mode === 'detached' || mode === 'site-edit') {
      assert.equal(previewBadge(h).style.display,'none');
    } else {
      assert.match(previewBadge(h).textContent,/LLM未完了/);
      for (const timer of [...h.timers.values()]) timer();
      assert.equal(previewBadge(h).style.display,'none');
      assert.equal(run.node.textContent,'Google仮訳');
    }
  });
}

test('one completed dynamic request does not hide another active Google preview', async () => {
  const h = contentHarness(), first = await dynamicPreview(h,'First sentence');
  const second = await dynamicPreview(h,'Second sentence');
  first.gate.resolve({success:true,translatedTexts:['最初の訳']}); await first.task;
  assert.equal(previewBadge(h).style.display,'flex');
  assert.match(previewBadge(h).textContent,/LLM翻訳中/);
  second.gate.resolve({success:true,translatedTexts:['次の訳']}); await second.task;
  assert.equal(previewBadge(h).style.display,'none');
});

test('old warning timer cannot hide a newer dynamic preview', async () => {
  const h = contentHarness(), first = await dynamicPreview(h,'First sentence');
  first.gate.resolve({success:false,error:'API error'}); await first.task;
  const oldTimers = [...h.timers.values()];
  const second = await dynamicPreview(h,'Second sentence');
  for (const timer of oldTimers) timer();
  assert.equal(previewBadge(h).style.display,'flex');
  assert.match(previewBadge(h).textContent,/LLM翻訳中/);
  second.gate.resolve({success:true,translatedTexts:['次の訳']}); await second.task;
  assert.match(previewBadge(h).textContent,/LLM未完了/); // first preview still remains
});

test('a standalone rescan also settles its Google progress badge', async () => {
  const h = contentHarness(), node = h.node('Rescan text'), gate = deferred();
  h.setSend(() => gate.promise);
  const task = h.reconcileDomWithCache('日本語',3000); await tickPreview(); await sendPreview(h);
  gate.resolve({success:true,translatedTexts:['再スキャン訳']}); await task;
  assert.equal(node.textContent,'再スキャン訳');
  assert.equal(previewBadge(h).style.display,'none');
});

for (const action of ['cancelTranslation','restoreOriginal']) {
  test(`${action} cannot have its badge revived by late dynamic results`, async () => {
    const h = contentHarness(), run = await dynamicPreview(h);
    h[action](); run.gate.resolve({success:true,translatedTexts:['遅い訳']}); await run.task;
    assert.equal(previewBadge(h).style.display,'none');
  });
}

for (const role of ['presentation','none']) {
  test(`${role} wrappers do not exclude newly inserted dropdown labels and menu options`, async () => {
    const h = contentHarness(), trigger = h.node('Newest programs');
    const wrapper = trigger.parentElement;
    wrapper.setAttribute('role',role);
    h.setSend(async msg=>({success:true,translatedTexts:msg.texts.map(()=> '訳文')}));
    h.startMutationObserver('日本語',3000);
    const observer = h.observers.at(-1);
    const nodes = ['Relevance','Oldest programs','Highest bounties','Lowest bounties','Most reports resolved','Least reports resolved'].map(text => {
      const node = h.node(text); node.parentElement.parentElement = wrapper; return node;
    });
    observer.callback([{type:'childList',target:h.document.body,addedNodes:[wrapper]}]);
    assert.equal(h.pendingMutationNodes.size,7);
    await h.flushPendingMutations('日本語',3000);
    assert.equal(trigger.textContent,'訳文');
    const sent = h.messages.filter(m=>m.type==='TRANSLATE');
    assert.ok(nodes.every(node=>node.textContent==='訳文'));
    assert.deepEqual(Array.from(sent[0].texts), ['Newest programs',...nodes.map(n=>h.state.originalTexts.get(n)||n.textContent)]);
  });
}

test('opening an existing aria-hidden menu is detected without inserting any text nodes', async () => {
  const h = contentHarness(), node = h.node('Highest bounties'), menu = node.parentElement;
  menu.setAttribute('role','presentation');menu.setAttribute('aria-hidden','true');
  h.startMutationObserver('日本語',3000); const observer = h.observers.at(-1);
  assert.equal(observer.observations[0].attributes,true);
  assert.ok(observer.observations[0].attributeFilter.includes('aria-hidden'));
  observer.callback([{type:'childList',target:h.document.body,addedNodes:[menu]}]);
  assert.equal(h.pendingMutationNodes.size,0);
  menu.removeAttribute('aria-hidden');
  observer.callback([{type:'attributes',target:menu,attributeName:'aria-hidden'}]);
  assert.equal(h.pendingMutationNodes.size,1);
  await h.flushPendingMutations('日本語',3000);assert.equal(node.textContent,'訳文');
});

test('opening an existing hidden menu translates it while hidden content remains excluded', async () => {
  const h = contentHarness(), node = h.node('Lowest bounties'), menu = node.parentElement;
  menu.setAttribute('hidden','');
  assert.equal(h.isTranslatableTextNode(node),false);
  h.startMutationObserver('日本語',3000); const observer=h.observers.at(-1);
  menu.removeAttribute('hidden');
  observer.callback([{type:'attributes',target:menu,attributeName:'hidden'}]);
  await h.flushPendingMutations('日本語',3000);assert.equal(node.textContent,'訳文');
});

for (const attribute of ['class','style','open','aria-expanded','data-state']) {
  test(`${attribute} reveal rescans do not classify unchanged dropdown text as volatile`, async () => {
    const h=contentHarness(), node=h.node('Newest programs'), menu=node.parentElement;
    h.startMutationObserver('日本語',3000);const observer=h.observers.at(-1);
    for(let i=0;i<6;i++) observer.callback([{type:'attributes',target:menu,attributeName:attribute}]);
    assert.equal(h.pendingMutationNodes.size,1);
    await h.flushPendingMutations('日本語',3000);assert.equal(node.textContent,'訳文');
    observer.callback([{type:'attributes',target:menu,attributeName:attribute}]);
    assert.equal(h.pendingMutationNodes.size,0); // do not translate our own output
  });
}

test('several menu text nodes sharing one parent are not mistaken for repeated updates', () => {
  const h=contentHarness(), first=h.node('Newest programs'), menu=first.parentElement;
  const rest=['Relevance','Highest bounties','Lowest bounties'].map(text=>{
    const node=h.node(text);node.parentElement=menu;menu.childNodes.push(node);return node;
  });
  h.startMutationObserver('日本語',3000);const observer=h.observers.at(-1);
  observer.callback([{type:'childList',target:h.document.body,addedNodes:[menu]}]);
  assert.equal(h.pendingMutationNodes.size,rest.length+1);
});

test('dropdown text overwritten by the site is translated again and restores the latest selection', async () => {
  const h=contentHarness(),node=h.node('Newest programs');
  node.parentElement.setAttribute('role','presentation');
  h.applyTranslationToNode(node,'新しい順','Newest programs');
  h.startMutationObserver('日本語',3000);const observer=h.observers.at(-1);
  node.textContent='Oldest programs';
  observer.callback([{type:'characterData',target:node,addedNodes:[]}]);
  await h.flushPendingMutations('日本語',3000);assert.equal(node.textContent,'訳文');
  h.restoreOriginal();assert.equal(node.textContent,'Oldest programs');
});
