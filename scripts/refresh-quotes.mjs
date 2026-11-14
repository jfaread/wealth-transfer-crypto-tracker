import {mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {COINS,mergeQuotes,createClient} from './market-data-core.mjs';
await mkdir('data',{recursive:true});let previous={};
try{const old=JSON.parse(await readFile('data/quotes.json','utf8'));if(old.version===1)previous=old;}catch{}
const query=new URLSearchParams({ids:Object.values(COINS).join(','),vs_currencies:'usd',include_last_updated_at:'true',precision:'full'});
let incoming={},received=false;
try{incoming=await createClient()('https://api.coingecko.com/api/v3/simple/price?'+query);received=true;}catch(e){console.warn('Current quote refresh unavailable; retaining validated provider timestamps:',e.message);}
const now=Date.now(),quotes=mergeQuotes(previous.quotes,incoming,now),missing=Object.entries(COINS).filter(([,id])=>!quotes[id]).map(([symbol])=>symbol);
if(!received&&JSON.stringify(quotes)===JSON.stringify(previous.quotes)){
 console.log('No newer quotes; the existing check time and data remain unchanged.');
}else if(Object.keys(quotes).length){
 const value={version:1,checkedAt:received?now:(previous.checkedAt||0),lastAttemptAt:now,quotes,unavailable:missing};
 await writeFile('data/quotes.json.tmp',JSON.stringify(value));await rename('data/quotes.json.tmp','data/quotes.json');
 console.log('Saved',Object.keys(quotes).length,'fresh timestamped quotes; unavailable:',missing.join(',')||'none');
}else console.warn('No fresh quotes available; kept the previous dated file. Browsers reject stale observations.');
