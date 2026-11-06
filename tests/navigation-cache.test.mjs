import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=process.env.GEMITRANS_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function harness(fetch) {
 const src=read('background/background.js');
 const start=src.indexOf('let translationNetworkLimit');
 const end=src.indexOf('function translationScope',start);
 const key=src.slice(src.indexOf('function translationPageKey'),src.indexOf('const automaticStarts'));
 const s={URL,AbortController,setTimeout,clearTimeout,fetch,chrome:{tabs:{sendMessage:async()=>{}}}};
 vm.runInNewContext(src.slice(start,end)+key+`\nglobalThis.api={scheduledTranslationFetch,retireTranslationRoute,translationConsumer,shareTranslationBatch,setLimit:n=>translationNetworkLimit=n};`,s);
 return s.api;
}
const consumer=(h,id,url)=>h.translationConsumer({tab:{id,url},frameId:0},{sourcePageUrl:url});
const response=text=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}],choices:[{message:{content:text}}],content:[{type:'text',text}]}),{headers:{'content-type':'application/json'}});
test('sent response survives navigation, queued old work stops and new page waits for its slot',async()=>{
 const gate=deferred(),calls=[];
 const h=harness(async url=>{calls.push(url);if(url==='old')await gate.promise;return response('翻訳');});h.setLimit(1);
 const old=consumer(h,1,'https://example.com/a');
 const a=h.scheduledTranslationFetch('old',{},1000,old,old.priority);
 const b=h.scheduledTranslationFetch('unsent',{},1000,old,old.priority);
 const stopped=assert.rejects(b,{name:'StaleTranslationError'});
 await tick();h.retireTranslationRoute(1,'https://example.com/b');
 const fresh=consumer(h,1,'https://example.com/b');
 const c=h.scheduledTranslationFetch('new',{},1000,fresh,fresh.priority);
 await tick();assert.deepEqual(calls,['old']);gate.resolve();
 assert.ok((await a).ok);await c;await stopped;assert.deepEqual(calls,['old','new']);
});
test('slot remains occupied until body finishes, not just HTTP headers',async()=>{
 const body=deferred();let calls=0;
 const h=harness(async()=>{calls++;return {clone:()=>({arrayBuffer:()=>body.promise})};});h.setLimit(1);
 const live=()=>true;
 const a=h.scheduledTranslationFetch('a',{},1000,live,1),b=h.scheduledTranslationFetch('b',{},1000,live,1);
 await tick();assert.equal(calls,1);body.resolve(new ArrayBuffer(0));await Promise.all([a,b]);assert.equal(calls,2);
});
test('newest page takes the next free slot ahead of other waiting pages',async()=>{
 const gate=deferred(),calls=[];const h=harness(async url=>{calls.push(url);if(url==='busy')await gate.promise;return response('訳');});h.setLimit(1);
 const live=()=>true;
 const tasks=[h.scheduledTranslationFetch('busy',{},1000,live,1),h.scheduledTranslationFetch('older',{},1000,live,2),h.scheduledTranslationFetch('newest',{},1000,live,3)];
 await tick();gate.resolve();await Promise.all(tasks);assert.deepEqual(calls,['busy','newest','older']);
});
test('shared work remains useful when original page leaves but another page still needs it',async()=>{
 const h=harness(async()=>response('訳')),gate=deferred();let calls=0;
 const old=consumer(h,1,'https://example.com/a'),other=consumer(h,2,'https://example.com/a');
 const a=h.shareTranslationBatch(['same'],async(_indices,needed)=>{calls++;await gate.promise;assert.equal(needed(),true);return ['共有訳'];},old);
 const b=h.shareTranslationBatch(['same'],async()=>{throw Error('duplicate');},other);
 h.retireTranslationRoute(1,'https://example.com/b');gate.resolve();
 assert.deepEqual(Array.from(await a),['共有訳']);assert.deepEqual(Array.from(await b),['共有訳']);assert.equal(calls,1);
});
test('late old-page messages and repeated anchors do not create new active work',()=>{
 const h=harness(async()=>response('訳'));const first=consumer(h,1,'https://example.com/a');
 h.retireTranslationRoute(1,'https://example.com/a#section');assert.equal(first(),true);
 h.retireTranslationRoute(1,'https://example.com/b');assert.equal(first(),false);
 assert.equal(consumer(h,1,'https://example.com/a')(),false);
});
for(const provider of ['gemini','openrouter','sambanova','nvidia','cerebras','plamo','opencodego','lolipop','lmstudio']) {
 test(`${provider}: in-flight partial result is preserved while post-navigation fallbacks send no HTTP`,async()=>{
  let calls=0;let h,live;
  h=harness(async()=>{calls++;h.retireTranslationRoute(1,'https://example.com/b');return response('[1] 最初の翻訳');});
  live=consumer(h,1,'https://example.com/a');
  const s={AbortController,setTimeout,clearTimeout,fetch:()=>{throw Error('bypassed scheduler');}};
  vm.runInNewContext(read(`utils/${provider}.js`).replace(/export /g,'')+'\nglobalThis.translate=translateBatch;',s);
  const options={requestFetch:(url,init,timeout)=>h.scheduledTranslationFetch(url,init,timeout,live,live.priority)};
  const args=[['First sentence','Second sentence'],'日本語','placeholder','model',null];
  if(provider==='lmstudio')args.push('en');args.push(options);
  const values=await s.translate(...args);
  assert.equal(calls,1);assert.equal(values[0],'最初の翻訳');assert.equal(values[1],null);
 });
}
