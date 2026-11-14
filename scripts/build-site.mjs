import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
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
 const policy="default-src 'none'; script-src 'self' "+hashes.join(' ')+"; style-src 'self' 'unsafe-inline'; connect-src 'self' https://data-api.binance.vision https://api.rss2json.com https://api.coingecko.com"+(origin?' '+origin:'')+"; img-src 'self' data:; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'";
 if(!/<meta http-equiv="Content-Security-Policy"/.test(html))throw Error('Missing site content security policy');
 return html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*("\s*\/?>)/,(_,a,b)=>a+policy+b);
}
const DAY=86400000,HOUR=3600000;
function subtractMonths(t,n){const d=new Date(t),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-n);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return+d;}
export function buildSnapshot(items,manifest,now=Date.now()){
 if(!Number.isFinite(manifest.updatedAt)||manifest.updatedAt>now+300000||now-manifest.updatedAt>2*DAY)throw Error('Missing or stale snapshot timestamp');
 for(const id of COIN_IDS){const item=items[id];if(!item||item.symbol!==id)throw Error('Missing '+id);for(const key of ['31','365']){const a=item.prices?.[key];if(!Array.isArray(a)||a.length<2||a.length>5000)throw Error('Missing '+id+' history');let previous=0;for(const p of a){if(!Array.isArray(p)||p.length!==2||!Number.isSafeInteger(p[0])||p[0]<=previous||!Number.isFinite(p[1])||p[1]<=0)throw Error('Invalid '+id+' history');previous=p[0];}}}
 const end=Math.max(...Object.values(items).flatMap(x=>['31','365'].map(k=>x.prices[k].at(-1)[0])));
 if(end>now+300000||now-end>2*DAY)throw Error('Invalid snapshot observation time');
 const ranges={};
 for(const range of ['1D','5D','1M','6M','YTD','1Y']){
  const step=['1D','5D','1M'].includes(range)?HOUR:DAY;
  let start=range==='1D'?end-DAY:range==='5D'?end-5*DAY:range==='1M'?subtractMonths(end,1):range==='6M'?subtractMonths(end,6):range==='1Y'?subtractMonths(end,12):Date.UTC(new Date(end).getUTCFullYear(),0,1);
  start=Math.floor(start/step)*step;
  const spec={range,start,end,step,interval:step===HOUR?'approximately hourly':'approximately daily',source:'CoinGecko live',currency:'USD',saved:false,sourceUpdatedAt:manifest.updatedAt};
  const data=[];
  for(const id of COIN_IDS){const a=items[id].prices[step===HOUR?'31':'365'];const first=a.find(p=>p[0]>=start),last=a.filter(p=>p[0]<=end).at(-1);if(!first||first[0]-start>step||!last||end-last[0]>step)continue;
   const base=first[1],points=[{t:start,p:base,r:0}];if(first[0]>start)points.push({t:first[0],p:base,r:0});let gaps=0;
   for(const [t,p] of a){if(t<=first[0]||t>end)continue;const gapBefore=t-points.at(-1).t>step*1.5;if(gapBefore)gaps++;points.push({t,p,r:(p/base-1)*100,...(gapBefore?{gapBefore:true}:{})});}
   data.push([id,{id,base,points,gaps,asOf:manifest.updatedAt}]);
  }
  ranges[range]={spec,data,savedAt:manifest.updatedAt};
 }
 return{version:1,updatedAt:manifest.updatedAt,asOf:end,ranges};
}
export async function buildSite(){
 const manifest=JSON.parse(await readFile('data/manifest.json','utf8')),items={};for(const id of COIN_IDS)items[id]=JSON.parse(await readFile('data/'+id+'.json','utf8'));
 const snapshot=buildSnapshot(items,manifest);let html=await readFile('index.html','utf8');
 const alertConfig=JSON.parse(await readFile('alerts-config.json','utf8'));
 const bootstrap={version:1,initial:{range:'1D',coins:COIN_IDS,view:'performance'},ranges:{'1D':snapshot.ranges['1D']}};
 html=html.replace(/(<script id="wtct-bootstrap" type="application\/json">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+JSON.stringify(bootstrap).replace(/</g,'\\u003c')+b);
 html=applySiteCsp(html,alertConfig);
 await mkdir('_site/data',{recursive:true});await writeFile('_site/index.html',html);await cp('data','_site/data',{recursive:true});await writeFile('_site/data/ranges.json',JSON.stringify(snapshot));
 for(const file of STATIC_FILES)await cp(file,'_site/'+file,{recursive:true});
 console.log('Built immediate one-day chart for '+snapshot.ranges['1D'].data.length+' coins; six periods in one '+JSON.stringify(snapshot).length+'-byte snapshot.');return snapshot;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await buildSite();
