import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = process.env.GEMITRANS_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const noop = () => {};
const event = () => ({ addListener: noop });
const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const completion = (text, extra = {}) => ({ model: 'served-model', choices: [{ message: { content: text }, finish_reason: 'stop' }], ...extra });
const modelsResponse = ids => jsonResponse({ data: ids.map(id => ({ id })) });

function clientHarness(respond) {
  const requests = [], delays = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    return respond(url, init, requests.length);
  };
  const sandbox = { fetch, AbortController, clearTimeout: noop,
    setTimeout: (fn, delay) => { if (delay !== 30000) { delays.push(delay); queueMicrotask(fn); } return 1; } };
  vm.runInNewContext(read('utils/lolipop.js').replace(/export /g, '') + '\nglobalThis.api={translateText,translateBatch,listModels,testApiKey,retryDelay};', sandbox);
  return { ...sandbox.api, requests, delays };
}

test('model discovery authenticates and preserves exact public IDs, including auto', async () => {
  const h = clientHarness(() => modelsResponse(['auto', 'claude-sonnet-4-6', 'claude-sonnet-4-6', null, '', 42]));
  assert.deepEqual(plain(await h.listModels('placeholder')), ['auto', 'claude-sonnet-4-6']);
  assert.equal(h.requests[0].url, 'https://ai-gateway.lolipop.jp/v1/models');
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer placeholder');
  assert.ok(!h.requests[0].url.includes('placeholder'));
});

test('missing key, empty and malformed model lists cannot become guessed model IDs', async () => {
  const h = clientHarness(() => modelsResponse([]));
  await assert.rejects(h.listModels(''), /APIキー/);
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.listModels('placeholder'), /利用可能なモデル/);
  await assert.rejects(clientHarness(() => jsonResponse({ data: {} })).listModels('placeholder'), /利用可能なモデル/);
});

