const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');

const SITE='https://jfaread.github.io/wealth-transfer-crypto-tracker/';
const API='https://crypto-watch-alerts.qa.workers.dev';
const KEY='wtct-alerts-v1';
const IDS=['BTC','ETH','BNB','XRP','SOL','KISHU','WKC','CREPE'];
const DEVICE='cb54d1cb-2489-4472-a6ce-d0959789a956';
const TOKEN=DEVICE+'.'+'1'.repeat(64); // Deliberately synthetic; no live account exists.
const TYPES={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};

(async()=>{
 const {applySiteCsp}=await import('../scripts/build-site.mjs');
 const {generateVAPIDKeys}=await import('web-push');
 const vapid=generateVAPIDKeys();
 const html=await fs.readFile('_site/index.html','utf8');
 const browser=await chromium.launch(require('./browser-launch.cjs')());
 const cors={'Access-Control-Allow-Origin':'https://jfaread.github.io','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'};
 const config=()=>({version:1,enabled:true,vapidPublicKey:vapid.publicKey,coins:IDS.map((id,i)=>({id,name:id,enabled:i<5,source:i<5?'Kraken '+id+'/USD':null,maxAgeMs:60000,reason:i<5?null:'The exact token live feed is still being verified.'}))});

 async function mockBrowser(context){
  await context.addInitScript(({site,key})=>{
   window.__alertProbe={permissions:0,subscriptions:0,unsubscribes:0,registrations:0};
   window.__alertListeners={};
   let permission='default',subscription=null;
   function NotificationMock(){}
   Object.defineProperty(NotificationMock,'permission',{get:()=>permission});
   NotificationMock.requestPermission=async()=>{window.__alertProbe.permissions++;permission='granted';return permission;};
   Object.defineProperty(window,'Notification',{configurable:true,value:NotificationMock});
   Object.defineProperty(window,'PushManager',{configurable:true,value:function(){}});
   const registration={scope:site,active:{state:'activated'},pushManager:{
    getSubscription:async()=>subscription,
    subscribe:async()=>{window.__alertProbe.subscriptions++;subscription={
     options:{applicationServerKey:Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0)).buffer},
     toJSON:()=>({endpoint:'https://fcm.googleapis.com/fcm/send/qa-only',keys:{p256dh:key,auth:'AQEBAQEBAQEBAQEBAQEBAQ'}}),
     unsubscribe:async()=>{window.__alertProbe.unsubscribes++;subscription=null;return true;}
    };return subscription;}
   }};
   Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{
    register:async(url,options)=>{if(url!==site+'sw.js'||options.scope!==new URL(site).pathname)throw Error('Wrong worker scope');window.__alertProbe.registrations++;return registration;},
    getRegistration:async()=>registration,
    addEventListener:(type,handler)=>{window.__alertListeners[type]=handler;}
   }});
  },{site:SITE,key:vapid.publicKey});
 }

 async function mount(context,active=false,apiHandler=null){
  const localConfig={version:1,apiBase:active?API:null};
  const body=applySiteCsp(html,localConfig);
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());
   if(u.origin===API){
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
    if(apiHandler)return apiHandler(route);
    return route.abort();
   }
   if(req.url().startsWith(SITE)){
    let path=u.pathname.slice(new URL(SITE).pathname.length)||'index.html';
    if(path==='index.html')return route.fulfill({contentType:'text/html',body});
    if(path==='alerts-config.json')return route.fulfill({contentType:'application/json',body:JSON.stringify(localConfig)});
    if(!/^(?:assets\/[a-z.-]+|icons\/[a-z0-9.-]+|data\/[a-zA-Z0-9.-]+|manifest\.webmanifest|sw\.js)$/.test(path))return route.abort();
    try{return route.fulfill({contentType:TYPES[path.slice(path.lastIndexOf('.'))]||'application/octet-stream',body:await fs.readFile('_site/'+path)});}catch{return route.abort();}
   }
   await route.abort(); // No external market, messaging or analytics calls.
  });
 }

 async function open(page){
  await page.goto(SITE,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Price alerts',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('wtct-alerts-dialog').getAttribute('aria-busy')==='false');
 }
 async function add(page,coin,price){
  await page.locator('#wa-coin').selectOption(coin);
  await page.locator('#wa-threshold').fill(price);
  await page.locator('#wa-save-rule').click();
  await page.waitForFunction(()=>document.getElementById('wtct-alerts-dialog').getAttribute('aria-busy')==='false');
 }

 try{
  for(const width of [320,390,768,1440]){
   const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
   await mockBrowser(context);await mount(context);
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await open(page);
   assert.match(await page.locator('#wa-status').innerText(),/not enabled yet/);
   assert.equal(await page.locator('#wa-connect').isVisible(),false);
   await add(page,'KISHU','0.000000000000000000000001');
   assert.match(await page.locator('#wa-draft-rules').innerText(),/0\.000000000000000000000001/);
   assert.match(await page.locator('#wa-draft-rules').innerText(),/not active/);
   await add(page,'BTC','1e-8');
   assert.equal(await page.locator('#wa-threshold').getAttribute('aria-invalid'),'true');
   assert.equal(await page.locator('#wa-draft-rules .wa-rule').count(),1);
   assert.deepEqual(await page.evaluate(()=>window.__alertProbe),{permissions:0,subscriptions:0,unsubscribes:0,registrations:0});
   const size=await page.locator('#wtct-alerts-dialog').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,body:document.documentElement.scrollWidth,viewport:innerWidth}));
   assert(size.scroll<=size.width+1&&size.body<=size.viewport,JSON.stringify({width,...size}));
   await fs.mkdir('qa',{recursive:true});await page.screenshot({path:`qa/alerts-${width}.png`});
   await page.keyboard.press('Escape');assert.equal(await page.locator('#wtct-alerts-dialog').isVisible(),false);
   assert.equal(await page.locator('#wtct-alerts-open').evaluate(el=>el===document.activeElement),true);
   await page.reload({waitUntil:'domcontentloaded'});await page.locator('#wtct-alerts-open').click();
   await page.waitForFunction(()=>document.getElementById('wtct-alerts-dialog').getAttribute('aria-busy')==='false');
   assert.equal(await page.locator('#wa-draft-rules .wa-rule').count(),1);
   assert.deepEqual(errors,[]);
   console.log(`PASS: inactive draft, exact tiny decimal, no permission prompt, keyboard focus and layout at ${width}px.`);
   await context.close();
  }

  const context=await browser.newContext({viewport:{width:390,height:900},reducedMotion:'reduce'});
  await mockBrowser(context);
  let registered=false,revision=0,saved=[],conflict=false,failDelete=true,testRequests=0;
  const records=[];
  const reply=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',headers:cors,body:JSON.stringify(value)});
  const monitor={status:'live',lastObservedAt:Date.now(),message:'Monitoring fresh USD quotes. Delivery is best effort.'};
  await mount(context,true,async route=>{
   const req=route.request(),path=new URL(req.url()).pathname,method=req.method();
   records.push({path,method});assert.equal(new URL(req.url()).search,'');
   if(path==='/v1/config')return reply(route,config());
   if(path==='/v1/devices'&&method==='POST'){
    const input=req.postDataJSON();assert.equal(input.consentVersion,'2026-11-13');assert(input.operationId);assert(input.subscription.endpoint.endsWith('/qa-only'));
    registered=true;return reply(route,{deviceId:DEVICE,token:TOKEN,rules:[],revision:0},201);
   }
   assert.equal(req.headers().authorization,'Bearer '+TOKEN);
   if(!registered)return reply(route,{error:{code:'not_authorised'}},401);
   if(path==='/v1/device'&&method==='GET')return reply(route,{deviceId:DEVICE,rules:saved,revision,events:[],monitor});
   if(path==='/v1/rules'&&method==='PUT'){
    const input=req.postDataJSON();
    if(conflict){conflict=false;revision++;return reply(route,{error:{code:'revision_conflict'}},409);}
    assert.equal(input.revision,revision);saved=input.rules;revision++;return reply(route,{rules:saved,revision});
   }
   if(path==='/v1/test'){testRequests++;return reply(route,{eventId:'qa-test',status:'queued'},202);}
   if(path==='/v1/device'&&method==='DELETE'){
    if(failDelete){failDelete=false;return reply(route,{error:{code:'temporarily_unavailable'}},503);}
    registered=false;saved=[];return reply(route,{deleted:true});
   }
   throw Error('Unexpected QA API path');
  });
  const page=await context.newPage();await open(page);
  assert.equal(await page.evaluate(()=>window.__alertProbe.permissions),0);
  await page.locator('#wa-connect').click();await page.getByText(/Notification permission is allowed/).waitFor();
  assert.equal(registered,false,'permission alone must not claim a server connection');
  await page.locator('#wa-connect').click();await page.getByText(/^This device is connected\. 0 enabled rules/).waitFor();
  assert.equal(await page.evaluate(()=>window.__alertProbe.subscriptions),1);
  await add(page,'BTC','100.0000');assert.equal(saved[0].threshold,'100');
  await add(page,'KISHU','0.0000000001');assert.equal(saved.length,1);assert.equal(await page.locator('#wa-draft-rules .wa-rule').count(),1);
  conflict=true;await add(page,'ETH','2000');assert.equal(saved.length,1);assert.match(await page.locator('#wa-message').innerText(),/latest list has been loaded/);
  await page.locator('#wa-save-rule').click();await page.waitForFunction(()=>document.getElementById('wtct-alerts-dialog').getAttribute('aria-busy')==='false');assert.equal(saved.length,2);
  await page.locator('#wa-test').click();await page.getByText(/Test notification requested/).waitFor();assert.equal(testRequests,1);
  await page.locator('#wa-close').click();
  const foreground={type:'wtct-price-alert',version:1,eventId:'qa-foreground-1',title:'BTC price alert',body:'BTC crossed above US$100. Observed US$101 on Kraken BTC/USD.',url:SITE,observedAt:Date.now(),expiresAt:Date.now()+120000,expired:false};
  await page.evaluate(({message,site})=>window.__alertListeners.message({source:{scriptURL:site+'sw.js'},data:message}),{message:foreground,site:SITE});
  await page.locator('#wtct-alert-banner').waitFor({state:'visible'});
  assert.equal(await page.locator('#wa-banner-title').innerText(),'BTC price alert');
  assert.match(await page.locator('#wa-banner-body').innerText(),/US\$101/);
  await page.locator('#wa-banner-dismiss').click();
  await page.evaluate(({message,site})=>window.__alertListeners.message({source:{scriptURL:site+'sw.js'},data:message}),{message:foreground,site:SITE});
  assert.equal(await page.locator('#wtct-alert-banner').isVisible(),false,'a retried push must not repeat its foreground banner');
  await page.evaluate(message=>window.__alertListeners.message({source:{scriptURL:'https://jfaread.github.io/another-project/sw.js'},data:{...message,eventId:'qa-foreign'}}),foreground);
  assert.equal(await page.locator('#wtct-alert-banner').isVisible(),false,'a sibling project cannot raise this alert banner');
  await page.locator('#wtct-alerts-open').click();await page.waitForFunction(()=>document.getElementById('wtct-alerts-dialog').getAttribute('aria-busy')==='false');
  await page.locator('#wa-disconnect').click();await page.waitForFunction(()=>document.getElementById('wtct-alerts-dialog').getAttribute('aria-busy')==='false');
  assert(registered);assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).auth.token,KEY),TOKEN);assert.equal(await page.evaluate(()=>window.__alertProbe.unsubscribes),0);
  await page.locator('#wa-disconnect').click();await page.getByText(/disconnected from the monitor and its browser subscription was removed/).waitFor();
  assert(!registered);assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).auth,KEY),null);assert.equal(await page.evaluate(()=>window.__alertProbe.unsubscribes),1);
  assert.equal(await page.locator('#wa-draft-rules .wa-rule').count(),1);
  assert(records.some(x=>x.path==='/v1/rules'&&x.method==='PUT'));
  await context.close();
  console.log('PASS: two-step permission, device registration, remote save, unavailable-token draft, revision conflict, test request, foreground banner, duplicate suppression, failed opt-out recovery and successful deletion. All messaging is mocked.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
