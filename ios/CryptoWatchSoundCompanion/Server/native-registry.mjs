/**
 * Native APNs registration - deliberately separate from existing Web Push records.
 * Not routed by the production Worker until its APNs credentials are provisioned.
 *
 * A web device with its existing bearer token must initiate pairing. The native
 * iPhone then redeems a 256-bit one-use code over TLS. Do not place codes in URLs,
 * push bodies, logs or a public static file. All operations are serialised.
 */
const PREFIX='cw-native-v1:';
const TTL=5*60*1000, DEVICE_TTL=90*86400000, MAX_DEVICES_PER_OWNER=2;
const textEncoder=new TextEncoder();
const B64_TOKEN=/^[a-f0-9]{64}$/i, UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const cleanAPNs=value=> {
  if(typeof value!=='string'||!(/^[0-9a-f]{64,256}$/i.test(value))||value.length%2)throw Error('Invalid APNs device token');
  return value.toLowerCase();
};
const defaultCrypto=globalThis.crypto;
async function sha(value,cryptoImpl){
  const out=new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',textEncoder.encode(value)));
  return [...out].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function constantEqual(a,b){
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;
}
function newSecret(cryptoImpl){
  const b=cryptoImpl.getRandomValues(new Uint8Array(32));
  return [...b].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function day(now){return new Date(now).toISOString().slice(0,10);}
export const NATIVE_MAX_PER_OWNER=MAX_DEVICES_PER_OWNER;
export class NativeRegistrationStore{
  constructor({storage,ownerExists,cryptoImpl=defaultCrypto,now=()=>Date.now(),environment='production'}={}){
    if(!storage||typeof storage.get!=='function'||typeof storage.put!=='function'||typeof storage.delete!=='function'||typeof storage.list!=='function'||typeof storage.transaction!=='function')throw Error('Secure storage is required');
    if(typeof ownerExists!=='function')throw Error('Owner verification is required');
    if(!['production','sandbox'].includes(environment))throw Error('Invalid APNs environment');
    this.storage=storage;this.ownerExists=ownerExists;this.crypto=cryptoImpl;this.now=now;this.environment=environment;
    this.queue=Promise.resolve();
  }
  locked(work){const next=this.queue.then(work,work);this.queue=next.catch(()=>{});return next;}
  key(name){return PREFIX+name;}
  async devices(ownerId){
    const entries=await this.storage.list({prefix:this.key('device:')});
    return [...entries.values()].filter(v=>v.ownerId===ownerId&&v.revoked!==true&&
      Number.isSafeInteger(v.updatedAt)&&this.now()-v.updatedAt<DEVICE_TTL);
  }
  async createPairing(ownerId){
    return this.locked(async()=>{
      if(typeof ownerId!=='string'||!UUID.test(ownerId)||!await this.ownerExists(ownerId))throw Error('Device is not authorised');
      const current=await this.devices(ownerId);
      if(current.length>=MAX_DEVICES_PER_OWNER)throw Error('Native device limit reached');
      const now=this.now(),rateKey=this.key('rate:'+ownerId+':'+day(now));
      const rate=await this.storage.get(rateKey)||{count:0};
      if(rate.count>=5)throw Error('Native pairing requests are limited');
      const code=newSecret(this.crypto),codeHash=await sha(code,this.crypto);
      const expiry=now+TTL,record={ownerId,codeHash,issuedAt:now,expiresAt:expiry};
      const old=await this.storage.get(this.key('activePair:'+ownerId));
      await this.storage.transaction(async tx=>{
        if(old?.hash)await tx.delete(this.key('pair:'+old.hash));
        await tx.put(this.key('pair:'+codeHash),record);
        await tx.put(this.key('activePair:'+ownerId),{hash:codeHash,expiresAt:expiry});
        await tx.put(rateKey,{count:rate.count+1});
      });
      return {pairingCode:code,expiresAt:expiry};
    });
  }
  async redeemPairing({pairingCode,apnsToken,environment}={}){
    return this.locked(async()=>{
      if(typeof pairingCode!=='string'||!B64_TOKEN.test(pairingCode))throw Error('Pairing code is invalid or expired');
      const token=cleanAPNs(apnsToken);
      if(environment!==this.environment)throw Error('APNs environment does not match this app');
      const codeHash=await sha(pairingCode.toLowerCase(),this.crypto);
      const pair=await this.storage.get(this.key('pair:'+codeHash));
      if(!pair||pair.expiresAt<=this.now()||!constantEqual(pair.codeHash,codeHash)||!await this.ownerExists(pair.ownerId))throw Error('Pairing code is invalid or expired');
      const already=await this.devices(pair.ownerId);
      if(already.length>=MAX_DEVICES_PER_OWNER||already.some(d=>d.apnsToken===token))throw Error('Native device is already paired or limit reached');
      const id=this.crypto.randomUUID(),secret=newSecret(this.crypto),tokenHash=await sha(secret,this.crypto),when=this.now();
      const record={id,ownerId:pair.ownerId,apnsToken:token,tokenHash,environment:this.environment,
        createdAt:when,updatedAt:when,revision:0,revoked:false,usage:{day:day(when),count:0}};
      await this.storage.transaction(async tx=>{
        await tx.put(this.key('device:'+id),record);
        await tx.delete(this.key('pair:'+codeHash));
        await tx.delete(this.key('activePair:'+pair.ownerId));
      });
      return {deviceId:id,bearer:id+'.'+secret,environment:this.environment,connected:true};
    });
  }
  async authorised(bearer){
    if(typeof bearer!=='string')throw Error('Native device not authorised');
    const match=/^([0-9a-f-]{36})\.([a-f0-9]{64})$/i.exec(bearer);
    if(!match||!UUID.test(match[1]))throw Error('Native device not authorised');
    const record=await this.storage.get(this.key('device:'+match[1]));
    const value=await sha(match[2].toLowerCase(),this.crypto);
    if(!record||record.revoked||this.now()-record.updatedAt>=DEVICE_TTL||
      !constantEqual(value,record.tokenHash)||!await this.ownerExists(record.ownerId))throw Error('Native device not authorised');
    return record;
  }
  async refresh(bearer,apnsToken){
    return this.locked(async()=>{
      const record=await this.authorised(bearer),token=cleanAPNs(apnsToken);
      const collision=(await this.devices(record.ownerId)).some(d=>d.id!==record.id&&d.apnsToken===token);
      if(collision)throw Error('Native device token already registered');
      const updated={...record,apnsToken:token,revision:record.revision+1,updatedAt:this.now()};
      await this.storage.put(this.key('device:'+updated.id),updated);
      return {deviceId:updated.id,connected:true,environment:updated.environment};
    });
  }
  async revoke(bearer){
    return this.locked(async()=>{
      const record=await this.authorised(bearer);
      await this.storage.delete(this.key('device:'+record.id));
      return {deleted:true};
    });
  }
  async revokeOwner(ownerId){
    return this.locked(async()=>{
      const found=await this.storage.list({prefix:this.key('device:')});
      const pair=await this.storage.get(this.key('activePair:'+ownerId));
      await this.storage.transaction(async tx=>{
        for(const [key,record] of found)if(record.ownerId===ownerId)await tx.delete(key);
        if(pair?.hash)await tx.delete(this.key('pair:'+pair.hash));
        await tx.delete(this.key('activePair:'+ownerId));
      });
    });
  }
  /** Secrets do not belong in UI status responses, logs or public JSON. */
  async publicStatus(bearer){
    const record=await this.authorised(bearer);
    return {connected:true,deviceId:record.id,environment:record.environment,updatedAt:record.updatedAt};
  }
}
