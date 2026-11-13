import {writeFile} from 'node:fs/promises';
import {generateVAPIDKeys} from 'web-push';

// Run only when configuring the owner's chosen Worker account. Never print keys,
// replace a live key pair or add this ignored private file to source control.
const keys=generateVAPIDKeys();
const destination=new URL('../alerts/.secrets.json',import.meta.url);
try{
 await writeFile(destination,JSON.stringify({
  VAPID_PUBLIC_KEY:keys.publicKey,
  VAPID_PRIVATE_KEY:keys.privateKey,
  VAPID_SUBJECT:'https://jfaread.github.io/wealth-transfer-crypto-tracker/'
 },null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log('Created the dedicated key pair in ignored alerts/.secrets.json with owner-only file permissions. No key values have been printed.');
}catch(error){
 if(error.code==='EEXIST')throw new Error('An alert key file already exists. It has not been replaced; reuse the existing keys for connected devices.');
 throw new Error('The private alert key file could not be saved. No keys have been printed.');
}
