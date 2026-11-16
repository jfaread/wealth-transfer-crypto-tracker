const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
const CHART_COINS=['BTC','ETH','BNB','XRP','SOL','SHIB','KISHU','WKC','CREPE'];
(async()=>{
 const html=await fs.readFile('_site/index.html','utf8'),snapshots=await fs.readFile('_site/data/ranges.json','utf8');
 const prepared=JSON.parse(snapshots);
 for(const range of ['1D','5D','1M','6M','YTD','1Y']){
  const bundle=prepared.ranges[range];
  assert(bundle,'Missing prepared '+range+' period');
  assert.deepEqual(bundle.data.map(([id])=>id),CHART_COINS,'Every prepared period must contain all nine chart currencies');
  const shib=new Map(bundle.data).get('SHIB');
  assert(shib.points.length>=2&&shib.points.every(point=>Number.isFinite(point.p)&&point.p>0),'SHIB needs at least two positive price observations in '+range);
  assert.equal(shib.points[0].t,bundle.spec.start);
  assert(bundle.spec.end-shib.points.at(-1).t<=bundle.spec.step,'SHIB history must cover the prepared '+range+' period');
 }
 const assetTypes={'/assets/alerts.js':'text/javascript','/assets/alerts.css':'text/css','/alerts-config.json':'application/json','/manifest.webmanifest':'application/manifest+json','/sw.js':'text/javascript','/icons/cw.svg':'image/svg+xml','/icons/cw-192.png':'image/png','/icons/cw-512.png':'image/png'};
 const assets=new Map(await Promise.all(Object.entries(assetTypes).map(async([path,contentType])=>[path,{contentType,body:await fs.readFile('_site'+path)}])));
 async function serveAsset(route){const u=new URL(route.request().url());if(u.origin!=='https://tracker.test'||!assets.has(u.pathname))return false;await route.fulfill(assets.get(u.pathname));return true;}
 const browser=await chromium.launch(require('./browser-launch.cjs')());
 for(const width of [320,390,768,1440]){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});let providerCalls=0,snapshotCalls=0;page.on('pageerror',e=>console.error('PAGE ERROR',e.stack));
  await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin==='https://tracker.test'&&u.pathname==='/'){await route.fulfill({contentType:'text/html',body:html});return;}if(u.origin==='https://tracker.test'&&u.pathname==='/data/ranges.json'){snapshotCalls++;await new Promise(r=>setTimeout(r,150));await route.fulfill({contentType:'application/json',body:snapshots});return;}if(u.hostname.includes('binance')||u.hostname.includes('coingecko'))providerCalls++;if(await serveAsset(route))return;await route.abort();});
  const started=Date.now();await page.goto('https://tracker.test/',{waitUntil:'domcontentloaded'});await page.locator('[data-series="CREPE"]').waitFor({timeout:1500});const firstChartMs=Date.now()-started;
  assert.equal(await page.locator('[data-series]').count(),CHART_COINS.length);assert.equal(providerCalls,0);
  await page.locator('#wtct-timezone').selectOption('America/New_York');assert((await page.locator('#dates').innerText()).includes('Eastern Time'));assert((await page.locator('#hover-date').innerText()).includes('Eastern Time'));assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('wtct:v3:timezone'))),'America/New_York');await page.locator('#wtct-timezone').selectOption('Europe/London');
  const layout=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert(layout.scroll<=layout.width,JSON.stringify({width,...layout}));
  await page.getByRole('button',{name:'One month',exact:true}).click();await page.locator('[data-series="CREPE"]').waitFor({timeout:1500});assert.equal(await page.locator('[data-series]').count(),CHART_COINS.length);assert(snapshotCalls<=1,'Duplicate snapshot fetches');assert.equal(providerCalls,0);
  // Price must work directly from a multi-coin comparison and restore that selection.
  await page.getByRole('button',{name:/^Price ·/}).click();assert.equal(await page.locator('[data-series]').count(),1);assert.equal(await page.locator('[data-series="BTC"]').count(),1);
  await page.getByRole('button',{name:'Toggle Ethereum',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),1);assert.equal(await page.locator('[data-series="ETH"]').count(),1);assert.equal(await page.getByRole('button',{name:/^Price ·/}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Toggle Shiba Inu',exact:true}).click();
  assert.equal(await page.locator('[data-series]').count(),1);assert.equal(await page.locator('[data-series="SHIB"]').count(),1);
  assert.equal(await page.locator('#heading').innerText(),'Shiba Inu price');
  const shibPrice=await page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
  assert.equal(shibPrice.mode,'price');assert.deepEqual(shibPrice.coins,['SHIB']);assert(shibPrice.series[0].last.p>0);assert.equal(providerCalls,0);
  assert(!/\d(?:\.\d+)?e[+-]\d+/i.test(await page.locator('#metrics').innerText()),'SHIB price must use ordinary decimals');
  await page.getByRole('button',{name:'Performance %',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),CHART_COINS.length);
  assert.deepEqual((await page.evaluate(()=>window.WealthTransferCryptoTracker.getState())).coins,CHART_COINS,'Returning from SHIB price restores the full comparison');
  await page.getByRole('button',{name:'Toggle CREPE',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),CHART_COINS.length-1);
  await page.getByRole('button',{name:/^Price ·/}).click();await page.getByRole('button',{name:'Toggle Kishu Inu',exact:true}).click();assert.equal(await page.locator('[data-series="KISHU"]').count(),1);assert.equal(providerCalls,0);
  await page.getByRole('button',{name:'Performance %',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),CHART_COINS.length-1);assert.equal(await page.locator('[data-series="CREPE"]').count(),0);
  await page.getByRole('button',{name:'Show only Kishu Inu',exact:true}).click();await page.getByRole('button',{name:/^Price ·/}).click();assert.equal(await page.locator('[data-series]').count(),1);assert.equal(providerCalls,0);
  const numericText=(await page.locator('#metrics').innerText())+' '+(await page.locator('#hover-values').innerText())+' '+(await page.locator('#chart text').allTextContents()).join(' ');
  assert(!/\d(?:\.\d+)?e[+-]\d+/i.test(numericText),'Scientific notation remains visible');assert(numericText.includes('0.000000'),'Tiny KISHU price must show a decimal');
  const axisFits=await page.locator('#chart').evaluate(svg=>[...svg.querySelectorAll('text')].every(t=>t.getBBox().x>=0&&t.getBBox().x+t.getBBox().width<=svg.viewBox.baseVal.width+1));assert(axisFits,'Decimal axis labels overflow the chart');
  await page.getByRole('button',{name:'Compare all nine',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),CHART_COINS.length);assert(snapshotCalls<=1);
  await page.getByRole('button',{name:'Five years',exact:true}).click();await page.getByText('This period could not be loaded',{exact:true}).waitFor();assert.equal(providerCalls,0);
  await page.getByRole('button',{name:'One day',exact:true}).click();await page.getByRole('button',{name:'Toggle CREPE',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),CHART_COINS.length-1);assert(snapshotCalls<=1);
  await page.getByRole('button',{name:'Toggle CREPE',exact:true}).click();await page.locator('.wtct-jon-disclosure > summary').click();assert(await page.locator('.wtct-jon-content').isVisible());
  await fs.mkdir('qa',{recursive:true});await page.screenshot({path:`qa/tracker-${width}.png`,fullPage:true});console.log(JSON.stringify({width,firstChartMs,snapshotCalls,providerCalls}));await page.close();
 }
 // A stalled snapshot service must not delay the embedded first chart.
 const page=await browser.newPage();await page.route('**/*',async route=>{if(route.request().url()==='https://tracker.test/'){await route.fulfill({contentType:'text/html',body:html});return;}if(await serveAsset(route))return;await route.abort();});await page.goto('https://tracker.test/');assert.equal(await page.locator('[data-series]').count(),CHART_COINS.length);await page.close();
 // Manual refresh must fetch fresh quotes, preserve history and permit immediate retries after failure.
 const oldSnapshots=JSON.parse(snapshots),aged=Date.now()-3*3600000;
 for(const b of Object.values(oldSnapshots.ranges)){
  // Age the observations as well as the write time, independently of the
  // latest scheduled data publication used to build the test site.
  const shift=aged-b.spec.end;b.savedAt=aged;b.spec.start+=shift;b.spec.end=aged;b.spec.historySavedAt=aged;
  for(const [,d]of b.data){d.historySavedAt=aged;for(const point of d.points)point.t+=shift;if(Number.isSafeInteger(d.historyObservedAt))d.historyObservedAt+=shift;}
 }
 const oldHtml=html.replace(/(<script id="wtct-bootstrap" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,a,payload,b)=>{const j=JSON.parse(payload);for(const range of Object.keys(j.ranges))j.ranges[range]=oldSnapshots.ranges[range];return a+JSON.stringify(j)+b;});
 const cg={BTC:'bitcoin',ETH:'ethereum',BNB:'binancecoin',XRP:'ripple',SOL:'solana',SHIB:'shiba-inu',KISHU:'kishu-inu',WKC:'wiki-cat',CREPE:'crepe-2'};
 const quoteResponse=Object.fromEntries(oldSnapshots.ranges['1D'].data.map(([id,d])=>[cg[id],{usd:d.points.at(-1).p*1.01,last_updated_at:Math.floor(Date.now()/1000)}]));
 const cachedQuotes=Object.fromEntries(Object.entries(quoteResponse).map(([id,q])=>[id,{...q,usd:q.usd*1.02}]));
 function quotePayload(mode,cached=false){
  const values=structuredClone(cached?cachedQuotes:quoteResponse);
  if(mode==='stale')for(const q of Object.values(values))q.last_updated_at=Math.floor(aged/1000);
  if(mode==='missing')delete values['crepe-2'];
  if(mode==='missing-shib')delete values['shiba-inu'];
  if(mode==='selected-only')return {bitcoin:values.bitcoin};
  if(mode==='shib-only')return {'shiba-inu':values['shiba-inu']};
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
  if(settings.stored)await page.addInitScript(value=>{if(!localStorage.getItem('wtct:v3:range:1D'))localStorage.setItem('wtct:v3:range:1D',JSON.stringify(value));},settings.stored);
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
    const mode=settings.primarySequence?.length?settings.primarySequence.shift():settings.primary;
    await new Promise(r=>setTimeout(r,200));
    if(mode==='network'){await route.abort();return;}
    if(mode==='verified-older'){const last=new Map(settings.stored.data).get('XRP').points.at(-1);await route.fulfill({contentType:'application/json',body:JSON.stringify({ripple:{usd:last.p*0.99,last_updated_at:Math.floor((last.t-10000)/1000)}})});return;}
    await route.fulfill({status:mode==='failed'?503:mode==='rate-limited'?429:200,headers:mode==='rate-limited'?{'Retry-After':'120'}:{},contentType:'application/json',body:JSON.stringify(['failed','rate-limited'].includes(mode)?{}:quotePayload(mode))});return;
   }
   if(u.hostname==='api.coingecko.com'&&u.pathname.endsWith('/market_chart')){
    calls.history++;calls.events.push('history');
    if(settings.history==='fresh'||settings.history==='partial'&&!u.pathname.includes('/crepe-2/'))await fulfilHistory(route);
    else if(settings.history==='controlled'){if(historyWaiter){const resolve=historyWaiter;historyWaiter=null;resolve(route);}else heldHistory.push(route);}
    else if(settings.history==='rate-limited')await route.fulfill({status:429,headers:{'Retry-After':'60'},contentType:'application/json',body:'{}'});
    else await route.abort();
    return;
   }
   if(await serveAsset(route))return;
   await route.abort();
  });
  await page.goto('https://tracker.test/'+(settings.selected.length?'?coins='+settings.selected.join(','):''));
  await page.locator('[data-series="'+(settings.selected[0]||'BTC')+'"]').waitFor();
  return {page,settings,calls,nextHistory};
 }
 async function waitForRefresh(page){await page.waitForFunction(()=>window.WealthTransferCryptoTracker.getState().busy===false);assert(await page.locator('#refresh').isEnabled());}
 const {page:refreshPage,settings,calls}=await openRefreshPage();
 await refreshPage.locator('#refresh').click();assert(await refreshPage.locator('#refresh').isDisabled());await waitForRefresh(refreshPage);
 await refreshPage.getByText(/^Quotes updated ·/).waitFor();assert.equal(calls.quote,1);
 const freshState=await refreshPage.evaluate(()=>window.WealthTransferCryptoTracker.getState());assert(Date.now()-freshState.end<300000);assert.equal(freshState.series.length,CHART_COINS.length);assert(freshState.series.every(x=>x.last.p>0));assert.equal(freshState.series.find(x=>x.id==='SHIB').last.p,quoteResponse['shiba-inu'].usd,'SHIB receives a fresh quote with the full comparison');assert((await refreshPage.locator('#warning').innerText()).includes('history'));
 settings.primary='failed';await refreshPage.locator('#refresh').click();await waitForRefresh(refreshPage);await refreshPage.getByText(/^Saved quotes ·/).waitFor();assert.equal(calls.quote,3);assert.equal(await refreshPage.locator('[data-series]').count(),CHART_COINS.length);
 const retainedState=await refreshPage.evaluate(()=>window.WealthTransferCryptoTracker.getState());assert.deepEqual(retainedState.series.map(x=>x.last),freshState.series.map(x=>x.last),'Failed requests must preserve each verified observation and its timestamp');assert.equal(retainedState.errors.length,0);assert.match(await refreshPage.locator('#warning').innerText(),/Could not check for newer prices/);
 settings.primary='fresh';await refreshPage.locator('#refresh').click();await waitForRefresh(refreshPage);await refreshPage.getByText(/^Quotes updated ·/).waitFor();assert.equal(calls.quote,4);assert(!/15 seconds|allow 15/i.test(await refreshPage.locator('body').innerText()));assert(!/Could not check for newer prices/.test(await refreshPage.locator('#warning').innerText()));
 settings.history='fresh';await refreshPage.locator('#refresh').click();await waitForRefresh(refreshPage);await refreshPage.getByText(/^Quotes updated ·/).waitFor();assert(calls.history>=CHART_COINS.length);assert(await refreshPage.locator('#warning').isHidden(),'Repaired history should clear warning');
 await refreshPage.locator('#wtct-timezone').selectOption('America/New_York');await refreshPage.reload();assert.equal(await refreshPage.locator('#wtct-timezone').inputValue(),'America/New_York');assert((await refreshPage.locator('#dates').innerText()).includes('Eastern Time'));await refreshPage.close();
 // Reproduce the XRP screenshot: its two-minute-old quote remains usable,
 // while a failed new check must stay labelled as saved after UI changes.
 const recent=structuredClone(oldSnapshots.ranges['1D']),recentNow=Date.now(),observedAt=recentNow-120000,recentShift=observedAt-recent.spec.end;
 recent.savedAt=recentNow-60000;recent.spec.quoteCheckedAt=recentNow-60000;recent.spec.start+=recentShift;recent.spec.end=observedAt;
 for(const [,d]of recent.data){
  for(const point of d.points)point.t+=recentShift;
  if(Number.isSafeInteger(d.historyObservedAt))d.historyObservedAt+=recentShift;
  const last=d.points.at(-1);if(last.t<observedAt){const gapBefore=observedAt-last.t>recent.spec.step*1.5;d.points.push({t:observedAt,p:last.p,r:last.r,...(gapBefore?{gapBefore:true}:{})});if(gapBefore)d.gaps++;}
 }
 // A successful but slightly older remote reply must not show an outage.
 const checkedRecent=structuredClone(recent);for(const [,d]of checkedRecent.data)d.historySavedAt=Date.now();
 const checkedXrp=await openRefreshPage({primary:'verified-older',stored:checkedRecent,selected:['XRP']});
 const beforeChecked=await checkedXrp.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 await checkedXrp.page.locator('#refresh').click();await waitForRefresh(checkedXrp.page);await checkedXrp.page.getByText(/^Prices checked ·/).waitFor();
 assert.equal(checkedXrp.calls.quote,1);assert.equal(checkedXrp.calls.cache,1);assert.equal(await checkedXrp.page.locator('#status').getAttribute('class'),'status ready');assert(await checkedXrp.page.locator('#warning').isHidden());
 const afterChecked=await checkedXrp.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());assert.equal(afterChecked.series[0].last.p,beforeChecked.series[0].last.p);assert.equal(afterChecked.series[0].last.t,beforeChecked.series[0].last.t);
 // The return is relative to the newly rolled window, not the old baseline.
 const checkedSaved=await checkedXrp.page.evaluate(()=>JSON.parse(localStorage.getItem('wtct:v3:range:1D')));
 const checkedSeries=new Map(checkedSaved.data).get('XRP');
 assert(Math.abs(afterChecked.series[0].last.r-(afterChecked.series[0].last.p/checkedSeries.base-1)*100)<1e-9);
 assert.deepEqual(checkedSaved.spec.quoteRefresh.retainedIds,[]);assert.deepEqual(checkedSaved.spec.quoteRefresh.preservedIds,['XRP']);
 await checkedXrp.page.locator('#wtct-timezone').selectOption('America/New_York');await checkedXrp.page.reload();await checkedXrp.page.getByText(/^Prices checked ·.*Eastern Time/).waitFor();assert(await checkedXrp.page.locator('#warning').isHidden());
 checkedXrp.settings.primary='network';await checkedXrp.page.locator('#refresh').click();await waitForRefresh(checkedXrp.page);await checkedXrp.page.getByText(/^Saved quotes ·/).waitFor();assert.match(await checkedXrp.page.locator('#warning').innerText(),/Could not check for newer prices for XRP/);
 await fs.mkdir('qa',{recursive:true});await checkedXrp.page.screenshot({path:'qa/xrp-real-outage-retained.png',fullPage:true});await checkedXrp.page.close();
 console.log('PASS: successful older XRP reply is not a failure; exact latest price survives reload and Eastern Time; genuine later outage is still labelled.');
 const xrp=await openRefreshPage({primary:'network',stored:recent,selected:['XRP']});
 await xrp.page.getByRole('button',{name:/^Price ·/}).click();const beforeXrp=await xrp.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 await xrp.page.locator('#refresh').click();await waitForRefresh(xrp.page);await xrp.page.getByText(/^Saved quotes ·/).waitFor();
 const savedXrp=await xrp.page.evaluate(()=>JSON.parse(localStorage.getItem('wtct:v3:range:1D')));
 assert.equal(xrp.calls.quote,2);assert.equal(xrp.calls.cache,1);assert.equal(savedXrp.savedAt,recent.savedAt);assert.equal(savedXrp.spec.quoteCheckedAt,recent.spec.quoteCheckedAt);assert.equal(savedXrp.spec.quoteRefresh.state,'saved');assert.deepEqual(savedXrp.spec.quoteRefresh.retainedIds,['XRP']);assert.equal(savedXrp.data[0][1].points.at(-1).t,observedAt);assert.equal(savedXrp.data[0][1].points.at(-1).p,beforeXrp.series[0].last.p);
 assert.match(await xrp.page.locator('#warning').innerText(),/Could not check for newer prices for XRP/);assert.equal(await xrp.page.locator('#status').getAttribute('class'),'status failed');
 await xrp.page.locator('#wtct-timezone').selectOption('America/New_York');await xrp.page.getByText(/^Saved quotes ·.*Eastern Time/).waitFor();
 await xrp.page.reload();await xrp.page.getByText(/^Saved quotes ·.*Eastern Time/).waitFor();assert.equal(xrp.calls.quote,2);assert.match(await xrp.page.locator('#warning').innerText(),/Could not check for newer prices for XRP/);
 xrp.settings.primary='fresh';await xrp.page.locator('#refresh').click();await waitForRefresh(xrp.page);await xrp.page.getByText(/^Quotes updated ·/).waitFor();assert.equal(xrp.calls.quote,3);
 const renewedXrp=await xrp.page.evaluate(()=>JSON.parse(localStorage.getItem('wtct:v3:range:1D')));assert.equal(renewedXrp.spec.quoteRefresh.state,'updated');assert.deepEqual(renewedXrp.spec.quoteRefresh.retainedIds,[]);assert.equal(renewedXrp.data[0][1].points.at(-1).p,quoteResponse.ripple.usd);assert(!/Could not check for newer prices/.test(await xrp.page.locator('#warning').innerText()));await xrp.page.close();
 // A mixed result labels only the retained coin as saved when selecting it.
 const mixed=await openRefreshPage({primary:'selected-only',stored:recent,selected:['BTC','XRP']});
 await mixed.page.locator('#refresh').click();await waitForRefresh(mixed.page);await mixed.page.getByText(/^Saved quotes ·/).waitFor();
 const mixedState=await mixed.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());assert.equal(mixed.calls.quote,1);assert.equal(mixed.calls.cache,1);assert.equal(mixedState.series.find(x=>x.id==='BTC').last.p,quoteResponse.bitcoin.usd);assert.equal(mixedState.series.find(x=>x.id==='XRP').last.t,observedAt);
 await mixed.page.getByRole('button',{name:'Show only Bitcoin',exact:true}).click();await mixed.page.getByText(/^Quotes updated ·/).waitFor();
 await mixed.page.getByRole('button',{name:/^Price ·/}).click();await mixed.page.getByRole('button',{name:'Toggle XRP',exact:true}).click();await mixed.page.getByText(/^Saved quotes ·/).waitFor();assert.match(await mixed.page.locator('#warning').innerText(),/Could not check for newer prices for XRP/);assert.equal(mixed.calls.quote,1);await mixed.page.close();
 // A transient failure receives just one retry, after the published fallback.
 const retry=await openRefreshPage({primarySequence:['network','fresh'],stored:recent,selected:['XRP']});
 await retry.page.locator('#refresh').click();await waitForRefresh(retry.page);await retry.page.getByText(/^Quotes updated ·/).waitFor();assert.equal(retry.calls.quote,2);assert.equal(retry.calls.cache,1);assert.deepEqual(retry.calls.events.filter(x=>x!=='history'),['cache','quotes','quotes']);await retry.page.close();
 const quoteLimited=await openRefreshPage({primary:'rate-limited',stored:recent,selected:['XRP']});
 await quoteLimited.page.locator('#refresh').click();await waitForRefresh(quoteLimited.page);await quoteLimited.page.getByText(/^Saved quotes ·/).waitFor();assert.equal(quoteLimited.calls.quote,1);assert.equal(quoteLimited.calls.cache,1);
 await quoteLimited.page.locator('#refresh').click();await waitForRefresh(quoteLimited.page);assert.equal(quoteLimited.calls.quote,1,'A manual retry also respects the provider cooldown');await quoteLimited.page.close();
 // A valid but short saved period can receive a fresh quote without having
 // enough history to apply it. Keep the actionable reason after re-rendering.
 const shortHistory=structuredClone(oldSnapshots.ranges['1D']);shortHistory.savedAt=Date.now();shortHistory.spec.start=shortHistory.spec.end-2*3600000;
 for(const [,d]of shortHistory.data){const p=d.points.at(-1).p,middle=p*1.01;d.base=p;d.points=[{t:shortHistory.spec.start,p,r:0},{t:shortHistory.spec.start+3600000,p:middle,r:(middle/p-1)*100},{t:shortHistory.spec.end,p,r:0}];d.gaps=0;}
 const application=await openRefreshPage({stored:shortHistory,selected:['XRP']});
 await application.page.locator('#refresh').click();await waitForRefresh(application.page);assert.equal(application.calls.quote,1);assert.equal(application.calls.cache,1);assert.match(await application.page.locator('#warning').innerText(),/saved history no longer covers this period/);assert.match(await application.page.locator('#warning').innerText(),/Choose a longer period/);
 await application.page.locator('#wtct-timezone').selectOption('America/New_York');assert.match(await application.page.locator('#warning').innerText(),/Choose a longer period/);await application.page.close();
 // HTTP 200 is insufficient: stale or incomplete selected prices must use the verified fallback.
 for(const primary of ['stale','missing','missing-shib']){
  const test=await openRefreshPage({primary,cache:'fresh'});
  await test.page.locator('#refresh').click();await waitForRefresh(test.page);await test.page.getByText(/^Quotes updated ·/).waitFor();
  const current=await test.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
  assert.equal(test.calls.quote,0);assert.equal(test.calls.cache,1);assert.equal(current.series.length,CHART_COINS.length);
  assert.equal(current.series.find(x=>x.id==='BTC').last.p,cachedQuotes.bitcoin.usd,'A complete verified published quote set should be used without contacting the provider');
  assert.equal(current.errors.length,0);await test.page.close();
 }
 // Two stale quote sets retain the original dated chart, then allow an immediate retry.
 const stale=await openRefreshPage({primary:'stale',cache:'stale'});
 const beforeStale=await stale.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 await stale.page.locator('#refresh').click();await waitForRefresh(stale.page);await stale.page.getByText(/^Update unavailable · prices from/).waitFor();
 const afterStale=await stale.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 assert.equal(stale.calls.quote,1);assert.equal(stale.calls.cache,1);assert.equal(afterStale.end,beforeStale.end);assert.deepEqual(afterStale.series,beforeStale.series);assert(afterStale.errors.length>0);
 await stale.page.locator('#wtct-timezone').selectOption('America/New_York');await stale.page.getByText(/^Update unavailable · prices from.*Eastern Time/).waitFor();
 await stale.page.getByRole('button',{name:'Show only XRP',exact:true}).click();await stale.page.getByText(/^Update unavailable · prices from/).waitFor();await stale.page.reload();await stale.page.getByText(/^Update unavailable · prices from/).waitFor();await stale.page.getByRole('button',{name:'Compare all nine',exact:true}).click();
 stale.settings.primary='fresh';await stale.page.locator('#refresh').click();await waitForRefresh(stale.page);await stale.page.getByText(/^Quotes updated ·/).waitFor();assert.equal(stale.calls.quote,2);assert.equal(await stale.page.locator('[data-series]').count(),CHART_COINS.length);await stale.page.close();
 // A one-coin selection must not require quotes for the eight unselected coins.
 const selected=await openRefreshPage({primary:'stale',cache:'selected-only',selected:['BTC']});
 await selected.page.locator('#refresh').click();await waitForRefresh(selected.page);await selected.page.getByText(/^Quotes updated ·/).waitFor();
 const selectedState=await selected.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 assert.deepEqual(selected.calls.requestedCoins,[]);assert.equal(selected.calls.cache,1);assert.deepEqual(selectedState.series.map(x=>x.id),['BTC']);assert.equal(selectedState.series[0].last.p,cachedQuotes.bitcoin.usd);await selected.page.close();
 // SHIB-only refresh uses its exact provider identity and does not require the other eight quotes.
 const shibOnly=await openRefreshPage({primary:'stale',cache:'shib-only',selected:['SHIB']});
 await shibOnly.page.locator('#refresh').click();await waitForRefresh(shibOnly.page);await shibOnly.page.getByText(/^Quotes updated ·/).waitFor();
 const shibState=await shibOnly.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 assert.deepEqual(shibOnly.calls.requestedCoins,[]);assert.equal(shibOnly.calls.cache,1);assert.deepEqual(shibState.series.map(x=>x.id),['SHIB']);assert.equal(shibState.series[0].last.p,cachedQuotes['shiba-inu'].usd);await shibOnly.page.close();
 // A recently written local cache still shows its oldest selected quote's actual age.
 const stored=structuredClone(oldSnapshots.ranges['1D']),cacheNow=Date.now(),staleAt=cacheNow-45*60000,shift=staleAt-stored.spec.end;
 stored.savedAt=cacheNow;stored.spec.quoteCheckedAt=cacheNow;stored.spec.start+=shift;stored.spec.end=cacheNow;
 for(const [id,d]of stored.data){
  for(const point of d.points)point.t+=shift;
  if(Number.isSafeInteger(d.historyObservedAt))d.historyObservedAt+=shift;
  // Provider series can end at different times. Pin the intended fixture age
  // independently of the prepared snapshot's newest series.
  const last=d.points.at(-1),target=id==='BTC'?staleAt:cacheNow;
  if(last.t<target){const gapBefore=target-last.t>stored.spec.step*1.5;d.points.push({t:target,p:last.p,r:last.r,...(gapBefore?{gapBefore:true}:{})});if(gapBefore)d.gaps++;}
 }
 const local=await openRefreshPage({stored});
 await local.page.getByText(/^Older quotes ·/).waitFor();assert.equal(local.calls.quote,0);assert.equal((await local.page.evaluate(()=>window.WealthTransferCryptoTracker.getState())).end,cacheNow);assert(await local.page.locator('#warning').isVisible());
 await local.page.getByRole('button',{name:'Show only Ethereum',exact:true}).click();await local.page.getByText(/^Quotes updated ·/).waitFor();await local.page.close();
 // Old-history requests may be rate-limited without suppressing the current-price request or result.
 const limited=await openRefreshPage({history:'rate-limited'});
 await limited.page.locator('#refresh').click();await waitForRefresh(limited.page);await limited.page.getByText(/^Quotes updated ·/).waitFor();
 assert.equal(limited.calls.events[0],'cache','Current verified quotes must be checked before old history');assert(limited.calls.history>0);assert.equal(limited.calls.quote,1);assert.equal(limited.calls.cache,1);
 const limitedState=await limited.page.evaluate(()=>window.WealthTransferCryptoTracker.getState());
 assert.equal(limitedState.series.length,CHART_COINS.length);assert(limitedState.series.every(x=>Date.now()-x.last.t<300000));assert((await limited.page.locator('#warning').innerText()).includes('history'));assert(!/Current quotes could not be checked/.test(await limited.page.locator('#warning').innerText()));await limited.page.close();
 // A failed token cannot discard eight successful repairs, or redownload them on retry.
 const partial=await openRefreshPage({history:'partial'});
 await partial.page.locator('#refresh').click();await waitForRefresh(partial.page);
 const savedPartial=await partial.page.evaluate(()=>JSON.parse(localStorage.getItem('wtct:v3:range:1D')));
 assert(savedPartial.data.find(([id])=>id==='BTC')[1].historySavedAt>aged);
 assert.equal(savedPartial.data.find(([id])=>id==='CREPE')[1].historySavedAt,aged);
 assert.match(await partial.page.locator('#warning').innerText(),/CREPE/);
 const repairedCalls=partial.calls.history;partial.settings.history='fresh';
 await partial.page.locator('#refresh').click();await waitForRefresh(partial.page);
 assert.equal(partial.calls.history-repairedCalls,1,'Retry only the missing token history');
 assert(await partial.page.locator('#warning').isHidden());await partial.page.close();
 // The history deadline covers the whole repair, not a new 15 seconds for each coin.
 const slow=await openRefreshPage({history:'controlled',clock:true}),firstHistory=slow.nextHistory();
 await slow.page.locator('#refresh').click();const firstRoute=await firstHistory;
 await slow.page.getByText(/^Quotes updated ·/).waitFor();assert((await slow.page.evaluate(()=>window.WealthTransferCryptoTracker.getState())).busy);
 await slow.page.clock.fastForward(10000);const secondHistory=slow.nextHistory();await fulfilHistory(firstRoute);const secondRoute=await secondHistory;
 await slow.page.clock.fastForward(6000);await waitForRefresh(slow.page);await slow.page.getByText(/^Quotes updated ·/).waitFor();
 assert.equal(slow.calls.quote,1);assert(slow.calls.history>=2&&slow.calls.history<=3,"Only the two bounded repair lanes may run before the shared deadline");assert.equal(await slow.page.locator('[data-series]').count(),CHART_COINS.length);assert((await slow.page.locator('#warning').innerText()).includes('history'));
 await secondRoute.abort().catch(()=>{});await slow.page.close();
 console.log('PASS: history repair, persisted Eastern Time, current-quote refresh, retained XRP timestamps and honest saved status through reload/selection, partial remote recovery, bounded transient retry and provider cooldown, in-flight button guard, stale/missing HTTP-200 fallback, stale-source rejection, selected-coin and SHIB-only validation, actual cached-quote age, quotes before rate-limited history, shared history deadline and immediate retry.');
 await browser.close();console.log('PASS: immediate offline chart, single snapshot request, all nine coins across prepared periods, SHIB price and comparison restoration, rapid selections, Price-button switching and comparison restoration, tiny prices, mobile widths and isolated Jon George panel.');
})().catch(e=>{console.error(e);process.exit(1);});
