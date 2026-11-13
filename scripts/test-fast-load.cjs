const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
(async()=>{
 const html=await fs.readFile('_site/index.html','utf8'),snapshots=await fs.readFile('_site/data/ranges.json','utf8');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [320,390,768,1440]){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});let providerCalls=0,snapshotCalls=0;
  await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin==='https://tracker.test'&&u.pathname==='/'){await route.fulfill({contentType:'text/html',body:html});return;}if(u.origin==='https://tracker.test'&&u.pathname==='/data/ranges.json'){snapshotCalls++;await new Promise(r=>setTimeout(r,150));await route.fulfill({contentType:'application/json',body:snapshots});return;}if(u.hostname.includes('binance')||u.hostname.includes('coingecko'))providerCalls++;await route.abort();});
  const started=Date.now();await page.goto('https://tracker.test/',{waitUntil:'domcontentloaded'});await page.locator('[data-series="CREPE"]').waitFor({timeout:1500});const firstChartMs=Date.now()-started;
  assert.equal(await page.locator('[data-series]').count(),8);assert.equal(providerCalls,0);
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
 const page=await browser.newPage();await page.route('**/*',async route=>{if(route.request().url()==='https://tracker.test/'){await route.fulfill({contentType:'text/html',body:html});return;}await route.abort();});await page.goto('https://tracker.test/');assert.equal(await page.locator('[data-series]').count(),8);await page.close();
 // Manual refresh must fetch fresh quotes, preserve history and permit immediate retries after failure.
 const oldSnapshots=JSON.parse(snapshots),aged=Date.now()-3*3600000;
 for(const b of Object.values(oldSnapshots.ranges)){b.savedAt=aged;b.spec.historySavedAt=aged;}
 const oldHtml=html.replace(/(<script id="wtct-bootstrap" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,a,payload,b)=>{const j=JSON.parse(payload);for(const x of Object.values(j.ranges)){x.savedAt=aged;x.spec.historySavedAt=aged;}return a+JSON.stringify(j)+b;});
 const refreshPage=await browser.newPage();let quoteCalls=0,failQuotes=false;
 const cg={BTC:'bitcoin',ETH:'ethereum',BNB:'binancecoin',XRP:'ripple',SOL:'solana',KISHU:'kishu-inu',WKC:'wiki-cat',CREPE:'crepe-2'};
 const quoteResponse=Object.fromEntries(oldSnapshots.ranges['1D'].data.map(([id,d])=>[cg[id],{usd:d.points.at(-1).p*1.01,last_updated_at:Math.floor(Date.now()/1000)}]));
 await refreshPage.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin==='https://tracker.test'&&u.pathname==='/'){await route.fulfill({contentType:'text/html',body:oldHtml});return;}if(u.origin==='https://tracker.test'&&u.pathname==='/data/ranges.json'){await route.fulfill({contentType:'application/json',body:JSON.stringify(oldSnapshots)});return;}if(u.hostname==='api.coingecko.com'&&u.pathname==='/api/v3/simple/price'){quoteCalls++;await new Promise(r=>setTimeout(r,200));await route.fulfill({status:failQuotes?503:200,contentType:'application/json',body:JSON.stringify(failQuotes?{}:quoteResponse)});return;}await route.abort();});
 await refreshPage.goto('https://tracker.test/');await refreshPage.locator('[data-series="CREPE"]').waitFor();
 await refreshPage.locator('#refresh').click();assert(await refreshPage.locator('#refresh').isDisabled());await refreshPage.getByText(/^Quotes updated ·/).waitFor();assert.equal(quoteCalls,1);assert(await refreshPage.locator('#refresh').isEnabled());
 const freshState=await refreshPage.evaluate(()=>window.WealthTransferCryptoTracker.getState());assert(Date.now()-freshState.end<300000);assert.equal(freshState.series.length,8);assert(freshState.series.every(x=>x.last.p>0));assert((await refreshPage.locator('#warning').innerText()).includes('history'));
 failQuotes=true;await refreshPage.locator('#refresh').click();await refreshPage.getByText(/Current quotes could not be checked/).waitFor();assert.equal(quoteCalls,2);assert(await refreshPage.locator('#refresh').isEnabled());assert.equal(await refreshPage.locator('[data-series]').count(),8);
 failQuotes=false;await refreshPage.locator('#refresh').click();await refreshPage.getByText(/^Quotes updated ·/).waitFor();assert.equal(quoteCalls,3);assert(!/15 seconds|allow 15/i.test(await refreshPage.locator('body').innerText()));await refreshPage.close();
 console.log('PASS: current-quote refresh, in-flight button guard, retained dated history, failed-refresh recovery and immediate retry.');
 await browser.close();console.log('PASS: immediate offline chart, single snapshot request, all periods, rapid selections, Price-button switching and comparison restoration, tiny prices, mobile widths and isolated Jon George panel.');
})().catch(e=>{console.error(e);process.exitCode=1;});



