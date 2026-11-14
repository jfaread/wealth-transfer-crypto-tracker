const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
(async()=>{
 const html=await fs.readFile('_site/index.html','utf8'),snapshots=await fs.readFile('_site/data/ranges.json','utf8');
 const assetTypes={'/assets/alerts.js':'text/javascript','/assets/alerts.css':'text/css','/alerts-config.json':'application/json','/manifest.webmanifest':'application/manifest+json','/sw.js':'text/javascript','/icons/cw.svg':'image/svg+xml','/icons/cw-192.png':'image/png','/icons/cw-512.png':'image/png'};
 const assets=new Map(await Promise.all(Object.entries(assetTypes).map(async([path,contentType])=>[path,{contentType,body:await fs.readFile('_site'+path)}])));
 async function serveAsset(route){const u=new URL(route.request().url());if(u.origin!=='https://tracker.test'||!assets.has(u.pathname))return false;await route.fulfill(assets.get(u.pathname));return true;}
 const browser=await chromium.launch(require('./browser-launch.cjs')());
 for(const width of [320,390,768,1440]){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});let providerCalls=0,snapshotCalls=0;page.on('pageerror',e=>console.error('PAGE ERROR',e.stack));
  await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin==='https://tracker.test'&&u.pathname==='/'){await route.fulfill({contentType:'text/html',body:html});return;}if(u.origin==='https://tracker.test'&&u.pathname==='/data/ranges.json'){snapshotCalls++;await new Promise(r=>setTimeout(r,150));await route.fulfill({contentType:'application/json',body:snapshots});return;}if(u.hostname.includes('binance')||u.hostname.includes('coingecko'))providerCalls++;if(await serveAsset(route))return;await route.abort();});
  const started=Date.now();await page.goto('https://tracker.test/',{waitUntil:'domcontentloaded'});await page.locator('[data-series="CREPE"]').waitFor({timeout:1500});const firstChartMs=Date.now()-started;
  assert.equal(await page.locator('[data-series]').count(),8);assert.equal(providerCalls,0);
  await page.locator('#wtct-timezone').selectOption('America/New_York');assert((await page.locator('#dates').innerText()).includes('Eastern Time'));assert((await page.locator('#hover-date').innerText()).includes('Eastern Time'));assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('wtct:v3:timezone'))),'America/New_York');await page.locator('#wtct-timezone').selectOption('Europe/London');
  const layout=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert(layout.scroll<=layout.width,JSON.stringify({width,...layout}));
  await page.getByRole('button',{name:'One month',exact:true}).click();await page.locator('[data-series="CREPE"]').waitFor({timeout:1500});assert.equal(await page.locator('[data-series]').count(),8);assert(snapshotCalls<=1,'Duplicate snapshot fetches');assert.equal(providerCalls,0);
  // Price must work directly from a multi-coin comparison and restore that selection.
  await page.getByRole('button',{name:/^Price ·/}).click();assert.equal(await page.locator('[data-series]').count(),1);assert.equal(await page.locator('[data-series="BTC"]').count(),1);
  await page.getByRole('button',{name:'Toggle Ethereum',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),1);assert.equal(await page.locator('[data-series="ETH"]').count(),1);assert.equal(await page.getByRole('button',{name:/^Price ·/}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Performance %',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),8);
  await page.getByRole('button',{name:'Toggle CREPE',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),7);
  await page.getByRole('button',{name:/^Price ·/}).click();await page.getByRole('button',{name:'Toggle Kishu Inu',exact:true}).click();assert.equal(await page.locator('[data-series="KISHU"]').count(),1);assert.equal(providerCalls,0);
  await page.getByRole('button',{name:'Performance %',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),7);assert.equal(await page.locator('[data-series="CREPE"]').count(),0);
  await page.getByRole('button',{name:'Show only Kishu Inu',exact:true}).click();await page.getByRole('button',{name:/^Price ·/}).click();assert.equal(await page.locator('[data-series]').count(),1);assert.equal(providerCalls,0);
  const numericText=(await page.locator('#metrics').innerText())+' '+(await page.locator('#hover-values').innerText())+' '+(await page.locator('#chart text').allTextContents()).join(' ');
  assert(!/\d(?:\.\d+)?e[+-]\d+/i.test(numericText),'Scientific notation remains visible');assert(numericText.includes('0.000000'),'Tiny KISHU price must show a decimal');
  const axisFits=await page.locator('#chart').evaluate(svg=>[...svg.querySelectorAll('text')].every(t=>t.getBBox().x>=0&&t.getBBox().x+t.getBBox().width<=svg.viewBox.baseVal.width+1));assert(axisFits,'Decimal axis labels overflow the chart');
  await page.getByRole('button',{name:'Compare all eight',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),8);assert(snapshotCalls<=1);
  await page.getByRole('button',{name:'Five years',exact:true}).click();await page.getByText('This period could not be loaded',{exact:true}).waitFor();assert.equal(providerCalls,0);
  await page.getByRole('button',{name:'One day',exact:true}).click();await page.getByRole('button',{name:'Toggle CREPE',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),7);assert(snapshotCalls<=1);
  await page.getByRole('button',{name:'Toggle CREPE',exact:true}).click();await page.locator('.wtct-jon-disclosure > summary').click();assert(await page.locator('.wtct-jon-content').isVisible());
  await fs.mkdir('qa',{recursive:true});await page.screenshot({path:`qa/tracker-${width}.png`,fullPage:true});console.log(JSON.stringify({width,firstChartMs,snapshotCalls,providerCalls}));await page.close();
 }
 // A stalled snapshot service must not delay the embedded first chart.
 const page=await browser.newPage();await page.route('**/*',async route=>{if(route.request().url()==='https://tracker.test/'){await route.fulfill({contentType:'text/html',body:html});return;}if(await serveAsset(route))return;await route.abort();});await page.goto('https://tracker.test/');assert.equal(await page.locator('[data-series]').count(),8);await page.close();
 // Manual refresh must fetch fresh quotes, preserve history and permit immediate retries after failure.
 const oldSnapshots=JSON.parse(snapshots),aged=Date.now()-3*3600000;
 for(const b of Object.values(oldSnapshots.ranges)){b.savedAt=aged;b.spec.historySavedAt=aged;}
 const oldHtml=html.replace(/(<script id="wtct-bootstrap" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,a,payload,b)=>{const j=JSON.parse(payload);for(const x of Object.values(j.ranges)){x.savedAt=aged;x.spec.historySavedAt=aged;}return a+JSON.stringify(j)+b;});
 const cg={BTC:'bitcoin',ETH:'ethereum',BNB:'binancecoin',XRP:'ripple',SOL:'solana',KISHU:'kishu-inu',WKC:'wiki-cat',CREPE:'crepe-2'};
 const quoteResponse=Object.fromEntries(oldSnapshots.ranges['1D'].data.map(([id,d])=>[cg[id],{usd:d.points.at(-1).p*1.01,last_updated_at:Math.floor(Date.now()/1000)}]));
 const cachedQuotes=Object.fromEntries(Object.entries(quoteResponse).map(([id,q])=>[id,{...q,usd:q.usd*1.02}]));
 function quotePayload(mode,cached=false){
  const values=structuredClone(cached?cachedQuotes:quoteResponse);
  if(mode==='stale')for(const q of Object.values(values))q.last_updated_at=Math.floor(aged/1000);
  if(mode==='missing')delete values['crepe-2'];
  if(mode==='selected-only')return {bitcoin:values.bitcoin};
  return values;
 }
 async function fulfilHistory(route){
  const u=new URL(route.request().url()),id=Object.keys(cg).find(k=>u.pathname.includes('/'+cg[k]+'/'));
  const now=Date.now(),step=3600000,start=Math.floor((now-86400000)/step)*step,p=quoteResponse[cg[id]].usd;
  await route.fulfill({contentType:'application/json',body:JSON.stringify({prices:Array.from({length:25},(_,i)=>[start+i*step,p*(1+i/1000)])})});
 }
 async function openRefreshPage(options={}){
  const settings={primary:'fresh',cache:'unavailable',history:'unavailable',selected:[],...options};
  const calls={quote:0,cache:0,history:0,events:[],requestedCoins:[]},page=await browser.newPage();
  const heldHistory=[];let historyWaiter=null;
  const nextHistory=()=>heldHistory.length?Promise.resolve(heldHistory.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>{historyWaiter=null;reject(Error('Expected the next historical request.'));},5000);historyWaiter=route=>{clearTimeout(timer);resolve(route);};});
  if(settings.clock)await page.clock.install({time:Date.now()});
  if(settings.stored)await page.addInitScript(value=>localStorage.setItem('wtct:v3:range:1D',JSON.stringify(value)),settings.stored);
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin==='https://tracker.test'&&u.pathname==='/'){await route.fulfill({contentType:'text/html',body:oldHtml});return;}
   if(u.origin==='https://tracker.test'&&u.pathname==='/data/ranges.json'){await route.fulfill({contentType:'application/json',body:JSON.stringify(oldSnapshots)});return;}
   if(u.origin==='https://tracker.test'&&u.pathname==='/data/quotes.json'){
    calls.cache++;calls.events.push('cache');
    if(settings.cache==='unavailable'){await route.abort();return;}
    // The cache-write time cannot make old provider observations current.
    await route.fulfill({contentType:'application/json',body:JSON.stringify({version:1,checkedAt:Date.now(),quotes:quotePayload(settings.cache,true)})});return;
   }
   if(u.hostname==='api.coingecko.com'&&u.pathname==='/api/v3/simple/price'){
    calls.quote++;calls.events.push('quotes');calls.requestedCoins.push(u.searchParams.get('ids'));
    await new Promise(r=>setTimeout(r,200));
    await route.fulfill({status:settings.primary==='failed'?503:200,contentType:'application/json',body:JSON.stringify(settings.primary==='failed'?{}:quotePayload(settings.primary))});return;
   }
   if(u.hostname==='api.coingecko.com'&&u.pathname.endsWith('/market_chart')){
    calls.history++;calls.events.push('history');
    if(settings.history==='fresh')await fulfilHistory(route);
    else if(settings.history==='controlled'){if(historyWaiter){const resolve=historyWaiter;historyWaiter=null;resolve(route);}else heldHistory.push(route);}
    else if(settings.history==='rate-limited')await route.fulfill({status:429,headers:{'Retry-After':'60'},contentType:'application/json',body:'{}'});
    else await route.abort();
    return;
   }
   if(await serveAsset(route))return;
   await route.abort();
  });
  await page.goto('https://tracker.test/'+(settings.selected.length?'?coins='+settings.selected.join(','):''));
  await page.locator('[data-series="BTC"]').waitFor();
  return {page,settings,calls,nextHistory};
 }
 async function waitForRefresh(page){await page.waitForFunction(()=>window.WealthTransferCryptoTracker.getState().busy===false);assert(await page.locator('#refresh').isEnabled());}
 const {page:refreshPage,settings,calls}=await openRefreshPage();
 await refreshPage.locator('#refresh').click();assert(await refreshPage.locator('#refresh').isDisabled());await waitForRefresh(refreshPage);
 await refreshPage.getByText(/^Quotes updated ·/).waitFor();assert.equal(calls.quote,1);
 const freshState=await refreshPage.evaluate(()=>window.WealthTransferCryptoTracker.getState());assert(Date.now()-freshState.end<300000);assert.equal(freshState.series.length,8);assert(freshState.series.every(x=>x.last.p>0));assert((await refreshPage.locator('#warning').innerText()).includes('history'));
 settings.primary='failed';await refreshPage.locator('#refresh').click();await waitForRefresh(refreshPage);await refreshPage.getByText(/Current quotes could not be checked/).waitFor();assert.equal(calls.quote,2);assert.equal(await refreshPage.locator('[data-series]').count(),8);
 settings.primary='fresh';await refreshPage.locator('#refresh').click();await waitForRefresh(refreshPage);await refreshPage.getByText(/^Quotes updated ·/).waitFor();assert.equal(calls.quote,3);assert(!/15 seconds|allow 15/i.test(await refreshPage.locator('body').innerText()));
 settings.history='fresh';await refreshPage.locator('#refresh').click();await waitForRefresh(refreshPage);await refreshPage.getByText(/^Quotes updated ·/).waitFor();assert(calls.history>=8);assert(await refreshPage.locator('#warning').isHidden(),'Repaired history should clear warning');
 await refreshPage.locator('#wtct-timezone').selectOption('America/New_York');await refreshPage.reload();assert.equal(await refreshPage.locator('#wtct-timezone').inputValue(),'America/New_York');assert((await refreshPage.locator('#dates').innerText()).includes('Eastern Time'));await refreshPage.close();
 // HTTP 200 is insufficient: stale or incomplete selected prices must use the verified fallback.
 for(const primary of ['stale','missing']){
  const test=await openRefreshPage({primary,cache:'fresh'});
  await test.page.locator('#refresh').click();await waitForRefresh(test.page);await test.page.getByText(/^Quotes updated ·/).waitFor();
  const current=await test.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
  assert.equal(test.calls.quote,1);assert.equal(test.calls.cache,1);assert.equal(current.series.length,8);
  assert.equal(current.series.find(x=>x.id==='BTC').last.p,cachedQuotes.bitcoin.usd,'Fresh fallback quote must replace invalid primary values');
  assert.equal(current.errors.length,0);await test.page.close();
 }
 // Two stale quote sets retain the original dated chart, then allow an immediate retry.
 const stale=await openRefreshPage({primary:'stale',cache:'stale'});
 const beforeStale=await stale.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 await stale.page.locator('#refresh').click();await waitForRefresh(stale.page);await stale.page.getByText(/Current quotes could not be checked/).waitFor();
 const afterStale=await stale.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 assert.equal(stale.calls.quote,1);assert.equal(stale.calls.cache,1);assert.equal(afterStale.end,beforeStale.end);assert.deepEqual(afterStale.series,beforeStale.series);assert(afterStale.errors.length>0);
 stale.settings.primary='fresh';await stale.page.locator('#refresh').click();await waitForRefresh(stale.page);await stale.page.getByText(/^Quotes updated ·/).waitFor();assert.equal(stale.calls.quote,2);assert.equal(await stale.page.locator('[data-series]').count(),8);await stale.page.close();
 // A one-coin selection must not require quotes for the seven unselected coins.
 const selected=await openRefreshPage({primary:'stale',cache:'selected-only',selected:['BTC']});
 await selected.page.locator('#refresh').click();await waitForRefresh(selected.page);await selected.page.getByText(/^Quotes updated ·/).waitFor();
 const selectedState=await selected.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 assert.deepEqual(selected.calls.requestedCoins,['bitcoin']);assert.equal(selected.calls.cache,1);assert.deepEqual(selectedState.series.map(x=>x.id),['BTC']);assert.equal(selectedState.series[0].last.p,cachedQuotes.bitcoin.usd);await selected.page.close();
 // A recently written local cache still shows its oldest selected quote's actual age.
 const stored=structuredClone(oldSnapshots.ranges['1D']),cacheNow=Date.now(),shift=cacheNow-45*60000-stored.spec.end;
 stored.savedAt=cacheNow;stored.spec.quoteCheckedAt=cacheNow;stored.spec.start+=shift;stored.spec.end=cacheNow;
 for(const [id,d]of stored.data){
  for(const point of d.points)point.t+=shift;
  if(id!=='BTC'){const last=d.points.at(-1);d.points.push({...last,t:cacheNow,gapBefore:true});d.gaps++;}
 }
 const local=await openRefreshPage({stored});
 await local.page.getByText(/^Older quotes ·/).waitFor();assert.equal(local.calls.quote,0);assert.equal((await local.page.evaluate(()=>window.WealthTransferCryptoTracker.getState())).end,cacheNow);assert(await local.page.locator('#warning').isVisible());
 await local.page.getByRole('button',{name:'Show only Ethereum',exact:true}).click();await local.page.getByText(/^Quotes updated ·/).waitFor();await local.page.close();
 // Old-history requests may be rate-limited without suppressing the current-price request or result.
 const limited=await openRefreshPage({history:'rate-limited'});
 await limited.page.locator('#refresh').click();await waitForRefresh(limited.page);await limited.page.getByText(/^Quotes updated ·/).waitFor();
 assert.equal(limited.calls.events[0],'quotes','Current quotes must be requested before old history');assert(limited.calls.history>0);assert.equal(limited.calls.quote,1);assert.equal(limited.calls.cache,0);
 const limitedState=await limited.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 assert.equal(limitedState.series.length,8);assert(limitedState.series.every(x=>Date.now()-x.last.t<300000));assert((await limited.page.locator('#warning').innerText()).includes('history'));assert(!/Current quotes could not be checked/.test(await limited.page.locator('#warning').innerText()));await limited.page.close();
 // The history deadline covers the whole repair, not a new 15 seconds for each coin.
 const slow=await openRefreshPage({history:'controlled',clock:true}),firstHistory=slow.nextHistory();
 await slow.page.locator('#refresh').click();const firstRoute=await firstHistory;
 await slow.page.getByText(/^Quotes updated ·/).waitFor();assert((await slow.page.evaluate(()=>window.WealthTransferCryptoTracker.getState())).busy);
 await slow.page.clock.fastForward(10000);const secondHistory=slow.nextHistory();await fulfilHistory(firstRoute);const secondRoute=await secondHistory;
 await slow.page.clock.fastForward(6000);await waitForRefresh(slow.page);await slow.page.getByText(/^Quotes updated ·/).waitFor();
 assert.equal(slow.calls.quote,1);assert.equal(slow.calls.history,2);assert.equal(await slow.page.locator('[data-series]').count(),8);assert((await slow.page.locator('#warning').innerText()).includes('history'));
 await secondRoute.abort().catch(()=>{});await slow.page.close();
 console.log('PASS: history repair, persisted Eastern Time, current-quote refresh, in-flight button guard, stale/missing HTTP-200 fallback, stale-source rejection, selected-coin validation, actual cached-quote age, quotes before rate-limited history, shared history deadline and immediate retry.');
 await browser.close();console.log('PASS: immediate offline chart, single snapshot request, all periods, rapid selections, Price-button switching and comparison restoration, tiny prices, mobile widths and isolated Jon George panel.');
})().catch(e=>{console.error(e);process.exit(1);});
