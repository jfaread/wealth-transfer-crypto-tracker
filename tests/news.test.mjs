import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
import {creatorPacket,SOURCE} from '../scripts/refresh-creator-updates.mjs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const feeds=html.match(/^const FEEDS=.*;$/m)[0];
const functions=html.slice(html.indexOf('function textOnly(value)'),html.indexOf('function syncNewsMotion(){'));
const context=vm.createContext({URL,Date,console});vm.runInContext(feeds+'\n'+functions+'\nglobalThis.helpers={cleanNews,feedItems,FEEDS};',context);
const {cleanNews,feedItems,FEEDS}=context.helpers;
const now=Date.now();
const video=(i,days=i)=>({title:'Public video '+i,link:'https://www.youtube.com/watch?v=video'+String(i).padStart(6,'0'),publishedAt:now-days*86400000});
const packet={status:'ok',feed:{url:SOURCE},items:Array.from({length:6},(_,i)=>({title:'Public video '+i,link:'https://rss2json.com/to/opaque-'+i,guid:'yt:video:video'+String(i).padStart(6,'0'),pubDate:new Date(now-i*86400000).toISOString()}))};
test('redirect-wrapped creator videos resolve only to direct YouTube links from the pinned feed',()=>{
 const items=cleanNews(feedItems(FEEDS[2],packet));assert.equal(items.length,5);assert(items.every(x=>x.link.startsWith('https://www.youtube.com/watch?v=')));
 assert.throws(()=>feedItems(FEEDS[2],{...packet,feed:{url:SOURCE+'wrong'}}));
 assert.equal(feedItems(FEEDS[2],{...packet,items:[{...packet.items[0],guid:'yt:video:../../secret'}]}).length,0);
 assert.equal(feedItems(FEEDS[2],{...packet,items:[{...packet.items[0],link:video(2).link}]}).length,0);
});
test('five creator updates are independent of the thirty-headline cap and a thirty-day cutoff',()=>{
 const general=Array.from({length:50},(_,i)=>({title:'Market '+i,link:'https://www.coindesk.com/news/'+i,publishedAt:now-i*1000}));
 const items=cleanNews([...general,...Array.from({length:7},(_,i)=>video(i,40+i))]);
 assert.equal(items.filter(x=>x.source===FEEDS[2].name).length,5);assert.equal(items.length,35);
 assert.deepEqual(Array.from(items.filter(x=>x.source===FEEDS[2].name),x=>x.title),['Public video 0','Public video 1','Public video 2','Public video 3','Public video 4']);
});
test('merging a partial publisher refresh preserves all five saved creator cards',()=>{
 const saved=Array.from({length:5},(_,i)=>video(i));const fresh=[{title:'Fresh market report',link:'https://cointelegraph.com/news/fresh',publishedAt:now}];
 assert.equal(cleanNews([...fresh,...saved]).filter(x=>x.source===FEEDS[2].name).length,5);
});
test('unknown origins, misleading YouTube paths, future dates and duplicate cards are rejected',()=>{
 const rows=[video(1),video(1),{...video(2),link:'https://evil.invalid/watch?v=video000002'},{...video(3),link:'https://www.youtube.com/redirect?v=video000003'},{...video(4),publishedAt:now+600001}];
 assert.equal(cleanNews(rows).length,1);
});
test('publisher redirect links are restored only through matching canonical GUID hosts',()=>{
 const news={status:'ok',feed:{url:FEEDS[0].url},items:[{title:'A headline',link:'https://rss2json.com/to/opaque',guid:'https://www.coindesk.com/news/example',publishedAt:now}]};
 assert.equal(feedItems(FEEDS[0],news)[0].link,news.items[0].guid);
 assert.equal(feedItems(FEEDS[0],{...news,items:[{...news.items[0],guid:'https://attacker.invalid/'}]}).length,0);
});
test('the published creator snapshot requires five distinct dated entries from the exact channel',()=>{
 const data=creatorPacket(packet,now);assert.equal(data.items.length,5);assert.equal(data.sourceUrl,SOURCE);
 assert.throws(()=>creatorPacket({...packet,feed:{url:'https://example.invalid/'}},now));
 assert.throws(()=>creatorPacket({...packet,items:packet.items.slice(0,4)},now));
 assert.throws(()=>creatorPacket({...packet,items:Array(6).fill(packet.items[0])},now));
});