test('translation uses the minimal chat request and records the served model and token usage', async () => {
  let usage;
  const h = clientHarness(() => jsonResponse(completion('こんにちは', { usage: { prompt_tokens: 12, completion_tokens: 4 } })));
  const result = await h.translateText('Hello', '日本語', 'placeholder', 'auto', value => { usage = value; }, { role: 'button', pageContext: { reference: 'Context' } });
  assert.equal(result, 'こんにちは');
  const request = h.requests[0];
  assert.equal(request.url, 'https://ai-gateway.lolipop.jp/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, 'Bearer placeholder');
  const body = JSON.parse(request.init.body);
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model']);
  assert.equal(body.model, 'auto');
  assert.match(body.messages[0].content, /Role hint for this fragment: button/);
  assert.match(body.messages[0].content, /Context/);
  assert.deepEqual(plain(usage), { inputTokens: 12, outputTokens: 4, model: 'served-model' });
});

test('partial numbered responses retain valid results and only fill missing items through the scheduler', async () => {
  let calls = 0;
  const h = clientHarness(() => { throw Error('bypassed scheduler'); });
  const requestFetch = async (_url, init) => {
    calls++;
    const prompt = JSON.parse(init.body).messages[0].content;
    if (calls === 1) return jsonResponse(completion('[1] (h1) ホーム'));
    assert.match(prompt, /Role hint for this fragment: button/);
    assert.match(prompt, /Example title/);
    return jsonResponse(completion('送信'));
  };
  const result = await h.translateBatch(['Home', 'Submit'], '日本語', 'placeholder', 'chat-model', null, {
    requestFetch, roles: ['h1', 'button'], pageContext: { title: 'Example title' }
  });
  assert.deepEqual(plain(result), ['ホーム', '送信']);
  assert.equal(calls, 2);
  assert.equal(h.requests.length, 0);
});

test('large batches split internally and keep original item and role order', async () => {
  const h = clientHarness((_url, init) => {
    const prompt = JSON.parse(init.body).messages[0].content;
    const items = [...prompt.matchAll(/^\[(\d+)\] \(role(\d+)\)/gm)];
    return jsonResponse(completion(items.map(m => `[${m[1]}] 訳${m[2]}`).join('\n')));
  });
  const texts = Array.from({ length: 8 }, (_, i) => `Source ${i} ` + 'a'.repeat(950));
  const result = await h.translateBatch(texts, '日本語', 'placeholder', 'chat-model', null, { roles: texts.map((_, i) => `role${i}`) });
  assert.deepEqual(plain(result), texts.map((_, i) => `訳${i}`));
  assert.equal(h.requests.length, 3);
});

test('truncated translations are rejected and truncated batch items are translated again', async () => {
  const incomplete = completion('不完全', { choices: [{ message: { content: '[1] 不完全' }, finish_reason: 'length' }] });
  const h = clientHarness((_url, _init, n) => jsonResponse(n === 1 ? incomplete : completion('完全な訳')));
  assert.deepEqual(plain(await h.translateBatch(['A', 'B'], '日本語', 'placeholder', 'chat-model')), ['完全な訳', '完全な訳']);
  assert.equal(h.requests.length, 3);
  const single = clientHarness(() => jsonResponse(incomplete));
  await assert.rejects(single.translateText('A', '日本語', 'placeholder', 'chat-model'), /incomplete: length/);
  assert.deepEqual(plain(await single.translateBatch(['A'], '日本語', 'placeholder', 'chat-model')), [null]);
});

for (const status of [400, 401, 402, 403, 404]) {
  test(`HTTP ${status} errors are surfaced and never retried as individual translations`, async () => {
    const h = clientHarness(() => jsonResponse({ error: { code: 'model_not_allowed', message: 'Check permissions' } }, status));
    assert.deepEqual(plain(await h.translateBatch(['A', 'B'], '日本語', 'placeholder', 'chat-model')), [null, null]);
    assert.equal(h.requests.length, 1);
    await assert.rejects(h.translateText('A', '日本語', 'placeholder', 'chat-model'), /model_not_allowed.*Check permissions/);
    assert.equal(h.requests.length, 2);
  });
}

test('temporary errors respect Retry-After and exponential backoff', async () => {
  const h = clientHarness((_url, _init, n) => n === 1 ? jsonResponse({}, 429, { 'Retry-After': '2' })
    : n === 2 ? jsonResponse({}, 503) : jsonResponse(completion('成功')));
  assert.equal(await h.translateText('A', '日本語', 'placeholder', 'chat-model'), '成功');
  assert.deepEqual(h.delays, [2000, 2000]);
  assert.equal(h.retryDelay({ headers: new Headers({ 'Retry-After': 'invalid' }) }, 2), 4000);
  assert.ok(h.retryDelay({ headers: new Headers({ 'Retry-After': new Date(Date.now() + 10000).toUTCString() }) }, 0) > 8000);
});

test('API key validation selects from the permitted list and executes a short translation', async () => {
  const h = clientHarness(url => url.endsWith('/models') ? modelsResponse(['allowed-model']) : jsonResponse(completion('こんにちは')));
  assert.equal(await h.testApiKey('placeholder'), true);
  assert.equal(JSON.parse(h.requests[1].init.body).model, 'allowed-model');
  await assert.rejects(h.testApiKey('placeholder', 'disallowed-model'), /このAPIキーで利用できません/);
  assert.equal(h.requests.filter(r => r.url.endsWith('/chat/completions')).length, 1);
});

function storageHarness(initial) {
  const data = { ...initial };
  return { data, storage: {
    get: async keys => keys === undefined ? { ...data } : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in data).map(key => [key, data[key]])),
    set: async values => Object.assign(data, values), remove: async () => {}
  } };
}

