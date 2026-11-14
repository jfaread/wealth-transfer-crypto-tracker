// Shared, strictly timestamped public USD data. No synthetic observations.
export const COINS=Object.freeze({BTC:'bitcoin',ETH:'ethereum',BNB:'binancecoin',XRP:'ripple',SOL:'solana',SHIB:'shiba-inu',KISHU:'kishu-inu',WKC:'wiki-cat',CREPE:'crepe-2'});
export const HOUR=3600000;
export function validPrices(prices,now=Date.now()){
 if(!Array.isArray(prices)||prices.length<2||prices.length>5000)throw Error('Missing historical observations');
 let previous=0;
 for(const p of prices){if(!Array.isArray(p)||p.length!==2||!Number.isSafeInteger(p[0])||p[0]<=previous||p[0]>now+300000||!Number.isFinite(p[1])||p[1]<=0)throw Error('Invalid historical observation');previous=p[0];}
 return prices;
}
export function validQuote(q,now=Date.now()){
 const t=q?.last_updated_at*1000;
 return typeof q?.usd==='number'&&Number.isFinite(q.usd)&&q.usd>0&&Number.isSafeInteger(t)&&t>0&&t<=now+300000&&now-t<=1800000;
}
export function mergeQuotes(previous,incoming,now=Date.now()){
 const quotes={};
 for(const id of Object.values(COINS)){
  const a=previous?.[id],b=incoming?.[id];
  // The provider timestamp, not the time we saved the file, determines freshness.
  if(validQuote(a,now))quotes[id]={usd:a.usd,last_updated_at:a.last_updated_at};
  if(validQuote(b,now)&&(!quotes[id]||b.last_updated_at>quotes[id].last_updated_at))quotes[id]={usd:b.usd,last_updated_at:b.last_updated_at};
 }
 return quotes;
}
export function reusableWindow(item,days,now=Date.now()){
 try{
  validPrices(item?.prices?.[days],now);
  const checked=item.windowUpdatedAt?.[days]??item.updatedAt;
  const ttl=days===31?30*60000:12*HOUR;
  return Number.isFinite(checked)&&checked>0&&checked<=now+300000&&now-checked<ttl&&now-item.prices[days].at(-1)[0]<(days===31?2*HOUR:36*HOUR);
 }catch{return false;}
}
export function acceptWindow(item,days,prices,now=Date.now()){
 validPrices(prices,now);
 if(now-prices.at(-1)[0]>(days===31?2*HOUR:36*HOUR))throw Error('Provider returned stale history');
 const old=item.prices?.[days];
 if(old?.length&&prices.at(-1)[0]<old.at(-1)[0])throw Error('Provider response would replace newer observations');
 const windowUpdatedAt={31:item.windowUpdatedAt?.[31]??item.updatedAt,365:item.windowUpdatedAt?.[365]??item.updatedAt,[days]:now};
 // Retain only genuine older observations needed at the rolling window edge.
 const prefix=Array.isArray(old)?old.filter(p=>p[0]<prices[0][0]&&p[0]>=now-(days+2)*24*HOUR):[];
 const merged=[...prefix,...prices];validPrices(merged,now);
 return {...item,prices:{...item.prices,[days]:merged},windowUpdatedAt,updatedAt:windowUpdatedAt[31]};
}
export function retryAt(value,now){
 if(!value)return now+60000;
 const n=Number(value),delay=Number.isFinite(n)?n*1000:Date.parse(value)-now;
 return now+Math.max(60000,Number.isFinite(delay)?delay:60000);
}
export function createClient({fetchImpl=fetch,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),spacing=15000}={}){
 let last=-Infinity,cooldown=0;
 return async function get(url){
  if(new URL(url).origin!=='https://api.coingecko.com')throw Error('Unexpected provider');
  for(let attempt=0;attempt<2;attempt++){
   if(now()<cooldown){const e=Error('Provider cooldown is active');e.status=429;e.retryAt=cooldown;throw e;}
   await sleep(Math.max(0,spacing-(now()-last)));last=now();
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
   try{
    const r=await fetchImpl(url,{headers:{Accept:'application/json'},redirect:'error',signal:controller.signal});
    if(r.status===429||(r.status===503&&r.headers.get('Retry-After'))){cooldown=retryAt(r.headers.get('Retry-After'),now());await r.body?.cancel();const e=Error('Provider requested a cooldown');e.status=r.status;e.retryAt=cooldown;throw e;}
    if(!r.ok){await r.body?.cancel();const e=Error('Provider returned HTTP '+r.status);e.status=r.status;throw e;}
    if(!/application\/(?:[\w.+-]+\+)?json/i.test(r.headers.get('Content-Type')||''))throw Error('Unexpected response type');
    const reader=r.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
    try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2000000){controller.abort();await reader.cancel();throw Error('Response too large');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
    return JSON.parse(text);
   }catch(e){if(attempt===1||e.retryAt||e.status&&e.status<500)throw e;}
   finally{clearTimeout(timer);}
  }
 };
}
