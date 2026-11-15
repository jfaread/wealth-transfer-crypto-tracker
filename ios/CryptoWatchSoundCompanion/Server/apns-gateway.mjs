/**
 * Native APNs sender for the isolated iOS companion.
 * No APNs credentials belong in GitHub. Imported only by a configuration-gated
 * Worker module; it never replaces the Web Push transport or its VAPID keys.
 */
const THRESHOLDS=new Set(['0.90','0.80','0.70']),enc=new TextEncoder();
function need(value,regex,name){
 if(typeof value!=='string'||!regex.test(value))throw Error('Invalid '+name);
 return value;
}
function threshold(value){
 if(typeof value!=='string')throw Error('Invalid native threshold');
 const alias={'0.9':'0.90','0.8':'0.80','0.7':'0.70'};
 const normalized=alias[value]||value;
 if(!THRESHOLDS.has(normalized))throw Error('Unsupported XRP threshold');
 return normalized;
}
function less(a,b){
 const [a0,a1='']=a.split('.'),[b0,b1='']=b.split('.');
 const n=Math.max(a1.length,b1.length);
 return BigInt(a0+a1.padEnd(n,'0'))<BigInt(b0+b1.padEnd(n,'0'));
}
export function nativeXrpNotification(event,now=Date.now()){
 if(!event||event.type!=='threshold'||event.coin!=='XRP'||event.direction!=='below')
   throw Error('Only verified XRP threshold events may produce native sound');
 const t=threshold(event.threshold);
 const price=need(event.price,/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/,'price');
 if(!less(price,t))throw Error('Price has not crossed below threshold');
 need(event.eventId,/^[a-f0-9-]{16,80}$/i,'event ID');
 if(!Number.isSafeInteger(event.observedAt)||!Number.isSafeInteger(event.expiresAt)||
 event.observedAt<=0||event.observedAt>now+30000||now-event.observedAt>300000||
 event.expiresAt<=now||event.expiresAt<event.observedAt||
 event.expiresAt-event.observedAt>300000)throw Error('Expired or future XRP observation');
 const payload={aps:{alert:{title:'XRP Alert',body:'XRP crossed below $'+t+'. Verified $'+price+'.'},
  sound:'xrp-alert.wav','thread-id':'xrp-threshold'},
  eventId:event.eventId,observedAt:event.observedAt};
 if(enc.encode(JSON.stringify(payload)).byteLength>4096)throw Error('Oversized APNs message');
 return {payload,expiresAt:event.expiresAt,eventId:event.eventId};
}
function b64url(bytes){
 let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
 return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function keyBytes(pem){
 if(typeof pem!=='string'||!/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+\/=\s]+\s+-----END PRIVATE KEY-----\s*$/.test(pem))
   throw Error('Invalid APNs private key');
 const body=pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'');
 return Uint8Array.from(atob(body),x=>x.charCodeAt(0));
}
export async function signAPNsJWT({teamId,keyId,privateKeyPEM,subtle=crypto.subtle,now=Date.now()}){
 need(teamId,/^[A-Z0-9]{10}$/,'team ID');need(keyId,/^[A-Z0-9]{10}$/,'key ID');
 const iat=Math.floor(now/1000);
 if(!Number.isSafeInteger(iat)||iat<=0)throw Error('Invalid APNs signing time');
 const header=b64url(enc.encode(JSON.stringify({alg:'ES256',kid:keyId})));
 const claim=b64url(enc.encode(JSON.stringify({iss:teamId,iat})));
 const data=enc.encode(header+'.'+claim);
 const key=await subtle.importKey('pkcs8',keyBytes(privateKeyPEM),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const signature=new Uint8Array(await subtle.sign({name:'ECDSA',hash:'SHA-256'},key,data));
 if(signature.byteLength!==64)throw Error('Unexpected APNs signature format');
 return header+'.'+claim+'.'+b64url(signature);
}
export async function sendNativeXrpAPNs({
 event,token,teamId,keyId,privateKeyPEM,bundleId,environment='production',
 fetchImpl=fetch,subtle=crypto.subtle,now=Date.now(),timeoutMs=10000
}={}){
 const prepared=nativeXrpNotification(event,now);
 need(token,/^(?:[a-fA-F0-9]{2}){32,128}$/,'APNs token');
 need(bundleId,/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/,'bundle ID');
 if(!['production','sandbox'].includes(environment))throw Error('Invalid APNs environment');
 if(typeof fetchImpl!=='function')throw Error('Invalid APNs transport');
 const jwt=await signAPNsJWT({teamId,keyId,privateKeyPEM,subtle,now});
 const host=environment==='production'?'https://api.push.apple.com':'https://api.sandbox.push.apple.com';
 const controller=new AbortController(),deadline=Math.max(1,Math.min(10000,timeoutMs));
 let timer;
 const timed=new Promise((_,reject)=>{timer=setTimeout(()=>{
  controller.abort();reject(Error('APNs deadline exceeded'));
 },deadline);});
 try{
  const response=await Promise.race([fetchImpl(host+'/3/device/'+token.toLowerCase(),{
   method:'POST',redirect:'error',signal:controller.signal,
   headers:{authorization:'bearer '+jwt,'apns-topic':bundleId,
    'apns-push-type':'alert','apns-priority':'10',
    'apns-expiration':String(Math.floor(prepared.expiresAt/1000)),
    'apns-collapse-id':prepared.eventId,'content-type':'application/json'},
   body:JSON.stringify(prepared.payload),
  }),timed]);
  if(response?.status!==200)throw Error('APNs rejected the notification');
  return {accepted:true,eventId:prepared.eventId};
 }catch(e){
  controller.abort();
  throw Error(e?.message==='APNs deadline exceeded'?e.message:'APNs delivery could not be confirmed');
 }finally{clearTimeout(timer);}
}
