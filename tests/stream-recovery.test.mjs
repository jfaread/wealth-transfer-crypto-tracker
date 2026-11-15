import test from 'node:test';
import assert from 'node:assert/strict';
import {probeKrakenStream} from '../alerts/feeds.mjs';
import {createKrakenRestFeed, STREAM_REPROBE_MS} from '../alerts/rest-feed.mjs';

const START = Date.parse('2026-11-15T11:00:00Z');
const good = JSON.stringify({channel:'ticker',type:'snapshot',data:[{
  symbol:'XRP/USD',last:0.895,timestamp:new Date(START).toISOString(),
}]});

test('recovery probe promotes only after a genuine timestamped Kraken USD observation',async()=>{
  const listeners={},received=[],sent=[];
  let accepted=0,closed=0;
  const socket={accept(){accepted++;},addEventListener(name,fn){listeners[name]=fn;},
    send(value){sent.push(JSON.parse(value));},close(){closed++;}};
  const probe=probeKrakenStream({fetchImpl:async()=>({status:101,webSocket:socket}),
    now:()=>START,timeoutMs:1000,onMessage:raw=>received.push(raw)});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(accepted,1);
  listeners.message({data:JSON.stringify({channel:'heartbeat'})});
  listeners.message({data:JSON.stringify({channel:'ticker',type:'snapshot',data:[{symbol:'XRP/USDT',last:0.8,timestamp:new Date(START).toISOString()}]})});
  assert.equal(received.length,0);
  listeners.message({data:good});
  const result=await probe;
  assert(result?.socket===socket);
  assert.equal(received.length,0,'No stream frames before controlled promotion');
  result.activate();
  assert.deepEqual(received,[good]);
  listeners.message({data:good});assert.equal(received.length,2);
  assert.equal(closed,0);
  assert.equal(sent[0].params.event_trigger,'trades');
  socket.close();
});

test('recovery probe rejects a 429 response without starting another REST poller',async()=>{
  let calls=0,cancelled=0;
  const result=await probeKrakenStream({fetchImpl:async()=>{calls++;return {
    status:429,body:{async cancel(){cancelled++;}}
  };},timeoutMs:100});
  assert.equal(result,null);assert.equal(calls,1);assert.equal(cancelled,1);
});

test('stream handshake without a fresh validated tick times out and closes',async()=>{
  let closed=0;
  const socket={accept(){},addEventListener(){},send(){},close(){closed++;}};
  const result=await probeKrakenStream({fetchImpl:async()=>({status:101,webSocket:socket}),timeoutMs:35});
  assert.equal(result,null);assert.equal(closed,1);
});

test('scheduled recovery keeps REST polling active until a validated stream is promoted',async()=>{
  let current=START,created=0,upgraded=0,activated=0,stored=0;
  const tasks=[],frames=[],streamSocket={close(){}};
  const schedule=(fn,ms)=>{const task={fn,at:current+ms};tasks.push(task);return task;};
  const cancel=task=>{const i=tasks.indexOf(task);if(i>=0)tasks.splice(i,1);};
  const packet=coin=>({error:[],result:{[coin+'/USD']:[['1.23','1',current/1000,'b','l','',1]]}});
  const rest=await createKrakenRestFeed({now:()=>current,schedule,cancel,
    pace:async(ms)=>{current+=ms;},
    fetchImpl:async url=>Response.json(packet(new URL(url).searchParams.get('pair').replace(/USD$/,''))),
    probeStream:async()=>{created++;return {socket:streamSocket,activate(){activated++;frames.push('new-stream');}};},
    onUpgrade:socket=>{assert.equal(socket,streamSocket);upgraded++;return true;},
    loadProbeAt:async()=>START+STREAM_REPROBE_MS,
    saveProbeAt:async value=>{stored=value;},
    onMessage:raw=>frames.push(JSON.parse(raw)),onOpen:()=>{},
  });
  assert.equal(rest.transport,'rest');assert.equal(created,0);
  current=START+STREAM_REPROBE_MS+1000;
  const next=tasks.shift();assert(next);
  await next.fn();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(created,1);assert.equal(upgraded,1);assert.equal(activated,1);
  assert(stored>=START+2*STREAM_REPROBE_MS);
  assert.equal(tasks.length,0,'The original REST poller must stop after promotion');
  assert.equal(frames.at(-1),'new-stream');
});

test('failed stream reprobe does not interrupt existing REST trade polling',async()=>{
  let current=START,attempts=0,seen=0;
  const tasks=[];
  const socket=await createKrakenRestFeed({now:()=>current,
    schedule:(fn,ms)=>{const task={fn,at:current+ms};tasks.push(task);return task;},
    cancel:task=>{const i=tasks.indexOf(task);if(i>=0)tasks.splice(i,1);},
    pace:async ms=>{current+=ms;},
    fetchImpl:async url=>Response.json({error:[],result:{[new URL(url).searchParams.get('pair').replace(/USD$/,'')+'/USD']:[['1.23','1',current/1000,'b','l','',1]]}}),
    probeStream:async()=>{attempts++;return null;},
    onUpgrade:()=>{throw Error('Should not upgrade without a stream');},
    loadProbeAt:async()=>START+STREAM_REPROBE_MS,
    onMessage:raw=>{if(JSON.parse(raw).channel==='ticker')seen++;}
  });
  current=START+STREAM_REPROBE_MS+1000;
  await tasks.shift().fn();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(attempts,1);assert(seen>=12,'REST continues providing timestamped ticks');
  assert(tasks.length>0,'REST must remain scheduled after a failed probe');
  socket.close();
});
