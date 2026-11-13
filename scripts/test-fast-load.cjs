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
  await page.getByRole('button',{name:'Show only Kishu Inu',exact:true}).click();await page.getByRole('button',{name:/^Price ·/}).click();assert.equal(await page.locator('[data-series]').count(),1);assert.equal(providerCalls,0);
  await page.getByRole('button',{name:'Compare all eight',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),8);assert(snapshotCalls<=1);
  await page.getByRole('button',{name:'Five years',exact:true}).click();await page.getByText('This period could not be loaded',{exact:true}).waitFor();assert.equal(providerCalls,0);
  await page.getByRole('button',{name:'One day',exact:true}).click();await page.getByRole('button',{name:'Toggle CREPE',exact:true}).click();assert.equal(await page.locator('[data-series]').count(),7);assert(snapshotCalls<=1);
  await page.getByRole('button',{name:'Toggle CREPE',exact:true}).click();await page.locator('.wtct-jon-disclosure > summary').click();assert(await page.locator('.wtct-jon-content').isVisible());
  await fs.mkdir('qa',{recursive:true});await page.screenshot({path:`qa/tracker-${width}.png`,fullPage:true});console.log(JSON.stringify({width,firstChartMs,snapshotCalls,providerCalls}));await page.close();
 }
 // A stalled snapshot service must not delay the embedded first chart.
 const page=await browser.newPage();await page.route('**/*',async route=>{if(route.request().url()==='https://tracker.test/'){await route.fulfill({contentType:'text/html',body:html});return;}await route.abort();});await page.goto('https://tracker.test/');assert.equal(await page.locator('[data-series]').count(),8);await page.close();
 await browser.close();console.log('PASS: immediate offline chart, single snapshot request, all periods, rapid selections, tiny prices, mobile widths and isolated Jon George panel.');
})().catch(e=>{console.error(e);process.exitCode=1;});
