import test from 'node:test';
import assert from 'node:assert/strict';
import {COINS,normaliseRule,compareDecimals,decimalFromNumber,validateQuote,evaluateRule,REPEAT_COOLDOWN_MS} from '../alerts/core.mjs';

const NOW = Date.UTC(2026,10,13,16,0,0);
const ID = 'e9202775-d077-438a-9187-6625fdd98485';
const rule = overrides => normaliseRule({id:ID,coin:'BTC',direction:'above',threshold:'100',...overrides});
const quote = (price, offset = 0, overrides = {}) => ({coin:'BTC',price,source:COINS.BTC.source,timestamp:NOW + offset,receivedAt:NOW + offset,...overrides});
const step = (r,s,p,t=0,changes={}) => evaluateRule(r,s,quote(p,t,changes),NOW+t);

test('small prices use exact decimals and preserve sub-binary precision', () => {
  assert.equal(compareDecimals('0.000000000000000000000001','0.000000000000000000000002'),-1);
  assert.equal(compareDecimals('999999999999999999.123456789012345678901234','999999999999999999.123456789012345678901233'),1);
  assert.equal(compareDecimals('0000.12000','0.12'),0);
  assert.equal(decimalFromNumber(1e-12),'0.000000000001');
  assert.equal(decimalFromNumber(2.345e-10),'0.0000000002345');
  assert.equal(rule({threshold:'000100.000'}).threshold,'100');
  for (const value of ['1e-8','-1','0','Infinity','NaN','.1','1.','1,000','0.0000000000000000000000001','1000000000000000000']) assert.throws(() => rule({threshold:value}));
  for (const value of [NaN,Infinity,0,-1,1e25]) assert.throws(() => decimalFromNumber(value));
});

test('all eight token identities are fixed, including exact additional contracts', () => {
  assert.deepEqual(Object.keys(COINS),['BTC','ETH','BNB','XRP','SOL','KISHU','WKC','CREPE']);
  assert.equal(COINS.KISHU.contract,'0xA2b4C0Af19cC16a6CfAcCe81F192B024d625817D');
  assert.equal(COINS.WKC.contract,'0x6ec90334d89dbdc89e08a133271be3d104128edb');
  assert.equal(COINS.CREPE.contract,'0xeb2b7d5691878627eff20492ca7c9a71228d931d');
  assert.equal(COINS.CREPE.geckoId,'crepe-2');
  assert.equal(COINS.KISHU.source,'Indicative Uniswap v2 KISHU/WETH + Kraken ETH/USD');
  assert.equal(COINS.WKC.source,'Indicative PancakeSwap v2 WKC/WBNB + Kraken BNB/USD');
  assert.equal(COINS.CREPE.source,'Indicative PancakeSwap v2 CREPE/WBNB + Kraken BNB/USD');
});

test('rule validation rejects unsupported assets, unsafe identifiers and ambiguous types', () => {
  for (const input of [{coin:'__proto__'},{coin:'DOGE'},{id:'../x'},{direction:'up'},{threshold:100},{repeat:'true'},{enabled:1}]) assert.throws(()=>rule(input));
});

test('single alert fires only once at a strict upward crossing', () => {
  const r=rule(); let s=step(r,null,'99').state;
  let x=step(r,s,'100',1); assert.equal(x.event,null); s=x.state;
  x=step(r,s,'100.000000000000000000000001',2); assert.equal(x.reason,'crossing'); assert.equal(x.event.price,'100.000000000000000000000001'); assert.equal(x.state.fired,true);
  assert.equal(step(r,x.state,'101',3).reason,'completed');
});

test('initially crossed thresholds wait for re-entry before firing', () => {
  const r=rule(); let x=step(r,null,'110'); assert.equal(x.reason,'baseline'); assert.equal(x.state.armed,false);
  x=step(r,x.state,'120',1); assert.equal(x.event,null);
  x=step(r,x.state,'100',2); assert.equal(x.state.armed,true);
  x=step(r,x.state,'101',3); assert.ok(x.event);
});

test('below alerts and tiny token thresholds compare without rounding', () => {
  const r=rule({coin:'KISHU',direction:'below',threshold:'0.00000000025'});
  const a={coin:'KISHU',source:'Validated test pool'};
  let s=step(r,null,'0.0000000003',0,a).state;
  assert.equal(step(r,s,'0.00000000025',1,a).event,null);
  let x=step(r,s,'0.000000000249999999999999',2,a); assert.ok(x.event); assert.equal(x.event.coin,'KISHU');
});

