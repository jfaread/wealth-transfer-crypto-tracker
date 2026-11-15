/**
 * Staged REST adapter for secure native APNs pairing. This is not yet wired to
 * the production Cloudflare Worker. Only a validated, authenticated browser
 * device can issue a code; the installed iPhone redeems it over HTTPS.
 */
const SITE_ORIGIN='https://jfaread.github.io', MAX_BYTES=4096;
const json=(body,status=200)=>new Response(JSON.stringify(body),{
 status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
   'X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':SITE_ORIGIN,'Vary':'Origin'}
});
const failure=(status,code,message)=>json({error:{code,message}},status);
async function boundedBody(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||''))throw {status:415};
 if(Number(request.headers.get('Content-Length')||0)>MAX_BYTES)throw {status:413};
 const reader=request.body?.getReader();
 if(!reader)throw {status:400};
 const parts=[];let size=0;
 try {
  for(;;){const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;
   if(size>MAX_BYTES){try{await reader.cancel();}catch{}throw {status:413};}
   parts.push(value);
  }
 }finally{try{reader.releaseLock();}catch{}}
 const text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(parts.flatMap(x=>[...x])));
 let value;
 try{value=JSON.parse(text);}catch{throw {status:400};}
 if(!value||typeof value!=='object'||Array.isArray(value))throw {status:400};
 return value;
}
export async function handleNativeRegistration(request,{
 registry,authenticateWebOwner,enabled=false,
}={}){
 let url;try{url=new URL(request.url);}catch{return null;}
 if(!url.pathname.startsWith('/v1/native/'))return null;
 if(!enabled)return failure(503,'native_disabled','Native alert registration is not yet enabled.');
 if(!registry||typeof authenticateWebOwner!=='function')return failure(503,'native_unavailable','Native registration is unavailable.');
 if(url.search)return failure(400,'unsupported','Native registration does not accept URL query values.');
 if(request.method==='OPTIONS'){
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':SITE_ORIGIN,
   'Access-Control-Allow-Headers':'Content-Type, Authorization',
   'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Vary':'Origin'}});
 }
 const origin=request.headers.get('Origin');
 const webPair=request.method==='POST'&&url.pathname==='/v1/native/pairings';
 if(webPair){
  if(origin!==SITE_ORIGIN)return failure(403,'origin_required','Use your connected Crypto-Watch website to request a pairing code.');
 }else if(origin){
  // Native URLSession does not need CORS. Reject browser-origin token writes.
  return failure(403,'native_only','This operation must be performed by the installed native app.');
 }
 try{
  if(webPair){
   const ownerId=await authenticateWebOwner(request);
   const result=await registry.createPairing(ownerId);
   return json(result,201);
  }
  if(url.pathname==='/v1/native/complete'&&request.method==='POST'){
   const body=await boundedBody(request);
   if(Object.keys(body).some(x=>!['pairingCode','apnsToken','environment'].includes(x)))throw {status:400};
   const result=await registry.redeemPairing(body);
   return json(result,201);
  }
  const nativeDevice=url.pathname==='/v1/native/device';
  if(nativeDevice&&['GET','PUT','DELETE'].includes(request.method)){
   const authorization=request.headers.get('Authorization')||'';
   const match=/^Bearer ([0-9a-f-]{36}\.[0-9a-f]{64})$/i.exec(authorization);
   if(!match)return failure(401,'native_unauthorised','Native device credentials are unavailable.');
   if(request.method==='GET')return json(await registry.publicStatus(match[1]));
   if(request.method==='DELETE')return json(await registry.revoke(match[1]));
   const body=await boundedBody(request);
   if(Object.keys(body).length!==1||typeof body.apnsToken!=='string')throw {status:400};
   return json(await registry.refresh(match[1],body.apnsToken));
  }
  return failure(404,'not_found','Native operation not found.');
 }catch(e){
  if(e?.status===415)return failure(415,'json_required','A JSON body is required.');
  if(e?.status===413)return failure(413,'request_too_large','The native request is too large.');
  if(e?.status===400)return failure(400,'invalid_request','Invalid native registration request.');
  // Never expose a bearer, device token, code, internal storage or APNs secret.
  if(/not authorised|not authorized/i.test(e?.message||''))return failure(401,'not_authorised','Device not authorised.');
  if(/expired|pairing code/i.test(e?.message||''))return failure(410,'expired_pairing','Pairing code invalid or expired.');
  if(/limit/i.test(e?.message||''))return failure(429,'native_limit','Native pairing limit reached.');
  if(/Invalid APNs device token|environment/i.test(e?.message||''))return failure(400,'invalid_device','The native device registration could not be accepted.');
  return failure(503,'native_unavailable','Native registration is temporarily unavailable.');
 }
}
