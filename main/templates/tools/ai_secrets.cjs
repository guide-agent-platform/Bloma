// Backend-only adapter. Caller must supply the product's trusted OS/keyring codec.
// No plaintext fallback; this helper does not prove that an injected codec is secure.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto')
function createSecretStore({dataDir,encrypt,decrypt}){
 if(typeof encrypt!=='function'||typeof decrypt!=='function')throw Error('AI_SECRET_CODEC_REQUIRED')
 const root=fs.realpathSync(dataDir),directory=path.join(root,'.ai-secrets');fs.mkdirSync(directory,{recursive:true,mode:0o700})
 if(fs.lstatSync(directory).isSymbolicLink()||fs.realpathSync(directory)!==directory)throw Error('AI_SECRET_PATH_INVALID')
 const file=name=>{if(typeof name!=='string'||!/^APP_[A-Z0-9_]{1,80}$/.test(name))throw Error('AI_SECRET_NAME_INVALID');return path.join(directory,name+'.bin')}
 const check=target=>{const info=fs.lstatSync(target);if(info.isSymbolicLink()||!info.isFile()||info.size>16384)throw Error('AI_SECRET_FILE_INVALID')}
 return{
  has(name){const target=file(name);if(!fs.existsSync(target))return false;check(target);return true},
  get(name){const target=file(name);if(!fs.existsSync(target))return undefined;check(target);const value=decrypt(fs.readFileSync(target));if(typeof value!=='string')throw Error('AI_SECRET_DECODE_FAILED');return value},
  set(name,key){
   const target=file(name);if(typeof key!=='string'||!key.trim()||Buffer.byteLength(key)>8192)throw Error('AI_SECRET_VALUE_INVALID')
   if(fs.existsSync(target))check(target)
   const value=encrypt(key);if(!Buffer.isBuffer(value)||!value.length||value.length>16384||value.equals(Buffer.from(key)))throw Error('AI_SECRET_ENCODE_FAILED')
   const temporary=path.join(directory,randomUUID()+'.tmp'),descriptor=fs.openSync(temporary,'wx',0o600)
   try{try{fs.writeFileSync(descriptor,value);fs.fsyncSync(descriptor)}finally{fs.closeSync(descriptor)}fs.renameSync(temporary,target)}finally{fs.rmSync(temporary,{force:true})}
   return{saved:true}
  }
 }
}
module.exports={createSecretStore}
