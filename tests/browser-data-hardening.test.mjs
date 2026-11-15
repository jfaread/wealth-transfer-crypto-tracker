import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const part=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
const now=Date.now(),HOUR=3600000,cg={BTC:'bitcoin',ETH:'ethereum',BNB:'binancecoin',XRP:'ripple',SOL:'solana',SHIB:'shiba-inu',KISHU:'kishu-inu',WKC:'wiki-cat',CREPE:'crepe-2'};
class Clock extends Date {static now(){return now;}}
const q=(p,t=now)=>({usd:p,last_updated_at:Math.floor(t/1000)});
function quoteEnv(requestJSON){
 const context=vm.createContext({Date:Clock,URL,URLSearchParams,DOMException,Map,AbortController,setTimeout,clearTimeout,backoffs:new Map(),CG_IDS:cg,ids:Object.keys(cg),RANGES:{'1D':{interval:'5m',step:300000}},location:{href:'https://jfaread.github.io/wealth-transfer-crypto-tracker/'},requestJSON});
 vm.runInContext(part('function validBundle','for(const range of Object.keys(RANGES))')+part('function validCurrentQuotes','function applyCurrentQuotes')+'\nglobalThis.get=fetchCurrentQuotes;',context);
 context.get.validBundle=context.validBundle;return context.get;
}
function retainedBundle(entries={XRP:[1.25,now-120000]},overrides={}){
 const end=Math.max(...Object.values(entries).map(([,t])=>t)),start=Math.floor((end-86400000)/HOUR)*HOUR;
 return {spec:{range:'1D',start,end,step:HOUR,interval:'approximately hourly',source:'CoinGecko live',currency:'USD',quoteCheckedAt:now-60000,historySavedAt:now-3*HOUR,...overrides},
  savedAt:now-60000,data:Object.entries(entries).map(([id,[p,t]])=>[id,{id,base:p,points:[{t:start,p,r:0},{t,p,r:0,gapBefore:true}],gaps:1,asOf:now-60000,historySavedAt:now-3*HOUR}])};
}

