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
// Only public provider timing metadata is persisted. No credentials or prices.
export function providerState(value={}){
 const state={version:1,lastRequestAt:0,cooldownUntil:0,failures:0};
 if(value.version!==undefined&&value.version!==1)throw Error('Unsupported provider state');
 for(const key of ['lastRequestAt','cooldownUntil','failures']){
  const n=value[key]??0;
  if(!Number.isSafeInteger(n)||n<0||n>(key==='failures'?16:8640000000000000))throw Error('Invalid provider state');
  state[key]=n;
 }
 return state;
}
export function retryAt(value,now){
 const n=typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value.trim())?Number(value):NaN;
 const target=Number.isFinite(n)?now+Math.ceil(n*1000):Date.parse(value||'');
 // Invalid headers never remove the minimum pause. Long valid pauses are not shortened.
 return Math.max(now+60000,Number.isSafeInteger(target)&&target<=8640000000000000?target:now+60000);
}
function error(message,properties={}){return Object.assign(new Error(message),properties);}
function cancel(response,reader){try{Promise.resolve(reader?reader.cancel():response?.body?.cancel()).catch(()=>{});}catch{}}
async function request(url,{fetchImpl,timeoutMs,maxBytes}){
 const controller=new AbortController();let response,reader,timer,expired=false;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;controller.abort();cancel(response,reader);reject(error('Provider request timed out',{transient:true}));},timeoutMs);});
 const work=(async()=>{
  response=await fetchImpl(url,{headers:{Accept:'application/json'},redirect:'error',signal:controller.signal});
  if(expired){cancel(response);throw error('Provider request timed out',{transient:true});}
  if(response.redirected||response.status>=300&&response.status<400)throw error('Provider redirect rejected');
  if(!response.ok){
   const retryAfter=response.headers?.get('Retry-After');
   throw error('Provider returned HTTP '+response.status,{status:response.status,transient:response.status>=500||response.status===408,
    ...(response.status===429||response.status===503&&retryAfter?{rateLimited:true,retryAfter}:{} )});
  }
  if(!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('Content-Type')||''))throw error('Unexpected response type');
  const declared=Number(response.headers.get('Content-Length'));
  if(Number.isFinite(declared)&&declared>maxBytes)throw error('Response too large');
  if(!response.body?.getReader)throw error('Missing provider response');
  reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
  try{
   for(;;){const part=await reader.read();if(expired)throw error('Provider request timed out',{transient:true});if(part.done)break;
    bytes+=part.value.byteLength;if(bytes>maxBytes)throw error('Response too large');text+=decoder.decode(part.value,{stream:true});}
   text+=decoder.decode();
  }catch(e){if(e.transient||e.message==='Response too large')throw e;throw error('Unreadable provider response');}
  let packet;try{packet=JSON.parse(text);}catch{throw error('Invalid provider JSON');}
  if(!packet||typeof packet!=='object'||Array.isArray(packet)||Object.hasOwn(packet,'error'))throw error('Unexpected provider payload');
  return packet;
 })();
 try{return await Promise.race([work,deadline]);}
 catch(e){controller.abort();cancel(response,reader);if(e instanceof TypeError)throw error('Provider network failure',{transient:true});throw e;}
 finally{clearTimeout(timer);try{reader?.releaseLock();}catch{}}
}
export function createClient({fetchImpl=fetch,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),spacing=15000,
 timeoutMs=15000,maxBytes=2000000,state={},saveState=async()=>{}}={}){
 if(!Number.isFinite(spacing)||spacing<0||!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('Invalid provider request limits');
 let current=providerState(state),queue=Promise.resolve();
 const save=async next=>{await saveState({...next});current=next;};
 async function run(input){
  const url=new URL(input);
  if(url.origin!=='https://api.coingecko.com'||url.username||url.password||url.hash)throw Error('Unexpected provider');
  for(let attempt=0;attempt<2;attempt++){
   if(now()<current.cooldownUntil)throw error('Provider cooldown is active',{status:429,retryAt:current.cooldownUntil});
   const wait=Math.max(0,current.lastRequestAt?spacing-(now()-current.lastRequestAt):0);
   if(wait>60000)throw error('Clock moved backwards; provider requests paused',{retryAt:current.lastRequestAt+spacing});
   await sleep(wait);
   // Persist the reservation BEFORE sending. Failed storage cannot bypass throttling.
   await save({...current,lastRequestAt:now()});
   let packet;
   try{packet=await request(url.href,{fetchImpl,timeoutMs,maxBytes});}
   catch(e){
    if(e.rateLimited){const until=retryAt(e.retryAfter,now());await save({...current,cooldownUntil:Math.max(current.cooldownUntil,until)});
     throw error('Provider requested a cooldown',{status:e.status,retryAt:current.cooldownUntil});}
    if(!e.transient)throw e;
    const failures=Math.min(16,current.failures+1),cooldownUntil=failures>=3?now()+Math.min(15*60000,60000*2**Math.min(4,failures-3)):current.cooldownUntil;
    await save({...current,failures,cooldownUntil});
    if(cooldownUntil>now())throw error('Provider temporarily unavailable; requests paused',{retryAt:cooldownUntil});
    if(attempt===1)throw e;
    continue;
   }
   await save({...current,failures:0,cooldownUntil:0});return packet;
  }
 }
 // Parallel callers share one request lane, spacing and circuit-breaker state.
 return input=>{const result=queue.then(()=>run(input));queue=result.catch(()=>{});return result;};
}
