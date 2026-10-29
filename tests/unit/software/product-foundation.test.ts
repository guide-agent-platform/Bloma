import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {beforeEach,afterEach,it,expect} from 'vitest'
const require=createRequire(import.meta.url)
let root:string,createDataStore:any,createJobQueue:any,recoverJobLock:any
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'bloma-product-foundation-'));for(const [folder,file]of [['data-store','product_store.cjs'],['jobs','product_jobs.cjs']])copyFileSync(resolve('main/templates/components',folder,file),join(root,file));({createDataStore}=require(join(root,'product_store.cjs')));({createJobQueue,recoverJobLock}=require(join(root,'product_jobs.cjs')))})
afterEach(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
async function until(fn:()=>boolean){const deadline=Date.now()+5000;while(!fn()){if(Date.now()>deadline)throw Error('WAIT_TIMEOUT');await new Promise(done=>setTimeout(done,10))}}
it('keeps same-name records distinct, rejects stale/entity/reference writes and failed writes preserve exact bytes',()=>{
 const store=createDataStore({dataDir:root}),first=store.commit(0,[{id:'a',type:'note',expectedRevision:0,data:{name:'同名',text:'A'}},{id:'b',type:'note',expectedRevision:0,data:{name:'同名',text:'B'},refs:['a']}])
 expect(first.records.a.id).not.toBe(first.records.b.id)
 expect(()=>store.commit(0,[{id:'c',type:'note',expectedRevision:0,data:{}}])).toThrow('STALE')
 expect(()=>store.commit(1,[{id:'a',type:'note',expectedRevision:0,data:{}}])).toThrow('ENTITY_STALE')
 expect(()=>store.commit(1,[{id:'a',expectedRevision:1,delete:true}])).toThrow('RECORD_INVALID')
 expect(()=>store.commit(1,[{id:'c',type:'note',expectedRevision:0,data:{},refs:['missing']}])).toThrow('RECORD_INVALID')
 const file=join(root,'records.json'),before=readFileSync(file)
 writeFileSync(file+'.lock','other writer');expect(()=>store.commit(1,[{id:'a',type:'note',expectedRevision:1,data:{text:'bad'}}])).toThrow();rmSync(file+'.lock')
 expect(readFileSync(file)).toEqual(before)
 const reopened=JSON.parse(execFileSync(process.execPath,['-e',`console.log(JSON.stringify(require('./product_store.cjs').createDataStore({dataDir:process.cwd()}).read()))`],{cwd:root,encoding:'utf8'}))
 expect(reopened).toEqual(first)
})
it('validates backup checksum and references, preserves source on migration failure and keeps pre-upgrade copies',()=>{
 const one=createDataStore({dataDir:root});one.commit(0,[{id:'a',type:'note',expectedRevision:0,data:{text:'original'}}]);const backup=one.backup()
 one.commit(1,[{id:'a',type:'note',expectedRevision:1,data:{text:'changed'}}])
 expect(()=>one.restore(2,{...backup,checksum:'bad'})).toThrow('BACKUP_INVALID');expect(one.read().records.a.data.text).toBe('changed')
 expect(one.restore(2,backup).records.a.data.text).toBe('original')
 const two=createDataStore({dataDir:root,schemaVersion:2}),before=readFileSync(join(root,'records.json'))
 expect(()=>two.read()).toThrow('SCHEMA_INVALID');expect(()=>two.migrate({fromVersion:1,expectedRevision:3,transform:()=>{throw Error('MIGRATION_FAILED')}})).toThrow('MIGRATION_FAILED')
 expect(readFileSync(join(root,'records.json'))).toEqual(before)
 const result=two.migrate({fromVersion:1,expectedRevision:3,transform:(state:any)=>({...state,schema_version:2})});expect(result.revision).toBe(4)
 expect(readdirSync(root).some(file=>file.startsWith('records-before-migration'))).toBe(true)
})
it('cancels only A, rejects late updates, drains B after failure and deduplicates logical submissions',async()=>{
 let releaseA:()=>void=()=>{},late:any
 const queue=createJobQueue({dataDir:root,concurrency:2,handlers:{slow:async(_:any,ctx:any)=>{late=ctx;await new Promise<void>(done=>releaseA=done);ctx.progress(.9);return 'late'},fast:async()=> 'B',fail:async()=>{throw Error('PRIVATE ERROR SHOULD NOT LEAK')}}})
 try{
  const a=queue.enqueue({type:'slow',dedupeKey:'a'}),b=queue.enqueue({type:'fast',dedupeKey:'b'})
  expect(queue.enqueue({type:'fast',dedupeKey:'b'}).id).toBe(b.id)
  expect(()=>queue.enqueue({type:'fail',dedupeKey:'b'})).toThrow('DEDUPE_CONFLICT')
  await until(()=>queue.list().find((row:any)=>row.id===a.id)?.state==='running');queue.cancel(a.id)
  expect(queue.list().find((row:any)=>row.id===a.id).state).toBe('cancelling');releaseA()
  await until(()=>queue.list().some((row:any)=>row.id===a.id&&row.state==='cancelled'))
  expect(late.progress(.5)).toBe(false);expect(queue.list().find((row:any)=>row.id===b.id).state).toBe('succeeded')
  const bad=queue.enqueue({type:'fail',dedupeKey:'bad'}),next=queue.enqueue({type:'fast',dedupeKey:'next'})
  await until(()=>queue.list().find((row:any)=>row.id===next.id)?.state==='succeeded')
  expect(queue.list().find((row:any)=>row.id===bad.id).error).toBe('TASK_FAILED')
 }finally{releaseA();await queue.close()}
})
it('detects a real killed worker, recovers only a dead owner, preserves checkpoints and requires side-effect review',async()=>{
 const child=spawn(process.execPath,['-e',`const q=require('./product_jobs.cjs').createJobQueue({dataDir:process.cwd(),handlers:{write:async(_,ctx)=>{ctx.saveCheckpoint({step:1});ctx.beginEffect();console.log('READY');await new Promise(()=>{})}}});q.enqueue({type:'write',dedupeKey:'effect'});setInterval(()=>{},1000)`],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']})
 try{
  await new Promise<void>((done,fail)=>{const timer=setTimeout(()=>fail(Error('CHILD_TIMEOUT')),5000);child.stdout!.once('data',()=>{clearTimeout(timer);done()});child.once('error',fail)})
  expect(()=>recoverJobLock(root)).toThrow('STILL_RUNNING')
  const exited=once(child,'exit');child.kill('SIGKILL');await exited
  expect(recoverJobLock(root).recovered).toBe(true)
  let called=0;const queue=createJobQueue({dataDir:root,handlers:{write:async()=>{called++;return 'reviewed'}}})
  try{const row=queue.list()[0];expect(row).toMatchObject({state:'interrupted',needs_review:true,checkpoint:{step:1}});expect(called).toBe(0);expect(()=>queue.resume(row.id)).toThrow('REVIEW_REQUIRED');queue.resume(row.id,{reviewed:true});await until(()=>queue.list()[0].state==='succeeded');expect(called).toBe(1)}finally{await queue.close()}
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
})