test('repeat needs a new crossing and the stated 60 second minimum interval', () => {
  const r=rule({repeat:true}); let x=step(r,null,'99');
  x=step(r,x.state,'101',1); assert.ok(x.event);
  x=step(r,x.state,'102',2); assert.equal(x.event,null);
  x=step(r,x.state,'99',3); x=step(r,x.state,'101',4); assert.equal(x.reason,'cooldown');
  x=step(r,x.state,'102',REPEAT_COOLDOWN_MS+5); assert.equal(x.event,null,'no delayed alert for a crossing already consumed');
  x=step(r,x.state,'100',REPEAT_COOLDOWN_MS+6); x=step(r,x.state,'101',REPEAT_COOLDOWN_MS+7); assert.ok(x.event);
});

test('source changes, gaps, changed thresholds and stale packets cannot invent a crossing', () => {
  const r=rule(); const s=step(r,null,'99').state;
  assert.equal(step(r,s,'101',1,{source:'Other verified venue'}).reason,'source_changed');
  assert.equal(step(r,s,'101',120001).reason,'gap_rebaseline');
  assert.equal(step(rule({threshold:'90'}),s,'101',1).reason,'rule_changed');
  const stale=evaluateRule(r,s,quote('101',1),NOW+90000); assert.equal(stale.reason,'stale_quote');
  assert.equal(step(r,stale.state,'102',90001).reason,'gap_rebaseline');
});

test('duplicates and old packets never advance state or emit a second event', () => {
  const r=rule({repeat:true}); const s=step(r,null,'99').state;
  assert.equal(step(r,s,'101').reason,'duplicate_quote');
  assert.equal(step(r,s,'101',-1).reason,'out_of_order');
  assert.deepEqual(step(r,s,'101',-1).state,s);
  const a=step(r,s,'101',1); const b=step(r,s,'101',1); assert.equal(a.event.id,b.event.id);
  assert.equal(step(r,a.state,'102',1).event,null);
});

test('invalid, delayed and future quotes are rejected with a useful reason', () => {
  assert.equal(validateQuote(quote('0'),NOW).reason,'invalid_price');
  assert.equal(validateQuote(quote('1e-8'),NOW).reason,'invalid_price');
  assert.equal(validateQuote(quote('100',6000),NOW).reason,'future_quote');
  assert.equal(validateQuote(quote('100',-31000),NOW).reason,'stale_receipt');
  assert.equal(validateQuote(quote('100',-61000),NOW).reason,'stale_quote');
  assert.equal(validateQuote(quote('100',0,{timestamp:1.5}),NOW).reason,'invalid_quote');
  assert.equal(step(rule(),null,'101',0,{coin:'ETH'}).reason,'coin_mismatch');
  assert.equal(step(rule({enabled:false}),null,'101').reason,'disabled');
});

test('ordinary quotes retain their existing boundary behaviour and validated shape', () => {
  const input = quote('000100.00',0,{timestamp:NOW-60_000,receivedAt:NOW-30_000});
  const checked = validateQuote(input,NOW);
  assert.deepEqual(checked,{valid:true,reason:'fresh',quote:{...input,price:'100'}});
  assert.equal(Object.hasOwn(checked.quote,'freshUntil'),false);
  assert.equal(validateQuote(checked.quote,NOW+1).reason,'stale_quote');
  const r=rule(), baseline=step(r,null,'99').state;
  assert.equal(evaluateRule(r,baseline,quote('99'),NOW+90_000).reason,'duplicate_quote');
});

test('derived quotes retain the earliest component deadline despite a recent composite timestamp', () => {
  const cases = [
    {name:'old pool block',blockTs:NOW-59_000,nativeTs:NOW,nativeReceipt:NOW,pollReceipt:NOW},
    {name:'old native USD quote',blockTs:NOW,nativeTs:NOW-59_000,nativeReceipt:NOW,pollReceipt:NOW},
    {name:'old native receipt',blockTs:NOW,nativeTs:NOW-29_000,nativeReceipt:NOW-29_000,pollReceipt:NOW},
    {name:'old pool receipt',blockTs:NOW-29_000,nativeTs:NOW-29_000,nativeReceipt:NOW,pollReceipt:NOW-29_000}
  ];
  for (const {name,blockTs,nativeTs,nativeReceipt,pollReceipt} of cases) {
    const freshUntil = Math.min(blockTs+60_000,nativeTs+60_000,nativeReceipt+30_000,pollReceipt+30_000);
    assert.equal(freshUntil,NOW+1_000,name);
    const input = quote('0.00000000025',0,{
      coin:'KISHU',source:COINS.KISHU.source,timestamp:Math.max(blockTs,nativeTs),receivedAt:pollReceipt,freshUntil
    });
    const checked = validateQuote(input,NOW);
    assert.equal(checked.valid,true,name);
    assert.deepEqual(checked.quote,input,name);
    assert.equal(validateQuote(checked.quote,NOW+999).valid,true,name);
    assert.deepEqual(validateQuote(checked.quote,NOW+1_000),{valid:false,reason:'stale_quote'},name);
    const {freshUntil:ignored,...ordinary} = input;
    assert.equal(validateQuote(ordinary,NOW+1_000).valid,true,`${name}: component deadline is stricter than composite age`);
  }
});

