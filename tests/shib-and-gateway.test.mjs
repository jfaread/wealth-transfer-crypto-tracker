import test from 'node:test';
import assert from 'node:assert/strict';
import {COINS, normaliseRule, evaluateRule} from '../alerts/core.mjs';
import {parseKrakenMessage, connectKraken, KRAKEN_WS_URL} from '../alerts/feeds.mjs';
import {parseRestTrade} from '../alerts/rest-feed.mjs';
const now=Date.parse('2026-11-14T12:00:00Z');
test('SHIB is a true USD alert source with exact decimal threshold crossing',()=>{
  assert.equal(COINS.SHIB.pair,'SHIB/USD');
  const rule=normaliseRule({id:'7cb74454-c3af-4e3b-8a83-daf17963bba0',coin:'SHIB',direction:'above',threshold:'0.00000415',repeat:false,enabled:true});
  const quote=(price,time)=>({coin:'SHIB',price,source:'Kraken SHIB/USD',timestamp:time,receivedAt:time});
  const baseline=evaluateRule(rule,null,quote('0.00000414',now),now);
  assert.equal(baseline.event,null);
  const crossed=evaluateRule(rule,baseline.state,quote('0.00000416',now+1000),now+1000);
  assert.equal(crossed.event.coin,'SHIB');assert.equal(crossed.event.threshold,'0.00000415');
});
test('SHIB stream and REST retain provider timestamps and small decimal values',()=>{
  const tick={symbol:'SHIB/USD',last:0.000004154,timestamp:new Date(now).toISOString()};
  const parsed=parseKrakenMessage(JSON.stringify({channel:'ticker',type:'update',data:[tick]}),now);
  assert.equal(parsed.quotes[0].coin,'SHIB');assert.equal(parsed.quotes[0].price,'0.000004154');
  const packet={error:[],result:{'SHIB/USD':[['0.0000041540','1',now/1000,'s','l','',1]]}};
  assert.equal(parseRestTrade(packet,'SHIB',now).timestamp,now);
  assert.equal(parseRestTrade(packet,'SHIB',now+60001),null);
  assert.equal(parseRestTrade({error:[],result:{'SHIB/USDT':packet.result['SHIB/USD']}},'SHIB',now),null);
});
for(const status of [429,502,503,526])test('secure REST fallback after streaming HTTP '+status,async()=>{
  let attempts=0,cancelled=false,fallback=0;
  const socket={transport:'rest',close(){}};
  const result=await connectKraken({fetchImpl:async(url,options)=>{
    attempts++;assert.equal(url,KRAKEN_WS_URL);assert(url.startsWith('https://'));assert.equal(options.redirect,'manual');
    return {status,body:{async cancel(){cancelled=true;}}};
  },restConnector:async()=>{fallback++;return socket;}});
  assert.equal(result,socket);assert.equal(attempts,1);assert.equal(fallback,1);assert(cancelled);
});
