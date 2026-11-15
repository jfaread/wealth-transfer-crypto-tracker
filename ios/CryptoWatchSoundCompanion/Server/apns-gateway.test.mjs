import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,webcrypto} from 'node:crypto';
import {nativeXrpNotification,signAPNsJWT,sendNativeXrpAPNs} from './apns-gateway.mjs';

const now=Date.parse('2026-11-15T12:00:00Z');
const base={type:'threshold',coin:'XRP',direction:'below',threshold:'0.90',price:'0.8999',
 eventId:'123e4567-e89b-12d3-a456-426614174000',observedAt:now-10000,expiresAt:now+120000};
const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
const base64JSON=text=>JSON.parse(Buffer.from(text.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
test('native payload contains original bundled WAV name without external URL',()=>{
 const result=nativeXrpNotification(base,now);
 assert.deepEqual(result.payload.aps.alert,{title:'XRP Alert',body:'XRP crossed below $0.90. Verified $0.8999.'});
 assert.equal(result.payload.aps.sound,'xrp-alert.wav');
 assert(!JSON.stringify(result).includes('youtube'));
});
test('only the three exact downward crossings are accepted',()=>{
 for(const value of ['0.9','0.90','0.8','0.80','0.7','0.70']){
  const p=(Number(value)-.001).toFixed(3);
  assert.equal(nativeXrpNotification({...base,threshold:value,price:p},now).payload.aps.sound,'xrp-alert.wav');
 }
 for(const change of [{coin:'BTC'},{direction:'above'},{threshold:'0.85'},{type:'test'},
 {price:'0.90'},{price:'-1'},{observedAt:now-300001},{expiresAt:now-1}]){
  assert.throws(()=>nativeXrpNotification({...base,...change},now));
 }
});
test('Apple APNs JWT uses ES256, team ID, key ID and a bounded clock',async()=>{
 const jwt=await signAPNsJWT({teamId:'1A2B3C4D5E',keyId:'5E4D3C2B1A',privateKeyPEM:pem,subtle:webcrypto.subtle,now});
 const [head,claims,signature]=jwt.split('.');
 assert.deepEqual(base64JSON(head),{alg:'ES256',kid:'5E4D3C2B1A'});
 assert.deepEqual(base64JSON(claims),{iss:'1A2B3C4D5E',iat:Math.floor(now/1000)});
 assert.equal(Buffer.from(signature.replace(/-/g,'+').replace(/_/g,'/'),'base64').length,64);
});
test('mocked APNs sender uses the correct topic, expiry, environment and WAV',async()=>{
 const calls=[];
 const result=await sendNativeXrpAPNs({event:base,token:'ab'.repeat(32),teamId:'1A2B3C4D5E',keyId:'5E4D3C2B1A',
 privateKeyPEM:pem,bundleId:'com.jfaread.cryptowatch.sound',subtle:webcrypto.subtle,now,
 environment:'sandbox',fetchImpl:async(url,options)=>{calls.push({url,options});return {status:200};}});
 assert.deepEqual(result,{accepted:true,eventId:base.eventId});
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://api.sandbox.push.apple.com/3/device/'+'ab'.repeat(32));
 assert.equal(calls[0].options.headers['apns-topic'],'com.jfaread.cryptowatch.sound');
 assert.equal(calls[0].options.headers['apns-push-type'],'alert');
 assert.equal(calls[0].options.headers['apns-expiration'],String(Math.floor(base.expiresAt/1000)));
 assert.equal(JSON.parse(calls[0].options.body).aps.sound,'xrp-alert.wav');
});
test('malformed tokens and invalid prices never leave the backend',async()=>{
 let calls=0;
 for(const entry of [{event:{...base,threshold:'0.95'},token:'ab'.repeat(32)},{event:base,token:'wrong'}]){
  await assert.rejects(sendNativeXrpAPNs({...entry,now,fetchImpl:async()=>{calls++;return {status:200};}}));
 }
 assert.equal(calls,0);
});
test('provider failure does not disclose Apple token or credentials',async()=>{
 const token='ab'.repeat(32);
 await assert.rejects(sendNativeXrpAPNs({event:base,token,teamId:'1A2B3C4D5E',keyId:'5E4D3C2B1A',
 privateKeyPEM:pem,bundleId:'com.jfaread.cryptowatch.sound',subtle:webcrypto.subtle,now,
 fetchImpl:async()=>({status:400})}),error=>error.message==='APNs delivery could not be confirmed'&&!error.message.includes(token));
});
