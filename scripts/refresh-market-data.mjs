import {mkdir,writeFile,readFile} from 'node:fs/promises';
const coins={BTC:'bitcoin',ETH:'ethereum',BNB:'binancecoin',XRP:'ripple',SOL:'solana',KISHU:'kishu-inu',WKC:'wiki-cat',CREPE:'crepe-2'};
await mkdir('data',{recursive:true});
try{const manifest=JSON.parse(await readFile('data/manifest.json','utf8'));if(Date.now()-manifest.updatedAt<(process.env.REUSE_MARKET_DATA==='true'?1800000:900000)&&manifest.updatedAt<=Date.now()+300000){for(const symbol of Object.keys(coins)){const item=JSON.parse(await readFile('data/'+symbol+'.json','utf8'));if(item.id!==coins[symbol]||!Array.isArray(item.prices?.[31]))throw Error('Incomplete cache');}console.log('Reusing verified snapshot for this deployment.');process.exit(0);}}catch{}
let lastRequest=0;const outputs=[];
async function get(url){for(let attempt=0;attempt<3;attempt++){const delay=Math.max(0,7500-(Date.now()-lastRequest));await new Promise(r=>setTimeout(r,delay));lastRequest=Date.now();const r=await fetch(url,{signal:AbortSignal.timeout(30000)});if(r.status===429){await new Promise(r=>setTimeout(r,60000));continue;}if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(!Array.isArray(j.prices)||j.prices.length<2||j.prices.length>5000)throw Error('Missing prices');let previous=0;for(const p of j.prices){if(!Array.isArray(p)||p.length!==2||!Number.isSafeInteger(p[0])||p[0]<=previous||!Number.isFinite(p[1])||p[1]<=0)throw Error('Invalid prices');previous=p[0];}return j.prices;}throw Error('Rate limit persisted');}
for(const [symbol,id] of Object.entries(coins)){
 const item={symbol,id,updatedAt:Date.now(),prices:{}};
 for(const days of [31,365]){try{item.prices[days]=await get(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`);}catch(e){console.error(symbol,days,e.message);try{const old=JSON.parse(await readFile(`data/${symbol}.json`,'utf8'));if(Date.now()-old.updatedAt<7200000&&old.prices[days])item.prices[days]=old.prices[days];item.updatedAt=Math.min(item.updatedAt,old.updatedAt);}catch{}}}
 if(!item.prices[31])throw Error('No current one-day prices for '+symbol);
 outputs.push(item);console.log('Verified',symbol,Object.keys(item.prices).join(',')+' day windows');
}
const asOf=Math.min(...outputs.map(x=>x.prices[31].at(-1)[0]));
if(Date.now()-asOf>7200000||asOf>Date.now()+300000)throw Error('Stale/inconsistent snapshot');
for(const item of outputs)await writeFile(`data/${item.symbol}.json`,JSON.stringify(item));
await writeFile('data/manifest.json',JSON.stringify({version:1,asOf,updatedAt:Math.min(...outputs.map(x=>x.updatedAt)),source:'CoinGecko aggregate USD',coins:Object.keys(coins)}));
console.log('Saved verified aggregate history for',outputs.length,'coins at',new Date(asOf).toISOString());

