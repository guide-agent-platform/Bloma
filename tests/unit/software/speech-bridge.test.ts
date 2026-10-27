import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { softwareEnvironment } from '../../../main/software/command-runtime'
let home:string,old:string|undefined,root:string,python=''
try{python=execFileSync('python',['-I','-c','import sys;print(sys.executable)'],{encoding:'utf8',windowsHide:true,timeout:5000}).trim()}catch{/* optional real Python transport fixture */}
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-bridge-'));process.env.PROMA_HOME=home;root=join(home,'app');mkdirSync(root)
  copyFileSync(resolve('main/templates/tools/speech_bridge.cjs'),join(root,'speech_bridge.cjs'))
})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
async function run(script:string,executable=python){return promisify(execFile)(process.execPath,['-e',script],{cwd:root,env:{...softwareEnvironment('bridge-fixture',join(home,'data'),root),BLOMA_SPEECH_PYTHON:executable},windowsHide:true,timeout:15000})}
it.skipIf(!python)('preserves Chinese and astral UTF-8 characters across fragmented worker output',async()=>{
  writeFileSync(join(root,'speech_worker.py'),`import sys,time\npayload='{"ok":true,"text":"你好🌍"}'.encode('utf8')\nfor b in payload:\n sys.stdout.buffer.write(bytes([b]));sys.stdout.buffer.flush();time.sleep(.001)\n`)
  const result=await run(`require('./speech_bridge.cjs').transcribeWav('fixture-only').then(text=>console.log(text),e=>{console.error(e);process.exit(1)})`)
  expect(result.stdout.trim()).toBe('你好🌍')
})
it('reports missing executable errors without leaking active slots or crashing on an unhandled child error',async()=>{
  const result=await run(`(async()=>{const b=require('./speech_bridge.cjs'),errors=[];for(let i=0;i<3;i++)try{await b.transcribeWav('fixture-only')}catch(e){errors.push(e.message)}console.log(JSON.stringify(errors))})()`,join(home,'missing-python'))
  const errors=JSON.parse(result.stdout);expect(errors).toHaveLength(3);expect(errors.every((error:string)=>error.includes('ENOENT'))).toBe(true)
})
it.skipIf(!python)('bounds concurrency and cancellation/timeout while reaping only the workers it created',async()=>{
  writeFileSync(join(root,'speech_worker.py'),`import os,time\nfrom pathlib import Path\nPath(os.environ['APP_DATA_DIR'],str(os.getpid())+'.started').write_text('owned fixture')\ntime.sleep(20)\n`)
  const result=await run(`(async()=>{const b=require('./speech_bridge.cjs'),a=new AbortController();const jobs=[b.transcribeWav('fixture-only',{signal:a.signal}),b.transcribeWav('fixture-only',{signal:a.signal}),b.transcribeWav('fixture-only')];setTimeout(()=>a.abort(),300);const values=await Promise.allSettled(jobs);try{await b.transcribeWav('fixture-only',{timeoutMs:100})}catch(e){console.log(e.message)}console.log(JSON.stringify(values.map(v=>v.reason?.message)))})()`)
  expect(result.stdout).toContain('ASR_WORKER_TIMEOUT');expect(result.stdout).toContain('ASR_BUSY')
  const states=JSON.parse(result.stdout.trim().split('\n').at(-1)!);expect(states.filter((state:string)=>state==='ASR_CANCELLED')).toHaveLength(2)
  for(const file of readdirSync(join(home,'data')).filter(name=>name.endsWith('.started'))){
    const pid=Number(file.replace('.started',''));expect(readFileSync(join(home,'data',file),'utf8')).toBe('owned fixture')
    let alive=true;try{process.kill(pid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw error}
    expect(alive).toBe(false)
  }
})