test('partial live data and partial cache can form one complete, timestamp-validated selection',async()=>{
 const live={bitcoin:q(10),ethereum:q(20)},cache={'shiba-inu':q(.000004)};let calls=0;
 const get=quoteEnv(async url=>{calls++;return url.includes('simple/price')?live:{version:1,quotes:cache};});
 const result=await get(['BTC','ETH','SHIB'],new AbortController().signal);assert.equal(result.quotes.size,3);assert.equal(result.quotes.get('BTC').p,10);assert.equal(result.quotes.get('SHIB').p,.000004);assert.equal(calls,2);assert.deepEqual(Array.from(result.retainedIds),[]);
});
test('older fallback observations cannot replace valid newer primary prices',async()=>{
 const get=quoteEnv(async url=>url.includes('simple/price')?{bitcoin:q(10)}:{version:1,quotes:{bitcoin:q(5,now-60000),ethereum:q(20)}});
 const result=await get(['BTC','ETH'],new AbortController().signal);assert.equal(result.quotes.get('BTC').p,10);
});
test('a complete primary response avoids an unnecessary fallback request',async()=>{
 let count=0;const result=await quoteEnv(async()=>{count++;return {bitcoin:q(10)};})(['BTC'],new AbortController().signal);assert.equal(count,1);assert.equal(result.quotes.get('BTC').p,10);assert.equal(result.failureMessage,null);
});
test('a failed check retains the exact two-minute-old XRP observation without claiming an update',async()=>{
 const saved=retainedBundle();let calls=0;
 const get=quoteEnv(async()=>{calls++;throw Error('The source is unavailable.');});assert.equal(get.validBundle(saved),true);
 const result=await get(['XRP'],new AbortController().signal,[saved]);
 assert.equal(calls,2);assert.equal(result.quotes.get('XRP').p,1.25);assert.equal(result.quotes.get('XRP').t,now-120000);assert.deepEqual(Array.from(result.retainedIds),['XRP']);assert.equal(result.attemptedAt,now);assert.match(result.failureMessage,/unavailable/);
});
test('partial primary, partial published cache and validated local quotes complete one selection',async()=>{
 const saved=retainedBundle();let calls=0;
 const get=quoteEnv(async url=>{calls++;return url.includes('simple/price')?{bitcoin:q(10)}:{version:1,quotes:{ethereum:q(20)}};});
 const result=await get(['BTC','ETH','XRP'],new AbortController().signal,[saved]);
 assert.equal(calls,2);assert.equal(result.quotes.size,3);assert.equal(result.quotes.get('BTC').p,10);assert.equal(result.quotes.get('ETH').p,20);assert.equal(result.quotes.get('XRP').t,now-120000);assert.deepEqual(Array.from(result.retainedIds),['XRP']);
});
test('a newer local observation cannot be rolled back by a complete but older remote response',async()=>{
 const saved=retainedBundle({XRP:[1.25,now-5000]});let calls=0;
 const result=await quoteEnv(async()=>{calls++;return {ripple:q(1,now-10000)};})(['XRP'],new AbortController().signal,[saved]);
 assert.equal(calls,1);assert.equal(result.quotes.get('XRP').p,1.25);assert.equal(result.quotes.get('XRP').t,now-5000);
});
test('local recovery rejects stale, future, non-CoinGecko and malformed observations',async t=>{
 const invalidReturn=retainedBundle();invalidReturn.data[0][1].points.at(-1).r=10;
 const invalidPrice=retainedBundle();invalidPrice.data[0][1].points.at(-1).p=-1;
 const cases=[['stale',retainedBundle({XRP:[1.25,now-1800001]}),true],['future',retainedBundle({XRP:[1.25,now+300001]}),false],['other venue',retainedBundle(undefined,{source:'Binance',currency:'USDT',interval:'5m',step:300000}),true],['incorrect return',invalidReturn,false],['negative price',invalidPrice,false]];
 for(const [name,saved,valid]of cases)await t.test(name,async()=>{
  const get=quoteEnv(async()=>{throw Error('Unavailable');});assert.equal(get.validBundle(saved),valid,'Fixture must exercise the intended validation layer');
  await assert.rejects(get(['XRP'],new AbortController().signal,[saved]),/XRP/);
 });
 const legacy=retainedBundle(undefined,{source:'CoinGecko',interval:'hourly + final sample'}),get=quoteEnv(async()=>{throw Error('Unavailable');});assert.equal(get.validBundle(legacy),true);assert.equal((await get(['XRP'],new AbortController().signal,[legacy])).quotes.get('XRP').t,now-120000);
});
test('saved refresh metadata is validated without rejecting legacy bundles',()=>{
 const get=quoteEnv(async()=>{}),base=retainedBundle({XRP:[1.25,now-120000],ETH:[20,now-120000]});assert.equal(get.validBundle(base),true);
 const saved={state:'saved',phase:'quotes',retainedIds:['XRP'],failedIds:[],attemptedAt:now,failureMessage:'Source unavailable'};
 const valid=[saved,{...saved,state:'updated',retainedIds:[],failureMessage:null},{...saved,state:'failed',phase:'chart',retainedIds:['ETH'],failedIds:['XRP']}];
 for(const report of valid)assert.equal(get.validBundle({...base,spec:{...base.spec,quoteRefresh:report}}),true);
 const invalid=[null,[],{...saved,state:'unknown'},{...saved,phase:'unknown'},{...saved,attemptedAt:0},{...saved,attemptedAt:now+300001},{...saved,attemptedAt:now+.5},{...saved,retainedIds:['XRP','XRP']},{...saved,retainedIds:['BTC']},{...saved,failedIds:'XRP'},{...saved,failedIds:['XRP']},{...saved,retainedIds:[]},{...saved,state:'updated'},{...saved,state:'failed',retainedIds:[]},{...saved,failureMessage:12},{...saved,failureMessage:'x'.repeat(301)}];
 for(const report of invalid)assert.equal(get.validBundle({...base,spec:{...base.spec,quoteRefresh:report}}),false,JSON.stringify(report));
});
test('selected retained provenance survives a mixed failed report, reload and timezone re-render',()=>{
 const warning={},statuses=[],state={coins:['ETH']};let zone='UK';
 const context=vm.createContext({Date:Clock,Map,state,$:()=>warning,setStatus:(type,text)=>statuses.push({type,text}),dateText:t=>String(t),zoneLabel:()=>zone});
 vm.runInContext(part('function showSnapshotStatus','async function repairChartHistory')+'\nglobalThis.show=showSnapshotStatus;',context);
 const bundle=retainedBundle({XRP:[1.25,now-120000],ETH:[20,now-120000]});delete bundle.spec.quoteCheckedAt;
 bundle.spec.quoteRefresh={state:'failed',phase:'quotes',retainedIds:['ETH'],failedIds:['XRP'],attemptedAt:now,failureMessage:'Source unavailable'};
 context.show(bundle);assert.equal(statuses.at(-1).type,'failed');assert.match(statuses.at(-1).text,/^Saved quotes/);assert.equal(warning.hidden,false);assert.match(warning.textContent,/newer prices for ETH/);
 zone='Eastern Time';context.show(JSON.parse(JSON.stringify(bundle)));assert.match(statuses.at(-1).text,/^Saved quotes.*Eastern Time/);
 state.coins=['XRP'];context.show(bundle);assert.match(statuses.at(-1).text,/^Update unavailable/);assert.match(warning.textContent,/newer prices for XRP/);
 bundle.spec.quoteRefresh.phase='chart';bundle.spec.quoteRefresh.failureMessage='The saved history no longer covers this period. Choose a longer period while its history refreshes.';context.show(bundle);assert.match(statuses.at(-1).text,/^Chart update unavailable/);assert.match(warning.textContent,/Choose a longer period/);
});
test('one transient primary retry can recover after the published cache fails',async()=>{
 let primary=0,cache=0;
 const get=quoteEnv(async url=>{if(!url.includes('simple/price')){cache++;throw Error('Cache unavailable');}if(++primary===1)throw Object.assign(Error('Network interrupted'),{transient:true});return {ripple:q(1.3)};});
 const result=await get(['XRP'],new AbortController().signal,[retainedBundle()]);
 assert.equal(primary,2);assert.equal(cache,1);assert.equal(result.quotes.get('XRP').p,1.3);assert.deepEqual(Array.from(result.retainedIds),[]);assert.equal(result.failureMessage,null);
});
test('transient retry stops after one attempt and then preserves a valid saved quote',async()=>{
 let primary=0,cache=0;
 const get=quoteEnv(async url=>{if(url.includes('simple/price')){primary++;throw Object.assign(Error('Network interrupted'),{transient:true});}cache++;throw Error('Cache unavailable');});
 const result=await get(['XRP'],new AbortController().signal,[retainedBundle()]);
 assert.equal(primary,2);assert.equal(cache,1);assert.equal(result.quotes.get('XRP').t,now-120000);assert.deepEqual(Array.from(result.retainedIds),['XRP']);assert.match(result.failureMessage,/Network interrupted/);
});
test('rate limits, Retry-After, regional restrictions and invalid responses are not retried',async t=>{
 for(const error of [Object.assign(Error('Rate limit'),{status:429,retryAt:now+120000}),Object.assign(Error('Service pause'),{status:503,transient:true,retryAt:now+120000}),Object.assign(Error('Unavailable in region'),{status:451}),Error('The source returned invalid JSON.')])await t.test(error.message,async()=>{
  let primary=0,cache=0;const get=quoteEnv(async url=>{if(url.includes('simple/price')){primary++;throw error;}cache++;throw Error('Cache unavailable');});
  await get(['XRP'],new AbortController().signal,[retainedBundle()]);assert.equal(primary,1);assert.equal(cache,1);
 });
});
test('stale entries cannot complete a selection and aborted requests do not try another source',async()=>{
 const get=quoteEnv(async url=>url.includes('simple/price')?{bitcoin:q(10)}:{version:1,quotes:{ethereum:q(20,now-1900000)}});await assert.rejects(get(['BTC','ETH'],new AbortController().signal),/ETH/);
 const controller=new AbortController();let calls=0;const stop=quoteEnv(async()=>{calls++;controller.abort();throw new DOMException('Cancelled','AbortError');});await assert.rejects(stop(['BTC'],controller.signal));assert.equal(calls,1);
});
test('HTTP Retry-After is honoured in full and suppresses further transport calls',async()=>{
 let calls=0;const context=vm.createContext({Date:Clock,URL,DOMException,AbortController,setTimeout,clearTimeout,MAX_JSON_BYTES:10000,backoffs:new Map(),dateText:()=>'',zoneLabel:()=>'',fetch:async()=>{calls++;return {ok:false,status:503,headers:new Headers({'Retry-After':'7200'})};}});
 vm.runInContext(part('async function requestJSON','async function getJSON')+'\nglobalThis.get=requestJSON;',context);
 await assert.rejects(context.get('https://api.coingecko.com/api/v3/simple/price',new AbortController().signal),e=>e.status===503&&e.retryAt===now+7200000&&e.transient===false);
 await assert.rejects(context.get('https://api.coingecko.com/api/v3/simple/price',new AbortController().signal),e=>e.status===429&&e.retryAt===now+7200000);assert.equal(calls,1);
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
 const unresolved=b(10,100,100);unresolved.spec.quoteRefresh={state:'failed',retainedIds:['ETH'],failedIds:['BTC']};
 assert.equal(context.prefer(b(20,100,100),unresolved),false,'A new file-write timestamp must not clear the last failed check');assert.equal(context.prefer(b(20,101,100),unresolved),false,'Every unresolved selected coin needs a newer observation');assert.equal(context.prefer(b(20,101,101),unresolved),true);
});

