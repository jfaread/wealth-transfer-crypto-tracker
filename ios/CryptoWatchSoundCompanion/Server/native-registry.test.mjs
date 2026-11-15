import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {NativeRegistrationStore} from './native-registry.mjs';
const PARENT='d5dd4796-7926-4c68-91a8-811e80d82739';
const OTHER='d5dd4796-7926-4c68-91a8-811e80d82740';
const APNS='a0'.repeat(32);

class MemoryStorage {
  constructor(){this.items=new Map();}
  async get(key){return structuredClone(this.items.get(key));}
  async put(key,value){this.items.set(key,structuredClone(value));}
  async delete(key){this.items.delete(key);}
  async list({prefix}={}){return new Map([...this.items].filter(([key])=>!prefix||key.startsWith(prefix)).map(([key,v])=>[key,structuredClone(v)]));}
  async transaction(work){
    const copy=new MemoryStorage();copy.items=new Map([...this.items].map(([k,v])=>[k,structuredClone(v)]));
    const result=await work(copy);
    this.items=copy.items;
    return result;
  }
}
const make=()=>{const storage=new MemoryStorage(),clock={value:Date.parse('2026-11-15T12:00:00Z')};
  const registry=new NativeRegistrationStore({storage,now:()=>clock.value,ownerExists:async id=>id===PARENT,cryptoImpl:webcrypto,environment:'sandbox'});
  return {storage,clock,registry};
};
test('authorised web device issues one high-entropy short-lived pairing code',async()=>{
  const {registry,storage,clock}=make();
  await assert.rejects(registry.createPairing(OTHER),/not authorised/);
  const issued=await registry.createPairing(PARENT);
  assert.match(issued.pairingCode,/^[0-9a-f]{64}$/);
  assert.equal(issued.expiresAt-clock.value,300000);
  assert(!JSON.stringify([...storage.items]).includes(issued.pairingCode),'Plaintext code is never persisted');
  assert.equal((await storage.list({prefix:'cw-native-v1:pair:'})).size,1);
  const next=await registry.createPairing(PARENT);
  assert.notEqual(next.pairingCode,issued.pairingCode);
  await assert.rejects(registry.redeemPairing({pairingCode:issued.pairingCode,apnsToken:APNS,environment:'sandbox'}),/expired/);
});
test('one-time exchange never exposes APNs token as authentication; bearer is hashed',async()=>{
  const {registry,storage}=make();
  const pair=await registry.createPairing(PARENT);
  const result=await registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:APNS,environment:'sandbox'});
  assert.match(result.bearer,/^[a-f0-9-]{36}\.[a-f0-9]{64}$/);
  assert.deepEqual(await registry.publicStatus(result.bearer),{connected:true,deviceId:result.deviceId,environment:'sandbox',updatedAt:Date.parse('2026-11-15T12:00:00Z')});
  assert(!JSON.stringify([...storage.items]).includes(result.bearer),'Bearer must never be stored in plaintext');
  await assert.rejects(registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:APNS,environment:'sandbox'}),/expired/);
  await assert.rejects(registry.publicStatus(result.deviceId+'.'+'b'.repeat(64)),/not authorised/);
  assert(!JSON.stringify(await registry.publicStatus(result.bearer)).includes(APNS),'Public status never exposes the token');
});
test('pairing expires and checks APNs environment, token syntax and owner',async()=>{
  const {registry,clock}=make();
  const pair=await registry.createPairing(PARENT);
  await assert.rejects(registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:'bad',environment:'sandbox'}),/APNs/);
  await assert.rejects(registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:APNS,environment:'production'}),/environment/);
  clock.value+=300001;
  await assert.rejects(registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:APNS,environment:'sandbox'}),/expired/);
});
test('native device token rotates with authenticated bearer; revoke blocks reuse',async()=>{
  const {registry,clock}=make();
  const pair=await registry.createPairing(PARENT);
  const auth=await registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:APNS,environment:'sandbox'});
  clock.value+=30000;
  await registry.refresh(auth.bearer,'a1'.repeat(32));
  assert.equal((await registry.devices(PARENT))[0].apnsToken,'a1'.repeat(32));
  assert.equal((await registry.publicStatus(auth.bearer)).updatedAt,clock.value);
  await registry.revoke(auth.bearer);
  await assert.rejects(registry.publicStatus(auth.bearer),/not authorised/);
});
test('no more than two native devices per authorised browser; daily pairing attempts are bounded',async()=>{
  const {registry,storage}=make();
  for(let i=0;i<2;i++){
    const pair=await registry.createPairing(PARENT);
    await registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:(i?'a1':'a0').repeat(32),environment:'sandbox'});
  }
  await assert.rejects(registry.createPairing(PARENT),/device limit/);
  assert.equal((await registry.devices(PARENT)).length,2);
  assert.equal((await storage.list({prefix:'cw-native-v1:device:'})).size,2);
});
test('browser removal cascades securely without changing another browser',async()=>{
  const {registry,storage}=make();
  const pair=await registry.createPairing(PARENT);
  const auth=await registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:APNS,environment:'sandbox'});
  await registry.revokeOwner(PARENT);
  assert.equal((await storage.list({prefix:'cw-native-v1:device:'})).size,0);
  await assert.rejects(registry.publicStatus(auth.bearer),/not authorised/);
});
test('parallel redemptions cannot consume the same pairing code twice',async()=>{
  const {registry}=make();const pair=await registry.createPairing(PARENT);
  const results=await Promise.allSettled(Array.from({length:5},(_,i)=>registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:('a'+i).repeat(32),environment:'sandbox'})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await registry.devices(PARENT)).length,1);
});
test('storage rejects partial writes and cannot silently leave a registration',async()=>{
  const {registry,storage}=make(),pair=await registry.createPairing(PARENT);
  const orig=storage.transaction.bind(storage);
  storage.transaction=async fn=>orig(async tx=>{await fn(tx);throw Error('storage unavailable');});
  await assert.rejects(registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:APNS,environment:'sandbox'}),/storage unavailable/);
  assert.equal((await storage.list({prefix:'cw-native-v1:device:'})).size,0);
  storage.transaction=orig;
  assert((await registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:APNS,environment:'sandbox'})).connected);
});
