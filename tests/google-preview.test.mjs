import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { translateGooglePreview, googleTargetLanguage, decodeGoogleText } from '../utils/googletranslate.js';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const noop = () => {};
const event = () => ({ addListener: noop });
const log = { info: noop, warn: noop, error: noop };
const response = texts => ({ ok: true, json: async () => ({ data: { translations: texts.map(translatedText => ({ translatedText })) } }) });

test('Google request uses NMT, text format, original inputs and key outside URL; decodes entities once', async () => {
  const chunks = [];
  await translateGooglePreview(['A & B', 'C'], '日本語', 'placeholder', {
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://translation.googleapis.com/language/translate/v2');
      assert.equal(init.headers['X-Goog-Api-Key'], 'placeholder');
      assert.deepEqual(JSON.parse(init.body), { q: ['A & B', 'C'], target: 'ja', format: 'text', model: 'nmt' });
      return response(['A &amp; B', '&#x65e5;&#26412; &amp;lt;']);
    }, onChunk: entries => chunks.push(entries)
  });
  assert.deepEqual(chunks[0], [{ index: 0, text: 'A & B' }, { index: 1, text: '日本 &lt;' }]);
  assert.equal(decodeGoogleText('&#x110000;'), '&#x110000;');
});
test('every popup target maps to a Google language code, including Traditional Chinese', () => {
  const html = fs.readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const select = html.split('id="target-lang"')[1].split('</select>')[0];
  for (const match of select.matchAll(/value="([^"]+)"/g)) assert.ok(googleTargetLanguage(match[1]));
  assert.equal(googleTargetLanguage('繁體中文'), 'zh-TW');
  assert.throws(() => googleTargetLanguage('unknown language'));
});
test('Google splits item and Unicode budgets, skips oversized nodes, preserving source indexes', async () => {
  const texts = [...Array(130).fill('x'), '😀'.repeat(5001), '日'.repeat(4800), '尾'.repeat(201)];
  const indices = [], sizes = [];
  await translateGooglePreview(texts, 'ja', 'placeholder', {
    fetchImpl: async (_url, init) => {
      const q = JSON.parse(init.body).q; sizes.push(q.length);
      assert.ok(q.length <= 128); assert.ok(q.reduce((n, t) => n + Array.from(t).length, 0) <= 5000);
      return response(q.map(() => '訳'));
    }, onChunk: entries => indices.push(...entries.map(e => e.index))
  });
  assert.deepEqual(sizes, [128, 3, 1]);
  assert.deepEqual(indices, texts.map((_, i) => i).filter(i => i !== 130));
});
test('Google queue bounds all requests to two, and cancels queued work', async () => {
  const gate = deferred(), controllers = Array.from({ length: 6 }, () => new AbortController());
  let active = 0, max = 0, calls = 0;
  const jobs = controllers.map(controller => translateGooglePreview(['A'], 'ja', 'placeholder', {
    signal: controller.signal, fetchImpl: async () => {
      calls++; active++; max = Math.max(max, active); await gate.promise; active--; return response(['訳']);
    }
  }));
  await tick(); assert.equal(calls, 2); controllers[2].abort(); gate.resolve(); await Promise.all(jobs);
  assert.equal(max, 2); assert.equal(calls, 5);
});
test('Google partial/malformed or HTTP errors are rejected without leaking API response details', async () => {
  await assert.rejects(translateGooglePreview(['A', 'B'], 'ja', 'placeholder', {
    fetchImpl: async () => response(['wrong count'])
  }), /応答件数/);
  await assert.rejects(translateGooglePreview(['A'], 'ja', 'placeholder', {
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: 'secret' }) })
  }), error => error.message.includes('403') && !error.message.includes('secret'));
});

