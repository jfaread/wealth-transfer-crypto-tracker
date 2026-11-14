import {mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {COINS,HOUR,validPrices,reusableWindow,acceptWindow} from './market-data-core.mjs';
import {createMarketClient} from './market-client.mjs';
await mkdir('data',{recursive:true});
const outputs=new Map(),failures=[],get=await createMarketClient();
for(const [symbol,id]of Object.entries(COINS)){
 let item;try{item=JSON.parse(await readFile(`data/${symbol}.json`,'utf8'));if(item.symbol!==symbol||item.id!==id)throw Error('Wrong token');for(const days of [31,365])validPrices(item.prices?.[days]);}catch{item={symbol,id,updatedAt:0,prices:{}};}
 outputs.set(symbol,item);
}
// Prioritise the recent chart for every coin before doing any yearly downloads.
for(const days of [31,365])for(const [symbol,id]of Object.entries(COINS)){
 let item=outputs.get(symbol);if(reusableWindow(item,days))continue;
 try{
  const packet=await get(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
  item=acceptWindow(item,days,packet?.prices);outputs.set(symbol,item);
  const path=`data/${symbol}.json`;await writeFile(path+'.tmp',JSON.stringify(item));await rename(path+'.tmp',path);
  console.log('Updated',symbol,days,'day history; last observation',new Date(item.prices[days].at(-1)[0]).toISOString());
 }catch(e){failures.push({symbol,days,error:e.message,...(e.retryAt?{retryAt:e.retryAt}:{})});console.warn('Retained original dated history:',symbol,days,e.message);}
}
// One bounded recovery round honours the provider's requested pause. It retries
// only failed windows, never the already saved successful coin histories.
const deferred=failures.filter(f=>f.retryAt),resume=Math.max(0,...deferred.map(f=>f.retryAt));
if(deferred.length&&resume-Date.now()<=120000){
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,resume-Date.now())));
 for(const failed of deferred){
  try{const id=COINS[failed.symbol],packet=await get('https://api.coingecko.com/api/v3/coins/'+id+'/market_chart?vs_currency=usd&days='+failed.days);
   const item=acceptWindow(outputs.get(failed.symbol),failed.days,packet?.prices);outputs.set(failed.symbol,item);
   const path='data/'+failed.symbol+'.json';await writeFile(path+'.tmp',JSON.stringify(item));await rename(path+'.tmp',path);
   failures.splice(failures.indexOf(failed),1);console.log('Recovered after provider cooldown:',failed.symbol,failed.days);
  }catch(e){failed.error=e.message;if(e.retryAt){failed.retryAt=e.retryAt;break;}}
 }
}
// Publication still has to possess genuine, validated histories. A failed fetch
// does not erase an older window or give it a new check timestamp.
for(const [symbol,item]of outputs)for(const days of [31,365]){try{validPrices(item.prices[days]);}catch{throw Error('No verified '+days+' day history is available for '+symbol);}}
const items=[...outputs.values()],now=Date.now();
const manifest={version:1,asOf:Math.min(...items.map(x=>x.prices[31].at(-1)[0])),updatedAt:Math.min(...items.map(x=>x.windowUpdatedAt?.[31]??x.updatedAt)),source:'CoinGecko aggregate USD',coins:Object.keys(COINS),lastAttemptAt:now,failures,coverage:Object.fromEntries(items.map(x=>[x.symbol,{lastObservedAt:x.prices[31].at(-1)[0],historyCheckedAt:x.windowUpdatedAt?.[31]??x.updatedAt}]))};
await writeFile('data/manifest.json.tmp',JSON.stringify(manifest));await rename('data/manifest.json.tmp','data/manifest.json');
console.log('Preserved',items.length,'independent histories;',failures.length,'provider failures; common coverage ends',new Date(manifest.asOf).toISOString());