test('derived quote deadlines reject malformed values and cannot extend either freshness limit', () => {
  for (const freshUntil of [undefined,null,'1763136000001',NaN,Infinity,-Infinity,0,-1,NOW+0.5,Number.MAX_SAFE_INTEGER+1,NOW+30_001]) {
    assert.deepEqual(validateQuote(quote('100',0,{freshUntil}),NOW),{valid:false,reason:'invalid_quote'});
  }
  const oldTimestamp = quote('100',0,{timestamp:NOW-50_000,freshUntil:NOW+10_001});
  assert.equal(validateQuote(oldTimestamp,NOW).reason,'invalid_quote','the source age bound applies even with a recent receipt');
  assert.equal(validateQuote({...oldTimestamp,freshUntil:NOW+10_000},NOW).valid,true);
  assert.equal(validateQuote(quote('100',0,{freshUntil:NOW+30_000}),NOW).valid,true);
});

test('a derived deadline does not bypass existing decimal, clock or age checks', () => {
  assert.equal(validateQuote(quote('1e-8',0,{freshUntil:NOW+1_000}),NOW).reason,'invalid_price');
  assert.equal(validateQuote(quote('100',6_000,{freshUntil:NOW+7_000}),NOW).reason,'future_quote');
  assert.equal(validateQuote(quote('100',0,{timestamp:NOW+1_000,receivedAt:NOW-5_000,freshUntil:NOW+1_000}),NOW).reason,'future_quote');
  assert.equal(validateQuote(quote('100',-61_000,{freshUntil:NOW-31_000}),NOW).reason,'stale_quote');
  assert.equal(validateQuote(quote('100',-31_000,{freshUntil:NOW-1_000}),NOW).reason,'stale_receipt');
});

test('an expired component blocks a crossing and recovery requires a fresh baseline', () => {
  const r=rule({coin:'KISHU'});
  const derived = (price,t,freshUntil) => quote(price,t,{coin:'KISHU',source:COINS.KISHU.source,freshUntil});
  let x=evaluateRule(r,null,derived('99',0,NOW+5_000),NOW);
  assert.equal(x.reason,'baseline');
  const original=x.state;
  x=evaluateRule(r,x.state,derived('101',2_000,NOW+5_000),NOW+5_000);
  assert.equal(x.reason,'stale_quote');
  assert.equal(x.event,null);
  assert.deepEqual(x.state,{...original,needsBaseline:true});
  x=evaluateRule(r,x.state,derived('102',5_001,NOW+35_001),NOW+5_001);
  assert.equal(x.reason,'gap_rebaseline');
  assert.equal(x.event,null,'a recovered quote beyond the threshold is a baseline, not an observed crossing');
  assert.equal(x.state.armed,false);
  assert.equal(Object.hasOwn(x.state,'freshUntil'),false,'component deadlines do not alter persisted rule state');
  x=evaluateRule(r,x.state,derived('99',5_002,NOW+35_002),NOW+5_002);
  assert.equal(x.state.armed,true);
  x=evaluateRule(r,x.state,derived('101',5_003,NOW+35_003),NOW+5_003);
  assert.equal(x.reason,'crossing');
  assert.ok(x.event);
});

test('the current derived quote expires when repeated, while older packets cannot disturb its baseline', () => {
  const r=rule(), input=quote('99',0,{freshUntil:NOW+1_000});
  const original=evaluateRule(r,null,input,NOW).state;
  assert.equal(evaluateRule(r,original,input,NOW+999).reason,'duplicate_quote');
  const older=evaluateRule(r,original,quote('101',-1,{freshUntil:NOW}),NOW+1_000);
  assert.equal(older.reason,'out_of_order');
  assert.deepEqual(older.state,original);
  const expired=evaluateRule(r,original,input,NOW+1_000);
  assert.equal(expired.reason,'stale_quote');
  assert.equal(expired.event,null);
  assert.deepEqual(expired.state,{...original,needsBaseline:true});
  const recovered=evaluateRule(r,expired.state,quote('101',1_001,{freshUntil:NOW+31_001}),NOW+1_001);
  assert.equal(recovered.reason,'gap_rebaseline');
  assert.equal(recovered.event,null);
  assert.equal(evaluateRule(r,original,{...input,freshUntil:'invalid'},NOW).reason,'invalid_quote');
});
