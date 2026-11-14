import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {buildSnapshot,validateSnapshot,feedHealth,COIN_IDS} from '../scripts/build-site.mjs';
const items=Object.fromEntries(await Promise.all(COIN_IDS.map(async id=>[id,JSON.parse(await readFile(new URL('../data/'+id+'.json',import.meta.url),'utf8'))])));
const manifest=JSON.parse(await readFile(new URL('../data/manifest.json',import.meta.url),'utf8'));
const now=Math.max(manifest.updatedAt,...Object.values(items).flatMap(x=>[x.updatedAt,...Object.values(x.windowUpdatedAt||{}),...Object.values(x.prices).map(p=>p.at(-1)[0])]))+1000;
const good=()=>buildSnapshot(structuredClone(items),structuredClone(manifest),now);
test('every publication contains all nine exact assets across all six supported periods',()=>{const s=good();assert(validateSnapshot(s,now));for(const b of Object.values(s.ranges))assert.deepEqual(b.data.map(x=>x[0]),COIN_IDS);});
test('wrong token identities, future timestamps and incomplete coverage cannot be published',()=>{
 for(const mutate of [x=>x.SHIB.id='wrong-token',x=>x.BTC.prices[31].push([now+300001,1]),x=>x.CREPE.prices[31]=x.CREPE.prices[31].slice(-2)]){const data=structuredClone(items);mutate(data);assert.throws(()=>buildSnapshot(data,manifest,now));}
});
test('validation rejects dropped coins, fake returns, unmarked gaps and date manipulation',()=>{
 for(const mutate of [x=>x.ranges['1Y'].data.pop(),x=>x.ranges['1D'].data[0][1].points[1].r+=10,x=>x.ranges['1D'].data[0][1].gaps+=1,x=>x.ranges['5D'].spec.currency='USDT',x=>x.ranges['1M'].spec.end=now+300001,x=>delete x.ranges.YTD]){const s=good();mutate(s);assert.throws(()=>validateSnapshot(s,now));}
});
test('long history does not pretend to have the short-history observation timestamp',()=>{
 const data=structuredClone(items);const cutoff=Math.min(...Object.values(data).map(x=>x.prices[365].at(-1)[0]))-6*3600000;
 for(const d of Object.values(data))d.prices[365]=d.prices[365].filter(p=>p[0]<=cutoff);
 const s=buildSnapshot(data,manifest,now);assert(s.ranges['1Y'].spec.end<s.ranges['1D'].spec.end);assert(validateSnapshot(s,now));
});
test('health uses provider observation times, never a newly written cache time',()=>{
 const s=good(),quotes={checkedAt:now,quotes:{bitcoin:{usd:1,last_updated_at:(now-1800001)/1000},'shiba-inu':{usd:0.000004,last_updated_at:Math.floor(now/1000)}}};
 const h=feedHealth(s,quotes,now);assert.equal(h.coins.BTC.quoteAvailable,false);assert.equal(h.coins.SHIB.quoteAvailable,true);assert.equal(h.status,'degraded');assert.equal(h.coins.BTC.historyObservedAt,s.ranges['1D'].data[0][1].points.at(-1).t);
});
