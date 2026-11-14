import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient,retryAt,providerState} from '../scripts/market-data-core.mjs';
import {createMarketClient} from '../scripts/market-client.mjs';
const URL='https://api.coingecko.com/api/v3/simple/price?ids=bitcoin';
const now=Date.parse('2026-11-14T18:00:00Z');
const env=()=>{let time=now;return {now:()=>time,sleep:async ms=>{time+=ms;},advance:ms=>{time+=ms;}};};

test('parallel callers are serialised and spaced; one rejection does not poison the queue',async()=>{
 const clock=env(),starts=[];let inFlight=0,max=0;
 const get=createClient({...clock,fetchImpl:async()=>{starts.push(clock.now());max=Math.max(max,++inFlight);await Promise.resolve();inFlight--;return starts.length===1?new Response('',{status:404}):Response.json({ok:true});}});
 const r=await Promise.allSettled([get(URL),get(URL),get(URL)]);
 assert.equal(r[0].status,'rejected');assert(r.slice(1).every(x=>x.status==='fulfilled'));assert.equal(max,1);assert.deepEqual(starts,[now,now+15000,now+30000]);
});
test('a never-resolving fetch is bounded even when it ignores AbortSignal',async()=>{
 const get=createClient({spacing:0,timeoutMs:15,fetchImpl:async()=>new Promise(()=>{})});const start=Date.now();
 await assert.rejects(get(URL),/timed out/);assert(Date.now()-start<1000);
});
test('a stalled streamed body is cancelled and bounded; it cannot hold the updater forever',async()=>{
 let cancelled=0;const get=createClient({spacing:0,timeoutMs:15,fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled++;}}),{headers:{'Content-Type':'application/json'}})});
 await assert.rejects(get(URL),/timed out/);assert.equal(cancelled,2);
});
test('provider cooldown survives two separate updater clients and retains long Retry-After',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cw-state-'));try{
  const file=join(dir,'provider-state.json'),clock=env();let calls=0;
  const options={...clock,stateFile:file,fetchImpl:async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'3600'}});}};
  await assert.rejects((await createMarketClient(options))(URL),e=>e.retryAt===now+3600000);
  const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.cooldownUntil,now+3600000);
  await assert.rejects((await createMarketClient(options))(URL),/cooldown/);assert.equal(calls,1);
  clock.advance(3600001);await assert.rejects((await createMarketClient(options))(URL));assert.equal(calls,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('success resets the failure circuit, repeated outages pause before new requests',async()=>{
 const clock=env();let saved,calls=0;const get=createClient({...clock,saveState:async s=>{saved=s;},fetchImpl:async()=>{calls++;return new Response('',{status:503});}});
 await assert.rejects(get(URL),/503/);assert.equal(calls,2);
 await assert.rejects(get(URL),e=>!!e.retryAt);assert.equal(calls,3);assert.equal(saved.failures,3);
 await assert.rejects(get(URL),/cooldown/);assert.equal(calls,3);
 clock.advance(60001);const recovered=createClient({...clock,state:saved,fetchImpl:async()=>Response.json({ok:true}),saveState:async s=>{saved=s;}});
 await recovered(URL);assert.equal(saved.failures,0);assert.equal(saved.cooldownUntil,0);
});
test('a failed reservation write sends no network request',async()=>{
 let calls=0;const get=createClient({saveState:async()=>{throw Error('Disk unavailable');},fetchImpl:async()=>{calls++;return Response.json({});}});
 await assert.rejects(get(URL),/Disk unavailable/);assert.equal(calls,0);
});
test('corrupt persisted timing state fails closed instead of bypassing a possible cooldown',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cw-corrupt-'));try{const file=join(dir,'state.json');await writeFile(file,'{"cooldownUntil":"invalid"}');await assert.rejects(createMarketClient({stateFile:file}),/cannot be verified/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('metadata and Retry-After validation reject unsafe values and preserve minimum pause',()=>{
 for(const input of [{version:2},{failures:-1},{lastRequestAt:Infinity},{cooldownUntil:'1'}])assert.throws(()=>providerState(input));
 for(const input of ['',null,'NaN','-100','Infinity','1e999'])assert.equal(retryAt(input,now),now+60000);
 assert.equal(retryAt('120',now),now+120000);assert.equal(retryAt(new Date(now+300000).toUTCString(),now),now+300000);
});
test('malformed JSON, wrong content types and redirects are rejected once without unsafe retries',async()=>{
 for(const response of [()=>new Response('<html>',{headers:{'Content-Type':'text/html'}}),()=>new Response('{',{headers:{'Content-Type':'application/json'}}),()=>Response.json([]),()=>Response.json({error:'no'}),()=>new Response('',{status:302,headers:{Location:'https://evil.invalid'}})]){
  let calls=0;const get=createClient({spacing:0,fetchImpl:async()=>{calls++;return response();}});await assert.rejects(get(URL));assert.equal(calls,1);
 }
});
test('credentials, fragments and other origins never reach the public provider',async()=>{
 let calls=0;const get=createClient({fetchImpl:async()=>{calls++;return Response.json({});}});
 for(const url of ['http://api.coingecko.com/a','https://user:secret@api.coingecko.com/a',URL+'#secret','https://api.coingecko.com.evil.test/a'])await assert.rejects(get(url));assert.equal(calls,0);
});