function backgroundHarness({ settings = {}, preview, llm, cached = new Map() } = {}) {
  const sent = [], saved = [], timers = new Map(); let timerId = 0;
  const storage = { get: async () => ({ apiKey: 'placeholder', googlePreviewEnabled: true,
    googleTranslateApiKey: 'google-placeholder', ...settings }), set: async () => {}, remove: async () => {} };
  const s = { URL, AbortController, chrome: {
    storage: { local: storage, onChanged: event() }, runtime: { onInstalled: event(), onMessage: event() },
    webNavigation: { onHistoryStateUpdated: event() },
    tabs: { onUpdated: event(), sendMessage: async (...args) => { sent.push(args); } }
  }, logger: log, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    checkBatchCache: async texts => ({ cached, uncached: texts.map((_, i) => i).filter(i => !cached.has(i)) }),
    touchBatchCache: async () => {}, saveBatchToCache: async (_t, _l, values) => saved.push(Array.from(values)),
    geminiTranslateBatch: llm || (async texts => texts.map(() => 'LLM訳')),
    translateGooglePreview: preview || (async (_t, _l, _k, options) => options.onChunk([{ index: 0, text: 'Google仮訳' }]))
  };
  const src = fs.readFileSync(new URL('../background/background.js', import.meta.url), 'utf8');
  vm.runInNewContext(src.replace(/^import .*;\n/gm, '') + '\nglobalThis.api={handleTranslate,retireTranslationRoute};', s);
  const sender = { tab: { id: 3, url: 'https://example.com/page' }, frameId: 7, documentId: 'notebook-document' };
  return { sent, saved, timers, sender, ...s.api,
    run: (extra = {}) => new Promise(resolve => s.api.handleTranslate({ texts: ['A'], targetLang: '日本語',
      host: 'example.com', previewRequestId: '1:1', sourcePageUrl: sender.tab.url, ...extra }, resolve, sender)) };
}
test('background starts Google while LLM is pending, targets exact iframe document, caches only final text', async () => {
  const gate = deferred();
  const h = backgroundHarness({ llm: async texts => { assert.equal(texts[0], 'A'); await gate.promise; return ['LLM訳']; } });
  const task = h.run(); await tick();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0][0], 3);
  assert.equal(h.sent[0][2].documentId, 'notebook-document');
  assert.equal(h.sent[0][1].entries[0].text, 'Google仮訳');
  assert.equal(h.saved.length, 0); gate.resolve(); assert.equal((await task).success, true);
  assert.deepEqual(h.saved, [['LLM訳']]); assert.equal(h.timers.size, 0);
});
test('only LLM cache misses go to Google and preview indices map back to the full batch', async () => {
  let source;
  const h = backgroundHarness({ cached: new Map([[0, 'cached']]), preview: async (texts, _l, _k, options) => {
    source = Array.from(texts); await options.onChunk([{ index: 0, text: 'Google仮訳' }]);
  } });
  const result = await h.run({ texts: ['A', 'B'] });
  assert.deepEqual(source, ['B']); assert.equal(h.sent[0][1].entries[0].index, 1);
  assert.deepEqual(Array.from(result.translatedTexts), ['cached', 'LLM訳']);
});
for (const setup of [{ settings: { googlePreviewEnabled: false } }, { settings: { googleTranslateApiKey: '' } }, { cached: new Map([[0, 'cached']]) }]) {
  test(`preview stays off without configuration or when LLM cache hits: ${JSON.stringify(setup.settings || 'cache')}`, async () => {
    let calls = 0;
    const h = backgroundHarness({ ...setup, preview: async () => { calls++; } });
    assert.equal((await h.run()).success, true); assert.equal(calls, 0);
  });
}
test('selection requests without preview IDs never call Google', async () => {
  let calls = 0; const h = backgroundHarness({ preview: async () => { calls++; } });
  await h.run({ previewRequestId: undefined }); assert.equal(calls, 0);
});
test('slow Google is aborted without delaying a successful LLM or downgrading its result', async () => {
  const gate = deferred(); let options;
  const h = backgroundHarness({ preview: async (_t, _l, _k, o) => {
    options = o; await gate.promise; await o.onChunk([{ index: 0, text: 'late Google' }]);
  } });
  const result = await h.run(); assert.equal(result.success, true); assert.equal(options.signal.aborted, true);
  gate.resolve(); await tick(); assert.equal(h.sent.length, 0);
});
test('Google failure does not stop the final LLM translation', async () => {
  const h = backgroundHarness({ preview: async () => { throw Error('Google unavailable'); } });
  const result = await h.run(); assert.equal(result.success, true); assert.equal(result.translatedTexts[0], 'LLM訳');
});
test('failed LLM waits for bounded Google fallback, reports failure and never stores preview in LLM cache', async () => {
  const gate = deferred();
  const h = backgroundHarness({ llm: async () => { throw Error('LLM unavailable'); },
    preview: async (_t, _l, _k, o) => { await gate.promise; await o.onChunk([{ index: 0, text: 'Google仮訳' }]); } });
  const task = h.run(); await tick(); gate.resolve();
  const result = await task; assert.equal(result.success, false); assert.equal(h.sent.length, 1); assert.equal(h.saved.length, 0);
});
test('navigation suppresses delayed preview callbacks but retains useful LLM caching', async () => {
  const google = deferred(), llm = deferred();
  const h = backgroundHarness({ llm: async () => { await llm.promise; return ['LLM訳']; },
    preview: async (_t, _l, _k, o) => { await google.promise; await o.onChunk([{ index: 0, text: 'Google仮訳' }]); } });
  const task = h.run(); await tick(); h.retireTranslationRoute(3, 'https://example.com/next');
  google.resolve(); await tick(); llm.resolve(); await task;
  assert.ok(h.sent.every(([, msg]) => msg.type !== 'TRANSLATION_PREVIEW'));
  assert.deepEqual(h.saved, [['LLM訳']]);
});
test('preview deadline aborts stalled Google when LLM also fails', async () => {
  const h = backgroundHarness({ llm: async () => { throw Error('LLM down'); },
    preview: async (_t, _l, _k, o) => new Promise(resolve => o.signal.addEventListener('abort', resolve, { once: true })) });
  const task = h.run(); await tick(); assert.equal(h.timers.size, 1);
  [...h.timers.values()][0](); assert.equal((await task).success, false); assert.equal(h.timers.size, 0);
});