test('successful XRP response must not be called a failed check just because local data is newer',async()=>{
  const saved=retainedBundle({XRP:[1.25,now-5000]});let calls=0;
  const result=await quoteEnv(async()=>{calls++;return {ripple:q(1.24,now-15000)};})(['XRP'],new AbortController().signal,[saved]);
  assert.deepEqual(Array.from(result.retainedIds),[],'A valid provider reply is not a failed check');
  assert.deepEqual(Array.from(result.preservedIds),['XRP']);
  assert.equal(result.quotes.get('XRP').t,now-5000);assert.equal(result.quotes.get('XRP').p,1.25);
  assert.equal(result.failureMessage,null);assert.equal(calls,1);
});
test('confirmed older XRP and unavailable ETH have independent check outcomes',async()=>{
  const saved=retainedBundle({XRP:[1.25,now-5000],ETH:[20,now-5000]});
  const get=quoteEnv(async url=>url.includes('simple/price')?{ripple:q(1.24,now-15000)}:{version:1,quotes:{}});
  const result=await get(['XRP','ETH'],new AbortController().signal,[saved]);
  assert.deepEqual(Array.from(result.retainedIds),['ETH']);assert.deepEqual(Array.from(result.preservedIds),['XRP']);
  assert.equal(result.quotes.get('XRP').t,now-5000);assert.equal(result.quotes.get('ETH').t,now-5000);
});
test('two local bundles do not turn an actual outage into a successful check',async()=>{
  const get=quoteEnv(async()=>{throw Error('Provider unavailable');});
  const result=await get(['XRP'],new AbortController().signal,[retainedBundle(),retainedBundle({XRP:[1.3,now-5000]})]);
  assert.deepEqual(Array.from(result.retainedIds),['XRP']);assert.deepEqual(Array.from(result.preservedIds),[]);
  assert.equal(result.quotes.get('XRP').t,now-5000);assert.match(result.failureMessage,/unavailable/);
});
test('preserved observation metadata is bounded, disjoint and backwards compatible',()=>{
  const get=quoteEnv(async()=>{}),base=retainedBundle();
  const report={state:'updated',phase:'quotes',retainedIds:[],failedIds:[],preservedIds:['XRP'],attemptedAt:now,failureMessage:null};
  assert.equal(get.validBundle({...base,spec:{...base.spec,quoteRefresh:report}}),true);
  for(const value of [null,'XRP',['BTC'],['XRP','XRP']])assert.equal(get.validBundle({...base,spec:{...base.spec,quoteRefresh:{...report,preservedIds:value}}}),false);
  assert.equal(get.validBundle({...base,spec:{...base.spec,quoteRefresh:{...report,state:'saved',retainedIds:['XRP']}}}),false);
});
test('a successful check keeping newer XRP remains neutral after timezone changes and reload',()=>{
  const warning={},statuses=[],state={coins:['XRP']};let zone='UK';
  const context=vm.createContext({Date:Clock,Map,state,$:()=>warning,setStatus:(type,text)=>statuses.push({type,text}),dateText:t=>String(t),zoneLabel:()=>zone});
  vm.runInContext(part('function showSnapshotStatus','async function repairChartHistory')+'\nglobalThis.show=showSnapshotStatus;',context);
  const bundle=retainedBundle({XRP:[1.25,now-5000]});bundle.data[0][1].historySavedAt=now;
  bundle.spec.quoteRefresh={state:'updated',phase:'quotes',retainedIds:[],failedIds:[],preservedIds:['XRP'],attemptedAt:now,failureMessage:null};
  context.show(bundle);assert.equal(statuses.at(-1).type,'ready');assert.match(statuses.at(-1).text,/^Prices checked/);assert.equal(warning.hidden,true);
  zone='Eastern Time';context.show(JSON.parse(JSON.stringify(bundle)));assert.match(statuses.at(-1).text,/^Prices checked.*Eastern Time/);assert.equal(warning.hidden,true);
});
