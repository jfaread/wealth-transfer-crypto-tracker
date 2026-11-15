import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {COINS,validPrices,validQuote} from './market-data-core.mjs';
export const COIN_IDS=['BTC','ETH','BNB','XRP','SOL','SHIB','KISHU','WKC','CREPE'];
const STATIC_FILES=['assets','icons','manifest.webmanifest','sw.js','alerts-config.json','.nojekyll'];
export function alertApiOrigin(config){
 if(!config||config.version!==1)throw Error('Invalid alert configuration');
 if(config.apiBase===null)return null;
 if(typeof config.apiBase!=='string')throw Error('Invalid alert API address');
 const u=new URL(config.apiBase);
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!/^crypto-watch-alerts\.[a-z0-9-]+\.workers\.dev$/.test(u.hostname)||u.pathname!=='/')throw Error('Use the dedicated Crypto-Watch Workers HTTPS origin');
 return u.origin;
}
export function applySiteCsp(html,config){
 const origin=alertApiOrigin(config);
 const hashes=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(([,attrs])=>!(/\bsrc\s*=/.test(attrs)||/type\s*=\s*["']application\/json["']/.test(attrs))).map(([, ,source])=>"'sha256-"+createHash('sha256').update(source).digest('base64')+"'");
 const policy="default-src 'none'; script-src 'self' "+hashes.join(' ')+"; style-src 'self' 'unsafe-inline'; connect-src 'self' https://data-api.binance.vision https://api.rss2json.com https://api.coingecko.com"+(origin?' '+origin:'')+"; img-src 'self' data:; media-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'";
 if(!/<meta http-equiv="Content-Security-Policy"/.test(html))throw Error('Missing site content security policy');
 return html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*("\s*\/?>)/,(_,a,b)=>a+policy+b);
}
const DAY=86400000,HOUR=3600000;
function subtractMonths(t,n){const d=new Date(t),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-n);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return+d;}
export function buildSnapshot(items,manifest,now=Date.now()){
 if(!Number.isFinite(manifest.updatedAt)||manifest.updatedAt>now+300000||now-manifest.updatedAt>2*DAY)throw Error('Missing or stale snapshot timestamp');
 if(manifest.source!=='CoinGecko aggregate USD'||JSON.stringify(manifest.coins)!==JSON.stringify(COIN_IDS))throw Error('Unexpected snapshot identity');
 for(const id of COIN_IDS){const item=items[id];if(!item||item.symbol!==id||item.id!==COINS[id])throw Error('Wrong or missing token '+id);
  for(const key of [31,365]){validPrices(item.prices?.[key],now);const checked=item.windowUpdatedAt?.[key]??item.updatedAt;
   if(!Number.isSafeInteger(checked)||checked<=0||checked>now+300000)throw Error('Invalid history check time for '+id);}}
 const ranges={};
 for(const range of ['1D','5D','1M','6M','YTD','1Y']){
  const step=['1D','5D','1M'].includes(range)?HOUR:DAY,key=step===HOUR?31:365;
  const tails=COIN_IDS.map(id=>items[id].prices[key].at(-1)[0]),oldest=Math.min(...tails),newest=Math.max(...tails);
  const end=newest-oldest<=step?newest:oldest;
  if(end>now+300000||now-end>2*DAY)throw Error('Invalid '+range+' observation time');
  const historyCheckedAt=Math.min(...COIN_IDS.map(id=>items[id].windowUpdatedAt?.[key]??items[id].updatedAt));
  let start=range==='1D'?end-DAY:range==='5D'?end-5*DAY:range==='1M'?subtractMonths(end,1):range==='6M'?subtractMonths(end,6):range==='1Y'?subtractMonths(end,12):Date.UTC(new Date(end).getUTCFullYear(),0,1);
  start=Math.floor(start/step)*step;
  const spec={range,start,end,step,interval:step===HOUR?'approximately hourly':'approximately daily',source:'CoinGecko live',currency:'USD',saved:false,sourceUpdatedAt:historyCheckedAt};
  const data=[];
  for(const id of COIN_IDS){const a=items[id].prices[step===HOUR?'31':'365'];const first=a.find(p=>p[0]>=start),last=a.filter(p=>p[0]<=end).at(-1);if(!first||first[0]-start>step||!last||end-last[0]>step)continue;
   const base=first[1],points=[{t:start,p:base,r:0}];if(first[0]>start)points.push({t:first[0],p:base,r:0});let gaps=0;
   for(const [t,p] of a){if(t<=first[0]||t>end)continue;const gapBefore=t-points.at(-1).t>step*1.5;if(gapBefore)gaps++;points.push({t,p,r:(p/base-1)*100,...(gapBefore?{gapBefore:true}:{})});}
   data.push([id,{id,base,points,gaps,asOf:manifest.updatedAt,historySavedAt:items[id].windowUpdatedAt?.[step===HOUR?31:365]??items[id].updatedAt}]);
  }
  ranges[range]={spec,data,savedAt:historyCheckedAt};
 }
 const snapshot={version:1,updatedAt:manifest.updatedAt,asOf:ranges['1D'].spec.end,ranges};
 validateSnapshot(snapshot,now);return snapshot;
}
/** The same safety gate runs on scheduled refreshes, not just code releases. */
export function validateSnapshot(snapshot,now=Date.now()){
 const required=['1D','5D','1M','6M','YTD','1Y'];
 if(snapshot?.version!==1||!Number.isSafeInteger(snapshot.updatedAt)||snapshot.updatedAt<=0||snapshot.updatedAt>now+300000||now-snapshot.updatedAt>2*DAY)throw Error('Invalid published snapshot timestamp');
 if(!snapshot.ranges||JSON.stringify(Object.keys(snapshot.ranges))!==JSON.stringify(required))throw Error('Incomplete published periods');
 for(const range of required){
  const b=snapshot.ranges[range],s=b?.spec,step=['1D','5D','1M'].includes(range)?HOUR:DAY;
  if(!s||s.range!==range||s.source!=='CoinGecko live'||s.currency!=='USD'||s.step!==step||!Number.isSafeInteger(s.start)||!Number.isSafeInteger(s.end)||s.start<=0||s.end<=s.start||s.end>now+300000||s.end-s.start>367*DAY||!Number.isSafeInteger(b.savedAt)||b.savedAt<=0||b.savedAt>now+300000)throw Error('Invalid published period '+range);
  if(!Array.isArray(b.data)||JSON.stringify(b.data.map(x=>x?.[0]))!==JSON.stringify(COIN_IDS))throw Error('A coin is missing from '+range+'; existing publication retained');
  for(const [id,d]of b.data){
   if(d?.id!==id||!Number.isFinite(d.base)||d.base<=0||!Array.isArray(d.points)||d.points.length<2||d.points.length>4001)throw Error('Invalid series '+id);
   let previous=-1,gaps=0;
   for(const point of d.points){
    const expected=(point.p/d.base-1)*100;
    if(!Number.isSafeInteger(point.t)||point.t<s.start||point.t>s.end||point.t<=previous||!Number.isFinite(point.p)||point.p<=0||!Number.isFinite(point.r)||!Number.isFinite(expected)||Math.abs(point.r-expected)>1e-7*Math.max(1,Math.abs(expected)))throw Error('Invalid observation '+id);
    if(previous>=0&&(point.gapBefore===true||point.t-previous>step*1.5))gaps++;
    previous=point.t;
   }
   if(d.points[0].t!==s.start||d.points[0].p!==d.base||d.points[0].r!==0||d.gaps!==gaps||s.end-previous>step)throw Error('Incomplete or mislabelled series '+id);
  }
 }
 if(snapshot.asOf!==snapshot.ranges['1D'].spec.end)throw Error('Inconsistent snapshot coverage');
 return true;
}
export function feedHealth(snapshot,quotes,now=Date.now()){
 validateSnapshot(snapshot,now);const series=new Map(snapshot.ranges['1D'].data);
 const coins=Object.fromEntries(COIN_IDS.map(id=>{const d=series.get(id),lastObservedAt=d.points.at(-1).t,q=quotes?.quotes?.[COINS[id]];
  return [id,{historyObservedAt:lastObservedAt,historyCheckedAt:d.historySavedAt,historyDelayed:now-lastObservedAt>2*HOUR,
   quoteObservedAt:validQuote(q,now)?q.last_updated_at*1000:null,quoteAvailable:validQuote(q,now),gaps:d.gaps}];}));
 return {version:1,checkedAt:now,source:'CoinGecko aggregate USD',status:Object.values(coins).every(c=>!c.historyDelayed&&c.quoteAvailable)?'healthy':'degraded',
  note:'Checked time is not the time of a price observation. Missing intervals are not estimated. Scheduled refresh times are not guaranteed.',coins};
}
export async function buildSite(){
 const manifest=JSON.parse(await readFile('data/manifest.json','utf8')),items={};for(const id of COIN_IDS)items[id]=JSON.parse(await readFile('data/'+id+'.json','utf8'));
 const snapshot=buildSnapshot(items,manifest);let html=await readFile('index.html','utf8');
 const alertConfig=JSON.parse(await readFile('alerts-config.json','utf8'));
 const bootstrap={version:1,initial:{range:'1D',coins:COIN_IDS,view:'performance'},ranges:{'1D':snapshot.ranges['1D']}};
 html=html.replace(/(<script id="wtct-bootstrap" type="application\/json">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+JSON.stringify(bootstrap).replace(/</g,'\\u003c')+b);
 html=applySiteCsp(html,alertConfig);
 await mkdir('_site/data',{recursive:true});await writeFile('_site/index.html',html);await cp('data','_site/data',{recursive:true});await writeFile('_site/data/ranges.json',JSON.stringify(snapshot));
 let quotes={};try{quotes=JSON.parse(await readFile('data/quotes.json','utf8'));}catch{}
 await writeFile('_site/data/feed-health.json',JSON.stringify(feedHealth(snapshot,quotes)));
 for(const file of STATIC_FILES)await cp(file,'_site/'+file,{recursive:true});
 console.log('Built immediate one-day chart for '+snapshot.ranges['1D'].data.length+' coins; six periods in one '+JSON.stringify(snapshot).length+'-byte snapshot.');return snapshot;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await buildSite();
