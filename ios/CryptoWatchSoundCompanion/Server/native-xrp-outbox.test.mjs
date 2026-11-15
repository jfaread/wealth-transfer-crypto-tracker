import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {NativeRegistrationStore} from './native-registry.mjs';
import {NativeXrpOutbox} from './native-xrp-outbox.mjs';
import {evaluateRule} from '../../../alerts/core.mjs';
const OWNER='235636a8-a59c-448d-8f8a-f6f07f585af4', NOW=Date.parse('2026-11-15T12:00:00Z');
class Storage{
 constructor(){this.map=new Map();}
 async get(k){return structuredClone(this.map.get(k));}
 async put(k,v){this.map.set(k,structuredClone(v));}
 async delete(k){this.map.delete(k);}
 async list({prefix}={}){return new Map([...this.map].filter(([k])=>!prefix||k.startsWith(prefix)));}
 async transaction(fn){const snapshot=new Storage();snapshot.map=new Map(this.map);const out=await fn(snapshot);this.map=snapshot.map;return out;}
}
const rule={id:'a42d029d-6a5c-48f0-a50d-de3a6c44800e',coin:'XRP',direction:'below',threshold:'0.90',repeat:true,enabled:true};
function crossing(now=NOW){
 const before={coin:'XRP',price:'0.91',source:'Kraken XRP/USD',timestamp:now-25000,receivedAt:now-24000,snapshot:false};
 const after={...before,price:'0.899',timestamp:now-1000,receivedAt:now,snapshot:false};
 const baseline=evaluateRule(rule,null,before,now);
 assert.equal(baseline.event,null);
 const crossed=evaluateRule(rule,baseline.state,after,now);
 assert.equal(crossed.reason,'crossing');
 return crossed.event;
}
async function setup({sender=async()=>({accepted:true}),settings={teamId:'TESTTEAM01',keyId:'TESTKEY001',privateKeyPEM:'secret',
 bundleId:'com.jfaread.cryptowatch.sound',environment:'sandbox'}}={}){
 const storage=new Storage(),clock={value:NOW};
 const registry=new NativeRegistrationStore({storage,cryptoImpl:webcrypto,now:()=>clock.value,environment:'sandbox',ownerExists:async id=>id===OWNER});
 const pair=await registry.createPairing(OWNER);
 await registry.redeemPairing({pairingCode:pair.pairingCode,apnsToken:'cc'.repeat(32),environment:'sandbox'});
 const outbox=new NativeXrpOutbox({storage,registry,cryptoImpl:webcrypto,now:()=>clock.value,settings,sender});
 return {storage,registry,outbox,clock};
}
test('native sound is queued only for a genuine monitored XRP downward crossing',async()=>{
 const {outbox,storage}=await setup();
 const event=crossing(),jobs=await outbox.prepare(OWNER,event);
 assert.equal(jobs.length,1);
 assert.match(jobs[0].id,/^[0-9a-f]{64}$/);
 assert.equal(jobs[0].event.threshold,'0.9','The original FCA-grade decimal evaluator canonicalises 0.90 as 0.9; APNs formats it as $0.90.');
 assert.equal(jobs[0].event.price,'0.899');
 assert.equal((await storage.list({prefix:'cw-native-outbox-v1:'})).size,0,'prepare cannot send before transaction');
 await storage.transaction(async tx=>outbox.saveInTransaction(tx,jobs));
 assert.equal((await storage.list({prefix:'cw-native-outbox-v1:'})).size,1);
});
test('an initial below-threshold observation never creates a native event',async()=>{
 const first={coin:'XRP',price:'0.89',source:'Kraken XRP/USD',timestamp:NOW-1000,receivedAt:NOW,snapshot:true};
 const result=evaluateRule(rule,null,first,NOW);
 assert.equal(result.event,null);
 const {outbox}=await setup();
 await assert.rejects(outbox.prepare(OWNER,{id:'malicious',coin:'XRP',direction:'above',threshold:'0.90',
  price:'0.899',observedAt:NOW}),/XRP/);
});
test('queued native event reaches a mocked APNs sender with installed original sound',async()=>{
 const sent=[];
 const {outbox,storage}=await setup({sender:async options=>{sent.push(options);return {accepted:true};}});
 const event=crossing();
 await outbox.enqueue(OWNER,event);
 assert.deepEqual(await outbox.drain(),{sent:1,failed:0,blocked:false});
 assert.equal(sent.length,1);
 assert.equal(sent[0].event.type,'threshold');
 assert.equal(sent[0].event.coin,'XRP');
 assert.equal(sent[0].token,'cc'.repeat(32));
 assert.equal((await storage.list({prefix:'cw-native-outbox-v1:'})).size,0);
});
test('APNs cannot be contacted without signing settings; queued events remain intact',async()=>{
 let calls=0;
 const {outbox,storage}=await setup({settings:null,sender:async()=>{calls++;return {accepted:true};}});
 await outbox.enqueue(OWNER,crossing());
 const status=await outbox.drain();
 assert.equal(status.blocked,true);assert.equal(calls,0);
 assert.equal((await storage.list({prefix:'cw-native-outbox-v1:'})).size,1);
});
test('provider failures retry within expiry without fabricating a new crossing',async()=>{
 let calls=0;
 const {outbox,storage,clock}=await setup({sender:async()=>{calls++;throw Error('Temporary transport failure');}});
 await outbox.enqueue(OWNER,crossing());
 assert.equal((await outbox.drain()).failed,1);
 assert.equal(calls,1);
 assert.equal((await outbox.drain()).failed,0,'A reservation must suppress immediate repeats');
 clock.value+=15100;
 assert.equal((await outbox.drain()).failed,1);
 assert.equal(calls,2);
 clock.value+=15100;
 assert.equal((await outbox.drain()).failed,1);
 assert.equal(calls,3);
 assert.equal((await storage.list({prefix:'cw-native-outbox-v1:'})).size,0);
});
test('unpaired iPhone cancels pending sounds; unrelated native identities are untouched',async()=>{
 let calls=0;
 const {outbox,storage,registry}=await setup({sender:async()=>{calls++;return {accepted:true};}});
 await outbox.enqueue(OWNER,crossing());
 await outbox.cancelParent(OWNER);await registry.revokeOwner(OWNER);
 assert.equal((await outbox.drain()).sent,0);
 assert.equal(calls,0);
 assert.equal((await storage.list({prefix:'cw-native-outbox-v1:'})).size,0);
});
