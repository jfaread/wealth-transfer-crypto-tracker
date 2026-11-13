import {mkdir,writeFile} from 'node:fs/promises';
const coins={BTC:'bitcoin',ETH:'ethereum',BNB:'binancecoin',XRP:'ripple',SOL:'solana',KISHU:'kishu-inu',WKC:'wiki-cat',CREPE:'crepe-2'};
const q=new URLSearchParams({ids:Object.values(coins).join(','),vs_currencies:'usd',include_last_updated_at:'true',precision:'full'});
const response=await fetch('https://api.coingecko.com/api/v3/simple/price?'+q,{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('Current quote source returned HTTP '+response.status);
const quotes=await response.json(),now=Date.now();
for(const [symbol,id]of Object.entries(coins)){const quote=quotes[id],t=quote?.last_updated_at*1000;if(typeof quote?.usd!=='number'||!Number.isFinite(quote.usd)||quote.usd<=0||!Number.isSafeInteger(t)||t>now+300000||now-t>1800000)throw Error('No fresh, timestamped quote for '+symbol);}
await mkdir('data',{recursive:true});await writeFile('data/quotes.json',JSON.stringify({version:1,checkedAt:now,quotes}));
console.log('Verified current quotes for all eight coins at '+new Date(now).toISOString());
