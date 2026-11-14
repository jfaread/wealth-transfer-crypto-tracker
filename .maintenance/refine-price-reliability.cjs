const fs=require('node:fs');
function edit(file,from,to){const s=fs.readFileSync(file,'utf8');if(s.split(from).length!==2)throw Error('Ambiguous refinement: '+file);fs.writeFileSync(file,s.replace(from,to));}
edit('scripts/market-data-core.mjs','spacing=7500','spacing=15000');
edit('tests/market-data-core.test.mjs','assert.equal(time-now,7500);','assert.equal(time-now,15000);');
edit('scripts/market-data-core.mjs','return {...item,prices:{...item.prices,[days]:prices},windowUpdatedAt,updatedAt:windowUpdatedAt[31]};',`// Retain only genuine older observations needed at the rolling window edge.
 const prefix=Array.isArray(old)?old.filter(p=>p[0]<prices[0][0]&&p[0]>=now-(days+2)*24*HOUR):[];
 const merged=[...prefix,...prices];validPrices(merged,now);
 return {...item,prices:{...item.prices,[days]:merged},windowUpdatedAt,updatedAt:windowUpdatedAt[31]};`);
fs.appendFileSync('tests/market-data-core.test.mjs',`\ntest('a refreshed rolling window keeps genuine older edge observations for a lagging comparison',()=>{const previous={...old,prices:{...old.prices,31:[[now-32*24*HOUR,1],[now-31*24*HOUR,2],...rows]}};const replacement=[[now-31*24*HOUR+6*HOUR,3],...rows];const next=acceptWindow(previous,31,replacement,now);assert.deepEqual(next.prices[31].slice(0,2),previous.prices[31].slice(0,2));assert.deepEqual(next.prices[31].slice(2),replacement);validPrices(next.prices[31],now);});\n`);
edit('.maintenance/refresh-market-data.mjs','// Publication still has to possess',`// One bounded recovery round honours the provider's requested pause. It retries
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
// Publication still has to possess`);
