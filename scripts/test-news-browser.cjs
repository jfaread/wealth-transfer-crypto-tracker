const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
const SITE='https://jfaread.github.io/wealth-transfer-crypto-tracker/';
const CHANNEL='UCXJQosNTxvmyd925enPbQPw';
const SOURCE='https://www.youtube.com/feeds/videos.xml?channel_id='+CHANNEL;
(async()=>{
 const html=await fs.readFile('_site/index.html','utf8');
 const cached=JSON.parse(await fs.readFile('_site/data/jon-george.json','utf8'));
 const browser=await chromium.launch(require('./browser-launch.cjs')());
 try{
  for(const width of [390,1440]){
   const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
   let mode='offline',proxyCalls=0;
   await context.addInitScript(()=>localStorage.setItem('wtct:v3:auto','false'));
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    // The chart preserves its selection in the URL. Serve the same document
    // when reloading that legitimate query, just as GitHub Pages does.
    if(u.origin===new URL(SITE).origin&&[new URL(SITE).pathname,new URL(SITE).pathname+'index.html'].includes(u.pathname))return route.fulfill({contentType:'text/html',body:html});
    if(u.origin===new URL(SITE).origin&&u.pathname.startsWith(new URL(SITE).pathname)){
     const path=u.pathname.slice(new URL(SITE).pathname.length);
     if(path==='alerts-config.json')return route.fulfill({contentType:'application/json',body:'{"version":1,"apiBase":null}'});
     if(!/^(?:assets\/[a-z.-]+|data\/[a-zA-Z0-9.-]+|icons\/[a-z0-9.-]+|manifest\.webmanifest)$/.test(path))return route.abort();
     try{return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/json',body:await fs.readFile('_site/'+path)});}catch{return route.abort();}
    }
    if(u.origin==='https://api.rss2json.com'){
     proxyCalls++;const url=u.searchParams.get('rss_url');
     if(mode==='offline'||(mode==='partial'&&url===SOURCE))return route.fulfill({status:503,contentType:'application/json',body:'{}'});
     const creator=url===SOURCE;
     const items=creator?cached.items.map(item=>({...item,pubDate:new Date(item.publishedAt).toISOString(),guid:'yt:video:'+new URL(item.link).searchParams.get('v'),link:'https://rss2json.com/to/opaque'})):Array.from({length:25},(_,i)=>({title:(url.includes('coindesk')?'Desk':'Telegraph')+' headline '+i,link:'https://rss2json.com/to/opaque-'+i,guid:'https://'+(url.includes('coindesk')?'www.coindesk.com':'cointelegraph.com')+'/news/'+i,pubDate:new Date(Date.now()-i*1000).toISOString()}));
     return route.fulfill({contentType:'application/json',body:JSON.stringify({status:'ok',feed:{url},items})});
    }
    return route.abort();
   });
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(SITE,{waitUntil:'domcontentloaded'});
   await page.locator('.wtct-jon-disclosure > summary').click();
   await page.waitForFunction(()=>document.querySelectorAll('#wtct-jon-list li').length===5);
   assert.equal(await page.locator('#wtct-jon-count').innerText(),'5 updates');
   assert.match(await page.locator('#wtct-jon-status').innerText(),/saved feed checked/);
   const links=await page.locator('#wtct-jon-list a').evaluateAll(a=>a.map(x=>x.href));
   assert.deepEqual(links,cached.items.map(x=>x.link));
   mode='live';await page.reload({waitUntil:'networkidle'});await page.locator('.wtct-jon-disclosure > summary').click();
   await page.waitForFunction(()=>document.querySelectorAll('#wtct-news-list li').length===30);
   assert.equal(await page.locator('#wtct-jon-list li').count(),5,'busy news cannot crowd out the five videos');
   assert(!(await page.locator('#wtct-track').innerText()).includes(cached.items[0].title),'creator videos stay out of the general ticker');
   mode='partial';await page.reload({waitUntil:'networkidle'});await page.locator('.wtct-jon-disclosure > summary').click();
   assert.equal(await page.locator('#wtct-jon-list li').count(),5,'a failed creator refresh cannot remove saved updates');
   assert.match(await page.locator('#wtct-jon-status').innerText(),/saved feed checked/);
   const layout=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert(layout.scroll<=layout.width);
   assert.deepEqual(errors,[]);await fs.mkdir('qa',{recursive:true});await page.screenshot({path:'qa/creator-updates-'+width+'.png',fullPage:true});
   console.log('PASS: five direct creator links, saved-feed recovery, partial failures, independent news cap and layout at '+width+'px; '+proxyCalls+' mocked requests.');
   await context.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
