// Public channel metadata only. Failure retains the last verified five entries.
import {readFile,writeFile,rename} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export const CHANNEL='UCXJQosNTxvmyd925enPbQPw';
export const SOURCE='https://www.youtube.com/feeds/videos.xml?channel_id='+CHANNEL;
const FILE=new URL('../data/jon-george.json',import.meta.url);
export function creatorPacket(packet,now=Date.now()){
 if(packet?.status!=='ok'||packet.feed?.url!==SOURCE||!Array.isArray(packet.items))throw Error('Unexpected public channel feed');
 const seen=new Set();
 const items=packet.items.slice(0,100).flatMap(item=>{
  const id=typeof item?.guid==='string'&&item.guid.match(/^yt:video:([A-Za-z0-9_-]{11})$/)?.[1];
  let date=typeof item?.pubDate==='string'?item.pubDate:'';
  if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date))date=date.replace(' ','T')+'Z';
  const publishedAt=Date.parse(date);
  const title=typeof item?.title==='string'?item.title.replace(/<[^>]*>/g,'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,260):'';
  if(!id||seen.has(id)||!title||!Number.isFinite(publishedAt)||publishedAt<=0||publishedAt>now+300000)return[];
  seen.add(id);return [{title,link:'https://www.youtube.com/watch?v='+id,publishedAt}];
 }).sort((a,b)=>b.publishedAt-a.publishedAt).slice(0,5);
 if(items.length!==5)throw Error('Five verified public video entries were not available');
 return {version:1,channelId:CHANNEL,sourceUrl:SOURCE,checkedAt:new Date(now).toISOString(),items};
}
export async function refreshCreator({fetchImpl=fetch}={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{
  const response=await fetchImpl('https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent(SOURCE),{headers:{Accept:'application/json'},redirect:'error',signal:controller.signal});
  if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('Public feed unavailable');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>256*1024){await reader.cancel();throw Error('Feed too large');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
  const next=creatorPacket(JSON.parse(text));
  try{const old=JSON.parse(await readFile(FILE,'utf8'));if(old.channelId===CHANNEL&&old.items?.[0]?.publishedAt>next.items[0].publishedAt)throw Error('The upstream feed is older than the saved copy');}catch(error){if(error.code!=='ENOENT')throw error;}
  const temp=new URL('../data/jon-george.json.tmp',import.meta.url);
  await writeFile(temp,JSON.stringify(next,null,2)+'\n');await rename(temp,FILE);
  console.log('Saved five verified public MyDefiGuru video links; checked '+next.checkedAt);return true;
 }catch{console.warn('Jon George feed refresh unavailable: keeping the last verified five updates and their original check time.');return false;}
 finally{clearTimeout(timer);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await refreshCreator();
