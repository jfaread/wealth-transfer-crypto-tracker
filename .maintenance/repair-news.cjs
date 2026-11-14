'use strict';
const fs=require('node:fs');
const cp=require('node:child_process');
const expected={'index.html':'c12054a261a0a5b070250c87d9c31a03b29429d2','assets/alerts.js':'46ad95df99264a446ea1877c4e32e8ad3d49c66f','.github/workflows/market-data.yml':'a3094c8b5d97c8a27da52991c615f85f5c061c8e'};
for(const [f,sha] of Object.entries(expected))if(cp.execFileSync('git',['hash-object',f],{encoding:'utf8'}).trim()!==sha)throw Error('Source changed: '+f);
function edit(file,from,to){const text=fs.readFileSync(file,'utf8');if(text.split(from).length!==2)throw Error('Ambiguous edit in '+file+': '+from.slice(0,90));fs.writeFileSync(file,text.replace(from,to));}
edit('index.html','maxAge:30*86400000','maxAge:Infinity');
edit('index.html','newsSavedAt=0,newsController=null;','newsSavedAt=0,newsController=null,jonCheckedAt=0,jonCached=true;');
edit('index.html',' return items.slice(0,200).flatMap(item=>{try{',' const valid=items.slice(0,200).flatMap(item=>{try{');
edit('index.html','  if(feed.name===','  if(!feed)return[];\n  if(feed.name===');
edit('index.html',"const key=url.href,titleKey=title.toLowerCase();","const key=url.href,titleKey=feed.name+'|'+title.toLowerCase();");
edit('index.html','!Number.isFinite(t)||t>now+300000','!Number.isFinite(t)||t<=0||t>now+300000');
edit('index.html'," }catch(_){return[];}}).sort((a,b)=>b.publishedAt-a.publishedAt).slice(0,30);",` }catch(_){return[];}}).sort((a,b)=>b.publishedAt-a.publishedAt);
 return [...valid.filter(n=>n.source!=='Jon George / MyDefiGuru').slice(0,30),...valid.filter(n=>n.source==='Jon George / MyDefiGuru').slice(0,5)].sort((a,b)=>b.publishedAt-a.publishedAt);`);
edit('index.html','function syncNewsMotion(){',`// Resolve only a known feed's canonical publisher link; never follow a redirect.
function feedItems(feed,packet){
 if(packet?.status!=='ok'||packet.feed?.url!==feed.url||!Array.isArray(packet.items))throw Error('Feed identity unavailable');
 return packet.items.slice(0,100).flatMap(item=>{
  if(!item||typeof item!=='object')return[];
  let canonical=null;
  for(const candidate of [item.link,item.guid]){try{const u=new URL(candidate);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&feed.hosts.includes(u.hostname)){canonical=u.href;break;}}catch(_){}}
  if(feed.name==='Jon George / MyDefiGuru'){
   const match=typeof item.guid==='string'&&item.guid.match(/^yt:video:([A-Za-z0-9_-]{11})$/);
   if(match){if(canonical){const u=new URL(canonical);if(u.pathname!=='/watch'||u.searchParams.get('v')!==match[1])return[];}canonical='https://www.youtube.com/watch?v='+match[1];}
  }
  return canonical?[{...item,link:canonical}]:[];
 });
}
async function restoreJonSnapshot(signal){
 const value=await requestJSON(new URL('./data/jon-george.json',location.href).href,signal,4000);
 const checkedAt=Date.parse(value?.checkedAt||'');
 if(value?.version!==1||value.channelId!=='UCXJQosNTxvmyd925enPbQPw'||value.sourceUrl!==FEEDS[2].url||!Number.isFinite(checkedAt)||checkedAt<=0||checkedAt>Date.now()+300000||!Array.isArray(value.items)||value.items.length>5)return;
 const items=cleanNews(value.items).filter(n=>n.source==='Jon George / MyDefiGuru');
 if(!items.length||signal.aborted)return;
 newsItems=cleanNews([...newsItems,...items]);
 if(checkedAt>jonCheckedAt){jonCheckedAt=checkedAt;jonCached=true;}
 renderNews();
}
function syncNewsMotion(){`);
edit('index.html',"const jonItems=newsItems.filter(n=>n.source==='Jon George / MyDefiGuru');", "const jonItems=newsItems.filter(n=>n.source==='Jon George / MyDefiGuru').slice(0,5);");
edit('index.html',"jonItems.length+' public video updates available. Creator commentary; separate from market reporting.'", "'Latest '+jonItems.length+' public video updates'+(jonCheckedAt?' · '+(jonCached?'saved feed checked ':'feed checked ')+dateText(jonCheckedAt)+' '+zoneLabel():'')+'. Creator commentary; separate from market reporting.'");
edit('index.html',"$('wtct-ticker').classList.toggle('empty',!newsItems.length);", "$('wtct-ticker').classList.toggle('empty',!newsItems.some(n=>n.source!=='Jon George / MyDefiGuru'));");
edit('index.html'," if(!newsItems.length){track.textContent=", " if(!newsItems.some(n=>n.source!=='Jon George / MyDefiGuru')){track.textContent=");
edit('index.html'," const failures=[];let items=[];\n try{", " const failures=[];let items=[];\n const snapshot=restoreJonSnapshot(signal).catch(()=>{});\n try{");
edit('index.html',"if(j?.status!=='ok'||!Array.isArray(j.items))throw Error('Feed unavailable');return j.items;", "return feedItems(f,j);");
edit('index.html',"   items=cleanNews(results.flatMap((r,i)=>{if(r.status==='fulfilled')return r.value;failures.push(FEEDS[i].name+' unavailable');return[];}));", `   items=cleanNews(results.flatMap((r,i)=>{if(r.status==='fulfilled')return r.value;failures.push(FEEDS[i].name+' unavailable');return[];}));
   const jon=cleanNews(results[2].status==='fulfilled'?results[2].value:[]).filter(n=>n.source==='Jon George / MyDefiGuru');
   jonCached=!jon.length;if(jon.length)jonCheckedAt=Date.now();`);
