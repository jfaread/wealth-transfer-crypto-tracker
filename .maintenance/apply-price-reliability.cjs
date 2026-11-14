const fs=require('node:fs'),cp=require('node:child_process');
for(const [file,sha]of Object.entries({'index.html':'1f75c7baf0db12b4bfd5cfc78406dc5be077589c','scripts/build-site.mjs':'36ad56d3fd954435002e1def45ebc05a0bc122cd','scripts/refresh-market-data.mjs':'6d685e8480249398b6cd312e18447c00e17454df','scripts/refresh-quotes.mjs':'7bc4772844cbfbdf2ac10687dd6f17491e31ec7b'}))if(cp.execFileSync('git',['hash-object',file],{encoding:'utf8'}).trim()!==sha)throw Error('Source changed; refusing to overwrite '+file);
function edit(file,from,to){const s=fs.readFileSync(file,'utf8');if(s.split(from).length!==2)throw Error('Ambiguous change in '+file+': '+from);fs.writeFileSync(file,s.replace(from,to));}
function section(file,start,end,replacement){const s=fs.readFileSync(file,'utf8'),a=s.indexOf(start),b=s.indexOf(end,a+1);if(a<0||b<0)throw Error('Missing section');fs.writeFileSync(file,s.slice(0,a)+replacement+'\n'+s.slice(b));}
for(const name of ['refresh-market-data.mjs','refresh-quotes.mjs'])fs.renameSync('.maintenance/'+name,'scripts/'+name);
section('index.html','async function fetchAggregate(','async function fetchCoin(',fs.readFileSync('.maintenance/fetch-aggregate.txt','utf8'));
section('index.html','async function repairChartHistory(','function validCurrentQuotes(',fs.readFileSync('.maintenance/repair-history.txt','utf8'));
edit('index.html','data.push([id,{id,base,points,gaps,asOf:now}]);','data.push([id,{id,base,points,gaps,asOf:now,historySavedAt:d.historySavedAt||bundle.spec.historySavedAt||bundle.savedAt,historyObservedAt:d.historyObservedAt}]);');
edit('index.html',"const old=now-bundle.spec.historySavedAt>7200000;$('warning').hidden=!old;$('warning').textContent=old?'Current prices updated. History provider is delayed (last history: '+dateText(bundle.spec.historySavedAt)+' '+zoneLabel()+'). Refresh prices retries history automatically.':'';return;", "const delayed=state.coins.filter(id=>now-(available.get(id)?.historySavedAt||bundle.spec.historySavedAt)>7200000);const old=delayed.length>0;$('warning').hidden=!old;$('warning').textContent=old?'Current prices updated. Chart history is delayed for '+delayed.join(', ')+'. Successful history repairs are kept; missing observations remain gaps. Refresh prices retries the remaining history.':'';return;");
// Build a common genuine period, rather than silently omitting the one coin
// whose provider history lags behind the others. Current quotes are separate.
edit('scripts/build-site.mjs',"const end=Math.max(...Object.values(items).flatMap(x=>['31','365'].map(k=>x.prices[k].at(-1)[0])));","const end=Math.min(...COIN_IDS.map(id=>items[id].prices['31'].at(-1)[0]));");
edit('scripts/build-site.mjs','data.push([id,{id,base,points,gaps,asOf:manifest.updatedAt}]);','data.push([id,{id,base,points,gaps,asOf:manifest.updatedAt,historySavedAt:items[id].windowUpdatedAt?.[step===HOUR?31:365]??items[id].updatedAt}]);');
edit('scripts/test-fast-load.cjs','b.spec.historySavedAt=aged;}','b.spec.historySavedAt=aged;for(const [,d]of b.data)d.historySavedAt=aged;}');
edit('scripts/test-fast-load.cjs','x.spec.historySavedAt=aged;}','x.spec.historySavedAt=aged;for(const [,d]of x.data)d.historySavedAt=aged;}');
edit('scripts/test-fast-load.cjs','assert.equal(slow.calls.history,2);','assert(slow.calls.history>=2&&slow.calls.history<=3,"Only the two bounded repair lanes may run before the shared deadline");');
edit('scripts/test-fast-load.cjs',"if(settings.history==='fresh')await fulfilHistory(route);", "if(settings.history==='fresh'||settings.history==='partial'&&!u.pathname.includes('/crepe-2/'))await fulfilHistory(route);");
edit('scripts/test-fast-load.cjs',' // The history deadline covers the whole repair, not a new 15 seconds for each coin.',` // A failed token cannot discard eight successful repairs, or redownload them on retry.
 const partial=await openRefreshPage({history:'partial'});
 await partial.page.locator('#refresh').click();await waitForRefresh(partial.page);
 const savedPartial=await partial.page.evaluate(()=>JSON.parse(localStorage.getItem('wtct:v3:range:1D')));
 assert(savedPartial.data.find(([id])=>id==='BTC')[1].historySavedAt>aged);
 assert.equal(savedPartial.data.find(([id])=>id==='CREPE')[1].historySavedAt,aged);
 assert.match(await partial.page.locator('#warning').innerText(),/CREPE/);
 const repairedCalls=partial.calls.history;partial.settings.history='fresh';
 await partial.page.locator('#refresh').click();await waitForRefresh(partial.page);
 assert.equal(partial.calls.history-repairedCalls,1,'Retry only the missing token history');
 assert(await partial.page.locator('#warning').isHidden());await partial.page.close();
 // The history deadline covers the whole repair, not a new 15 seconds for each coin.`);
console.log(cp.execFileSync('git',['diff','--stat'],{encoding:'utf8'}));
