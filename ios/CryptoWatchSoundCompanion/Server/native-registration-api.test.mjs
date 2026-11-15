import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {NativeRegistrationStore} from './native-registry.mjs';
import {handleNativeRegistration} from './native-registration-api.mjs';

const ORIGIN='https://jfaread.github.io';
const URL='https://crypto-watch-alerts.jfaread-crypto-watch.workers.dev';
const OWNER='12abde91-3d4f-4e2a-921d-e5589b56eb15';
const APNS='ab'.repeat(32);
class Storage{
 constructor(){this.map=new Map();}
 async get(k){return structuredClone(this.map.get(k));}
 async put(k,v){this.map.set(k,structuredClone(v));}
 async delete(k){this.map.delete(k);}
 async list({prefix}={}){return new Map([...this.map].filter(([k])=>!prefix||k.startsWith(prefix)));}
 async transaction(fn){const copy=new Storage();copy.map=new Map(this.map);const out=await fn(copy);this.map=copy.map;return out;}
}
const make=()=>{
 const storage=new Storage();
 const registry=new NativeRegistrationStore({storage,cryptoImpl:webcrypto,now:()=>Date.parse('2026-11-15T12:00:00Z'),
  ownerExists:async id=>id===OWNER,environment:'sandbox'});
 const handler=request=>handleNativeRegistration(request,{registry,enabled:true,authenticateWebOwner:async request=>{
  if(request.headers.get('Authorization')!=='Bearer known-web-device')throw Error('Device not authorised');
  return OWNER;
 }});
 return {handler,storage,registry};
};
const req=(path,method,body,headers={})=>new Request(URL+path,{method,headers:body===undefined?headers:{'Content-Type':'application/json',...headers},
 body:body===undefined?undefined:JSON.stringify(body)});
const result=async response=>({status:response.status,body:await response.json()});
test('web pairing requires authorised existing web device and exact website origin',async()=>{
 const {handler,storage}=make();
 for(const headers of [{}, {'Origin':'https://evil.example','Authorization':'Bearer known-web-device'},
 {'Origin':ORIGIN,'Authorization':'Bearer wrong'}]){
  const out=await result(await handler(req('/v1/native/pairings','POST',{},headers)));
  assert([401,403].includes(out.status));
 }
 assert.equal(storage.map.size,0,'Unauthorised requests must not create pairings');
 const paired=await result(await handler(req('/v1/native/pairings','POST',{},{
  'Origin':ORIGIN,'Authorization':'Bearer known-web-device'})));
 assert.equal(paired.status,201);
 assert.match(paired.body.pairingCode,/^[0-9a-f]{64}$/);
 assert.equal(paired.body.expiresAt,Date.parse('2026-11-15T12:05:00Z'));
});
test('native code redemption, authentication, token rotation and revocation use separate identities',async()=>{
 const {handler}=make();
 const pairing=await result(await handler(req('/v1/native/pairings','POST',{},{
  'Origin':ORIGIN,'Authorization':'Bearer known-web-device'})));
 const token=pairing.body.pairingCode;
 const activated=await result(await handler(req('/v1/native/complete','POST',{pairingCode:token,apnsToken:APNS,environment:'sandbox'})));
 assert.equal(activated.status,201);
 assert.equal(activated.body.connected,true);
 assert(!JSON.stringify(activated).includes(APNS));
 const bearer=activated.body.bearer;
 const header={Authorization:'Bearer '+bearer};
 const status=await result(await handler(req('/v1/native/device','GET',undefined,header)));
 assert.equal(status.status,200);assert.equal(status.body.connected,true);
 const refreshed=await result(await handler(req('/v1/native/device','PUT',{apnsToken:'cd'.repeat(32)},header)));
 assert.equal(refreshed.status,200);
 const removed=await result(await handler(req('/v1/native/device','DELETE',undefined,header)));
 assert.equal(removed.status,200);
 const gone=await result(await handler(req('/v1/native/device','GET',undefined,header)));
 assert.equal(gone.status,401);
});
test('browser-origin requests cannot redeem or rotate native credentials',async()=>{
 const {handler}=make();
 const code=(await result(await handler(req('/v1/native/pairings','POST',{},{
  Origin:ORIGIN,Authorization:'Bearer known-web-device'})))).body.pairingCode;
 const attempted=await result(await handler(req('/v1/native/complete','POST',{
  pairingCode:code,apnsToken:APNS,environment:'sandbox'}, {Origin:ORIGIN})));
 assert.equal(attempted.status,403);
 const accepted=await result(await handler(req('/v1/native/complete','POST',{
  pairingCode:code,apnsToken:APNS,environment:'sandbox'})));
 assert.equal(accepted.status,201);
});
test('native operations fail closed until explicitly enabled',async()=>{
 const {handler,storage,registry}=make();
 const response=await handleNativeRegistration(req('/v1/native/pairings','POST',{},{
  Origin:ORIGIN,Authorization:'Bearer known-web-device'}),{registry,authenticateWebOwner:async()=>OWNER,enabled:false});
 assert.equal(response.status,503);assert.equal(storage.map.size,0);
 assert.equal(await handler(req('/v1/device','GET')),null,'Original web API remains separate');
});
test('oversized, malformed and wrong-origin native requests reveal no secrets',async()=>{
 const {handler}=make();
 const cases=[
  req('/v1/native/complete','POST',{apnsToken:APNS,environment:'sandbox',pairingCode:'a'.repeat(5000)}),
  req('/v1/native/complete','POST',{pairingCode:'a'.repeat(64),apnsToken:'bad',environment:'sandbox'}),
  req('/v1/native/device','GET',undefined,{Authorization:'Bearer something'}),
 ];
 for(const request of cases){
  const response=await handler(request),body=await response.text();
  assert(response.status>=400);
  assert(!body.includes(APNS));assert(!body.includes('privateKey'));assert(!body.includes('Bearer'));
 }
});