edit('index.html',"  if(signal.aborted)return;\n  if(items.length){newsItems=items;", "  await snapshot;\n  if(signal.aborted)return;\n  if(items.length){newsItems=cleanNews([...items,...newsItems]);");
edit('index.html',"storageWrite('news',{items:newsItems,savedAt:newsSavedAt});", "storageWrite('news',{items:newsItems,savedAt:newsSavedAt,jonCheckedAt});");
edit('index.html',"newsSavedAt=storedNews.savedAt;if(newsItems.length)", "newsSavedAt=storedNews.savedAt;jonCheckedAt=Number.isFinite(storedNews.jonCheckedAt)&&storedNews.jonCheckedAt>0&&storedNews.jonCheckedAt<=Date.now()+300000?storedNews.jonCheckedAt:0;if(newsItems.length)");
edit('index.html','    <p id="wa-consent"',`    <p id="wa-test-help" class="wa-small" hidden>Request test alert sends a phone notification titled “Crypto-Watch test”. It does not open a separate message, SMS or WhatsApp conversation. Tapping the notification returns to Crypto-Watch. While this page is open, received notification text also appears below. Check Notification Centre and this app’s notification settings if no banner appears.</p>
    <section id="wa-received" class="wa-status" role="status" aria-live="polite" hidden><strong id="wa-received-title"></strong><p id="wa-received-body"></p><small id="wa-received-time"></small></section>
    <p id="wa-consent"`);
edit('assets/alerts.js',"    if (!banner || !pageAlert || banner.hidden) return;", "    if (!pageAlert) return;");
edit('assets/alerts.js',"    if (expired) pageAlert.expired = true;", `    if (expired) pageAlert.expired = true;
    const received = $('wa-received');
    if (received) {
      received.hidden = false;
      $('wa-received-title').textContent = expired ? 'Earlier notification - expired' : pageAlert.title;
      $('wa-received-body').textContent = expired ? 'This notification is no longer current. Check the latest prices before acting.' : pageAlert.body;
      $('wa-received-time').textContent = 'Received in this browser · ' + time(pageAlert.observedAt) + '. This does not confirm a lock-screen banner was displayed.';
    }
    if (!banner) return;`);
edit('assets/alerts.js',"    $('wa-test').hidden = !connected;", "    $('wa-test').hidden = !connected;\n    if ($('wa-test-help')) $('wa-test-help').hidden = !connected;");
edit('assets/alerts.js',"notice('Test notification requested. Check this device’s notifications; this request does not guarantee it will be displayed.');", "notice('Test notification requested. Look for “Crypto-Watch test” in this device’s notifications or Notification Centre. No separate message window opens. The request alone does not confirm delivery.');\n    $('wa-message').scrollIntoView({block:'nearest'});");
edit('scripts/test-alerts-browser.cjs',"  await page.locator('#wa-close').click();\n  const foreground=",`  assert.match(await page.locator('#wa-test-help').innerText(),/does not open a separate message/);
  assert.equal(await page.locator('#wa-received').isVisible(),false,'requesting a test is not a receipt');
  const testPush={type:'wtct-price-alert',version:1,eventId:'qa-test-received',title:'Crypto-Watch test',body:'Phone alerts are connected to this browser.',url:SITE,observedAt:Date.now(),expiresAt:Date.now()+120000,expired:false};
  await page.evaluate(({message,site})=>window.__alertListeners.message({source:{scriptURL:site+'sw.js'},data:message}),{message:testPush,site:SITE});
  assert.equal(await page.locator('#wa-received').isVisible(),true);
  assert.equal(await page.locator('#wa-received-title').innerText(),'Crypto-Watch test');
  assert.match(await page.locator('#wa-received-body').innerText(),/Phone alerts are connected/);
  assert.match(await page.locator('#wa-received-time').innerText(),/does not confirm a lock-screen banner/);
  await page.locator('#wa-close').click();
  const foreground=`);
edit('.github/workflows/market-data.yml',"      - 'scripts/refresh-quotes.mjs'", "      - 'scripts/refresh-quotes.mjs'\n      - 'scripts/refresh-creator-updates.mjs'\n      - 'data/jon-george.json'");
edit('.github/workflows/market-data.yml',"      - name: Commit verified public prices", "      - name: Cache the latest five public Jon George updates\n        run: node scripts/refresh-creator-updates.mjs\n      - name: Commit verified public prices");
fs.renameSync('.maintenance/news.test.mjs','tests/news.test.mjs');
fs.renameSync('.maintenance/test-news-browser.cjs','scripts/test-news-browser.cjs');
console.log('Guarded news and notification-clarity repair applied; no alert-backend or market-feed changes.');