function backgroundHarness(initial, respond = () => jsonResponse(completion('こんにちは', { usage: { prompt_tokens: 10, completion_tokens: 5 } }))) {
  const { data, storage } = storageHarness(initial), requests = [], saved = [];
  const client = clientHarness(() => { throw Error('bypassed scheduler'); });
  const chrome = { storage: { local: storage, onChanged: event() }, runtime: { onInstalled: event(), onMessage: event() },
    webNavigation: { onHistoryStateUpdated: event() }, tabs: { onUpdated: event(), sendMessage: async () => {} } };
  const sandbox = { chrome, logger: { info: noop, warn: noop, error: noop }, setTimeout, clearTimeout, AbortController,
    lolipopTranslateBatch: client.translateBatch, lolipopTestApiKey: client.testApiKey,
    fetch: async (url, init) => { requests.push({ url, init }); return respond(url, init, requests.length); },
    checkBatchCache: async texts => ({ cached: new Map(), uncached: texts.map((_, i) => i) }),
    saveBatchToCache: async (...args) => { saved.push(args); } };
  vm.runInNewContext(read('background/background.js').replace(/^import .*;\n/gm, '') + '\nglobalThis.api={handleTranslate,handleTestApiKey,getActiveProviderCredential,SETTINGS_KEYS};', sandbox);
  return { ...sandbox.api, data, requests, saved };
}

test('background routes Lolipop credentials and model through the shared queue and cache', async () => {
  const h = backgroundHarness({ apiProvider: 'lolipop', lolipopApiKey: 'gateway-placeholder', lolipopModel: 'auto' });
  assert.equal(await h.getActiveProviderCredential(), 'gateway-placeholder');
  assert.ok(h.SETTINGS_KEYS.includes('lolipopModel'));
  const response = await new Promise(resolve => h.handleTranslate({ texts: ['Hello'], targetLang: '日本語', host: 'test.example' }, resolve));
  assert.equal(response.success, true);
  assert.deepEqual(plain(response.translatedTexts), ['こんにちは']);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer gateway-placeholder');
  assert.equal(JSON.parse(h.requests[0].init.body).model, 'auto');
  assert.equal(h.saved.length, 1);
  const usage = Object.values(h.data).find(value => value?.byModel);
  assert.ok(usage.byModel['lolipop/served-model']);
  assert.equal(usage.byModel.auto, undefined);
});

test('background reports missing Lolipop configuration instead of falling back to Gemini', async () => {
  for (const settings of [{ apiProvider: 'lolipop', apiKey: 'gemini-placeholder' }, { apiProvider: 'lolipop', lolipopApiKey: 'placeholder' }]) {
    const h = backgroundHarness(settings);
    const result = await new Promise(resolve => h.handleTranslate({ texts: ['Hello'], targetLang: '日本語' }, resolve));
    assert.equal(result.success, false);
    assert.equal(h.requests.length, 0);
  }
});

function popupHarness(initial, respond = () => modelsResponse(['auto', 'chat-model'])) {
  const { data, storage } = storageHarness(initial), messages = [], requests = [];
  function element(id = '') {
    const classes = new Set(), listeners = {}, buttonText = { textContent: '保存' };
    return { id, value: '', textContent: '', type: 'password', options: [], disabled: false, checked: false,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle: (name, force) => force ? classes.add(name) : classes.delete(name) },
      addEventListener: (name, fn) => { listeners[name] = fn; }, listeners,
      querySelector: () => buttonText, focus: noop,
      appendChild(option) { this.options.push(option); }, replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; },
      get selectedIndex() { return this.options.findIndex(o => o.value === this.value); },
      set selectedIndex(i) { this.value = this.options[i]?.value || ''; } };
  }
  const nodes = Object.fromEntries([...read('popup/popup.html').matchAll(/id="([^"]+)"/g)].map(m => [m[1], element(m[1])]));
  const document = { getElementById: id => nodes[id], createElement: () => element(), addEventListener: noop, querySelectorAll: () => [] };
  const sandbox = { document, console, AbortController, setTimeout: () => 1, clearTimeout: noop,
    fetch: async (url, init) => { requests.push({ url, init }); return respond(url, init, requests.length); },
    chrome: { storage: { local: storage }, runtime: { onMessage: event(), sendMessage: async message => {
      messages.push(message); return { success: true, isValid: true }; } } } };
  vm.runInNewContext(read('popup/popup.js') + '\nglobalThis.api={loadSettings,saveSettings,setupEventListeners,loadLolipopModels,updateProviderUI};', sandbox);
  nodes['target-lang'].value = '日本語'; nodes['batch-size'].value = '3000';
  return { ...sandbox.api, data, nodes, messages, requests };
}

