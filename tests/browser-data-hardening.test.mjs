import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const part=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
const now=Date.now(),cg={BTC:'bitcoin',ETH:'ethereum',SHIB:'shiba-inu'};
const q=(p,t=now)=>({usd:p,last_updated_at:Math.floor(t/1000)});
function quoteEnv(requestJSON){const context=vm.createContext({Date,URL,URLSearchParams,DOMException,Map,CG_IDS:cg,location:{href:'https://jfaread.github.io/wealth-transfer-crypto-tracker/'},requestJSON});vm.runInContext(part('function validCurrentQuotes','function applyCurrentQuotes')+'\nglobalThis.get=fetchCurrentQuotes;',context);return context.get;}
test('partial live data and partial cache can form one complete, timestamp-validated selection',async()=>{
 const live={bitcoin:q(10),ethereum:q(20)},cache={'shiba-inu':q(.000004)};let calls=0;
 const get=quoteEnv(async url=>{calls++;return url.includes('simple/price')?live:{version:1,quotes:cache};});
 const result=await get(['BTC','ETH','SHIB'],new AbortController().signal);assert.equal(result.size,3);assert.equal(result.get('BTC').p,10);assert.equal(result.get('SHIB').p,.000004);assert.equal(calls,2);
});
test('older fallback observations cannot replace valid newer primary prices',async()=>{
 const get=quoteEnv(async url=>url.includes('simple/price')?{bitcoin:q(10)}:{version:1,quotes:{bitcoin:q(5,now-60000),ethereum:q(20)}});
 const result=await get(['BTC','ETH'],new AbortController().signal);assert.equal(result.get('BTC').p,10);
});
test('a complete primary response avoids an unnecessary fallback request',async()=>{
 let count=0;const result=await quoteEnv(async()=>{count++;return {bitcoin:q(10)};})(['BTC'],new AbortController().signal);assert.equal(count,1);assert.equal(result.get('BTC').p,10);
});
test('stale entries cannot complete a selection and aborted requests do not try another source',async()=>{
 const get=quoteEnv(async url=>url.includes('simple/price')?{bitcoin:q(10)}:{version:1,quotes:{ethereum:q(20,now-1900000)}});await assert.rejects(get(['BTC','ETH'],new AbortController().signal),/ETH/);
 const controller=new AbortController();let calls=0;const stop=quoteEnv(async()=>{calls++;controller.abort();throw new DOMException('Cancelled','AbortError');});await assert.rejects(stop(['BTC'],controller.signal));assert.equal(calls,1);
});
test('a late invalid range cannot partly overwrite the prepared snapshot cache',async()=>{
 const stored=new Map([['1D',{sentinel:true}]]),writes=[];
 const context=vm.createContext({Date,URL,Map,ids:['BTC'],location:{href:'https://tracker.test/'},bundles:stored,storageWrite:(k,v)=>writes.push([k,v]),validBundle:b=>b?.valid===true,requestJSON:async()=>({version:1,updatedAt:now,ranges:{'1D':{valid:true,savedAt:now,spec:{range:'1D'},data:[]},'1Y':{valid:false}}})});
 vm.runInContext(part('function preferPreparedBundle','function showSnapshotStatus')+'\nglobalThis.get=getPreparedSnapshot;',context);
 await assert.rejects(context.get(true),/Invalid shared chart history/);assert.deepEqual(stored.get('1D'),{sentinel:true});assert.equal(writes.length,0);
});
test('a newer savedAt cannot roll back even one selected coin observation',()=>{
 const context=vm.createContext({ids:['BTC','ETH'],Map,validBundle:x=>!!x});vm.runInContext(part('function preferPreparedBundle','let snapshotRequest')+'\nglobalThis.prefer=preferPreparedBundle;',context);
 const b=(saved,bt,et)=>({savedAt:saved,spec:{range:'1D'},data:[['BTC',{points:[{t:bt}]}],['ETH',{points:[{t:et}]}]]});
 assert.equal(context.prefer(b(20,100,99),b(10,100,100)),false);assert.equal(context.prefer(b(20,101,101),b(10,100,100)),true);
});
