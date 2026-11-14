import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient,providerState} from './market-data-core.mjs';

/** Both updater scripts share this file; the workflow serialises executions. */
export async function createMarketClient({stateFile=new URL('../data/provider-state.json',import.meta.url),...options}={}){
 const path=stateFile instanceof URL?fileURLToPath(stateFile):stateFile;
 await mkdir(dirname(path),{recursive:true});
 let state={};
 try{const text=await readFile(path,'utf8');if(text.length>2048)throw Error('Provider state is too large');state=providerState(JSON.parse(text));}
 catch(e){if(e.code!=='ENOENT')throw Error('Provider timing state cannot be verified; no requests were sent');}
 return createClient({...options,state,saveState:async value=>{
  const temp=path+'.tmp';await writeFile(temp,JSON.stringify(providerState(value))+'\n',{mode:0o600});await rename(temp,path);
 }});
}
