import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {dirname} from 'node:path';
const parts=await Promise.all(Array.from({length:7},(_,i)=>readFile('.maintenance/feed-hardening.'+(i+1),'utf8')));
const packed=Buffer.from(parts.join(''),'base64');
if(createHash('sha256').update(packed).digest('hex')!=='a49d9da86f8537cc2392c9aa1268a0d93b5c0756017fbb813fe369e40a3d27a9')throw Error('Hardening packet integrity mismatch; no source changed');
const packet=JSON.parse(gunzipSync(packed,{maxOutputLength:200000}));
const allowed=['scripts/market-data-core.mjs','scripts/market-client.mjs','scripts/refresh-quotes.mjs','scripts/refresh-market-data.mjs','scripts/build-site.mjs','scripts/verify-market-publication.mjs','index.html','scripts/test-fast-load.cjs','tests/market-client-hardening.test.mjs','tests/snapshot-hardening.test.mjs','tests/browser-data-hardening.test.mjs'];
if(packet.version!==1||JSON.stringify(packet.files.map(f=>f.path))!==JSON.stringify(allowed))throw Error('Unexpected hardening targets');
const hash=text=>{const b=Buffer.from(text);return createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');};
const outputs=[];
for(const file of packet.files){
 let content;
 if(file.oldSha){if(!(await lstat(file.path)).isFile())throw Error('Non-file source');content=await readFile(file.path,'utf8');if(hash(content)!==file.oldSha)throw Error('Source changed: '+file.path);for(const e of [...file.edits].reverse())content=content.slice(0,e.start)+e.text+content.slice(e.end);}
 else{try{await lstat(file.path);throw Error('New target already exists: '+file.path);}catch(e){if(e.code!=='ENOENT')throw e;}content=file.content;}
 if(hash(content)!==file.newSha)throw Error('Output integrity mismatch: '+file.path);outputs.push([file.path,content]);
}
for(const [path,text] of outputs){await mkdir(dirname(path),{recursive:true});await writeFile(path,text);}
console.log('Applied '+outputs.length+' integrity-checked source and test files; alert service unchanged.');
