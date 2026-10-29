// Record-before-effect inbox. Pending deliveries require reconciliation after a
// crash; this is not an exactly-once transaction with an external business store.
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto')
const {verifyWebhook}=require('./http_connector.cjs')
const hash=value=>createHash('sha256').update(value).digest('hex')
function createWebhookInbox(dataDir) {
  const root=fs.realpathSync(dataDir),directory=path.join(root,'.webhook-inbox')
  fs.mkdirSync(directory,{recursive:true})
  if(fs.lstatSync(directory).isSymbolicLink()||fs.realpathSync(directory)!==directory)throw Error('WEBHOOK_INBOX_PATH_INVALID')
  const read=file=>{if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>4096)throw Error('WEBHOOK_RECEIPT_INVALID');const row=JSON.parse(fs.readFileSync(file,'utf8'));if(row.version!==1||!['pending','done'].includes(row.state)||!/^[a-f0-9]{64}$/.test(row.bodyDigest)||typeof row.token!=='string')throw Error('WEBHOOK_RECEIPT_INVALID');return row}
  return {
    accept(input) {
      const verified=verifyWebhook(input)
      if(!verified.valid)return {accepted:false,kind:verified.kind}
      if(typeof input.eventId!=='string'||!input.eventId||input.eventId.length>200)throw Error('WEBHOOK_SIGNED_EVENT_ID_REQUIRED')
      const id=hash(input.eventId),file=path.join(directory,id+'.json'),bodyDigest=hash(input.rawBody)
      // Existing records are never discarded on age alone. Full inboxes require
      // an application retention policy; they cannot silently forget duplicates.
      const existing=()=>{const row=read(file);return {accepted:false,kind:row.bodyDigest!==bodyDigest?'event_id_conflict':row.state==='done'?'duplicate_done':'duplicate_pending'}}
      if(fs.existsSync(file))return existing()
      if(fs.readdirSync(directory).length>=10000)throw Error('WEBHOOK_INBOX_FULL')
      const row={version:1,state:'pending',bodyDigest,token:randomUUID(),at:new Date().toISOString()}
      let descriptor
      try{descriptor=fs.openSync(file,'wx');fs.writeFileSync(descriptor,JSON.stringify(row));fs.fsyncSync(descriptor)}
      catch(error){if(error.code==='EEXIST')return existing();throw error}
      finally{if(descriptor!==undefined)fs.closeSync(descriptor)}
      return {accepted:true,receipt:{id,token:row.token},state:'pending'}
    },
    markDone(receipt) {
      if(!receipt||!/^[a-f0-9]{64}$/.test(receipt.id))throw Error('WEBHOOK_RECEIPT_INVALID')
      const file=path.join(directory,receipt.id+'.json'),row=read(file)
      if(row.token!==receipt.token)throw Error('WEBHOOK_RECEIPT_OWNER_INVALID')
      if(row.state==='done')return {state:'done'}
      const temporary=path.join(directory,randomUUID()+'.tmp'),descriptor=fs.openSync(temporary,'wx')
      try{fs.writeFileSync(descriptor,JSON.stringify({...row,state:'done'}));fs.fsyncSync(descriptor)}finally{fs.closeSync(descriptor)}
      fs.renameSync(temporary,file)
      return {state:'done'}
    }
  }
}
module.exports={createWebhookInbox}