test('popup restores credentials, uses authenticated permitted models and shows only Lolipop fields', async () => {
  const h = popupHarness({ apiProvider: 'lolipop', lolipopApiKey: 'placeholder', lolipopModel: 'chat-model' });
  await h.loadSettings();
  assert.equal(h.nodes['lolipop-api-key'].value, 'placeholder');
  assert.equal(h.nodes['lolipop-model-select'].value, 'chat-model');
  assert.equal(h.nodes['lolipop-model-select'].disabled, false);
  assert.equal(h.nodes['lolipop-key-field'].classList.contains('hidden'), false);
  assert.equal(h.nodes['gemini-key-field'].classList.contains('hidden'), true);
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer placeholder');
});

test('popup first save discovers permitted models and persists the key and chosen model before validation', async () => {
  const h = popupHarness({});
  h.nodes['api-provider'].value = 'lolipop'; h.nodes['lolipop-api-key'].value = 'placeholder';
  await h.saveSettings();
  assert.equal(h.data.apiProvider, 'lolipop');
  assert.equal(h.data.lolipopApiKey, 'placeholder');
  assert.equal(h.data.lolipopModel, 'auto');
  assert.deepEqual(plain(h.messages[0]), { type: 'TEST_API_KEY', apiKey: 'placeholder', model: 'auto', provider: 'lolipop' });
  assert.equal(h.nodes['save-settings'].disabled, false);
});

test('popup never invents auto when unavailable and falls back to the first actual permitted ID', async () => {
  const h = popupHarness({}, () => modelsResponse(['allowed-model']));
  await h.loadLolipopModels('placeholder', 'removed-model');
  assert.equal(h.nodes['lolipop-model-select'].value, 'allowed-model');
  assert.deepEqual(h.nodes['lolipop-model-select'].options.map(o => o.value), ['allowed-model']);
});

test('popup model discovery failures are visible and prevent saving or validating a guessed model', async () => {
  const h = popupHarness({}, () => jsonResponse({ error: { code: 'invalid_api_key', message: 'Invalid key' } }, 401));
  h.nodes['api-provider'].value = 'lolipop'; h.nodes['lolipop-api-key'].value = 'placeholder';
  await h.saveSettings();
  assert.equal(h.data.lolipopApiKey, undefined);
  assert.equal(h.messages.length, 0);
  assert.equal(h.nodes['lolipop-model-select'].disabled, true);
  assert.match(h.nodes['lolipop-key-status'].textContent, /invalid_api_key/);
});

test('key edits invalidate old models, ignore stale fetch results and refresh with the entered key', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const h = popupHarness({}, (_url, _init, n) => n === 1 ? pending : modelsResponse(['new-model']));
  h.setupEventListeners(); h.nodes['api-provider'].value = 'lolipop';
  const old = h.loadLolipopModels('old-placeholder');
  h.nodes['lolipop-api-key'].value = 'new-placeholder';
  h.nodes['lolipop-api-key'].listeners.input();
  await h.nodes['lolipop-refresh'].listeners.click();
  resolve(modelsResponse(['old-model'])); await old;
  assert.equal(h.nodes['lolipop-model-select'].value, 'new-model');
  assert.equal(h.requests[1].init.headers.Authorization, 'Bearer new-placeholder');
  assert.equal(h.nodes['translate-btn'].disabled, true);
});

test('saving another provider preserves the saved Lolipop model while its list is unavailable', async () => {
  const h = popupHarness({ lolipopModel: 'retained-model' });
  h.nodes['api-provider'].value = 'gemini'; h.nodes['api-key'].value = 'gemini-placeholder';
  await h.saveSettings();
  assert.equal(h.data.lolipopModel, 'retained-model');
});

test('manifest grants the Lolipop origin and the background imports its implementation', () => {
  assert.ok(JSON.parse(read('manifest.json')).host_permissions.includes('https://ai-gateway.lolipop.jp/*'));
  assert.match(read('background/background.js'), /import .*lolipopTranslateBatch.*lolipopTestApiKey.*from '\.\.\/utils\/lolipop\.js'/);
});

test('the six reported UI labels accept grouped role hints and tag wrappers as valid translations', async () => {
  const source = ['Router Index', 'Quality', 'Cache hit', 'Cost / success', 'Cost / task', 'Time / task'];
  const response = '[1] (button@group-1) ルーター指標\n[2] <button@group-1>品質</button@group-1>\n[3] (label@group-12) キャッシュヒット\n[4] <translation>成功あたりのコスト</translation>\n[5] <label>タスクあたりのコスト</label>\n  [6] (button@group-1) タスクあたりの時間';
  const h = backgroundHarness({ apiProvider: 'lolipop', lolipopApiKey: 'placeholder', lolipopModel: 'google/gemini-3-5-flash-lite' }, () => jsonResponse(completion(response)));
  const result = await new Promise(resolve => h.handleTranslate({ texts: source, targetLang: '日本語', roles: source.map(() => 'button@group-1') }, resolve));
  assert.equal(result.success, true);
  assert.deepEqual(plain(result.translatedTexts), ['ルーター指標', '品質', 'キャッシュヒット', '成功あたりのコスト', 'タスクあたりのコスト', 'タスクあたりの時間']);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(plain(h.saved[0][2]), plain(result.translatedTexts));
});

test('single fallback translations remove grouped hints while preserving ordinary parentheses', async () => {
  const h = clientHarness(() => jsonResponse(completion('<button@group-42>(button@group-42) コスト (USD)</button@group-42>')));
  assert.equal(await h.translateText('Cost (USD)', '日本語', 'placeholder', 'model'), 'コスト (USD)');
  const currency = clientHarness(() => jsonResponse(completion('(USD) コスト')));
  assert.equal(await currency.translateText('(USD) Cost', '日本語', 'placeholder', 'model'), '(USD) コスト');
});

test('remaining internal markers trigger fallback only for affected items', async () => {
  const h = clientHarness((_url, _init, n) => jsonResponse(completion(n === 1 ? '[1] 品質\n[2] コスト (button@group-1) 詳細' : '(button@group-1) タスクあたりのコスト')));
  assert.deepEqual(plain(await h.translateBatch(['Quality', 'Cost / task'], '日本語', 'placeholder', 'model')), ['品質', 'タスクあたりのコスト']);
  assert.equal(h.requests.length, 2);
});

test('background preserves the Gateway error code instead of returning a generic empty-result error', async () => {
  const h = backgroundHarness({ apiProvider: 'lolipop', lolipopApiKey: 'placeholder', lolipopModel: 'model' }, () => jsonResponse({ error: { code: 'model_not_allowed', message: 'Check model permissions' } }, 403));
  const result = await new Promise(resolve => h.handleTranslate({ texts: ['Hello'], targetLang: '日本語' }, resolve));
  assert.equal(result.success, false);
  assert.match(result.error, /403.*model_not_allowed.*Check model permissions/);
  assert.equal(h.requests.length, 1);
});

test('partial results retain valid translations and include the reason for a failed fallback', async () => {
  const h = backgroundHarness({ apiProvider: 'lolipop', lolipopApiKey: 'placeholder', lolipopModel: 'model' }, (_url, _init, n) => n === 1
    ? jsonResponse(completion('[1] 品質')) : jsonResponse({ error: { code: 'insufficient_balance', message: 'Insufficient balance' } }, 402));
  const result = await new Promise(resolve => h.handleTranslate({ texts: ['Quality', 'Cost'], targetLang: '日本語' }, resolve));
  assert.equal(result.success, true);
  assert.deepEqual(plain(result.translatedTexts), ['品質', null]);
  assert.match(result.error, /insufficient_balance/);
  assert.deepEqual(plain(h.saved[0][2]), ['品質', null]);
});
