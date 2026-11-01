import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const require=createRequire(import.meta.url),electronRoot=dirname(require.resolve('electron/package.json'))
const executable=join(electronRoot,'dist',process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron')
it.skipIf(!existsSync(executable))('runs the bundled Pi adapter inside the actual Electron main process with host-owned tools',async()=>{
  const home=mkdtempSync(join(tmpdir(),'bloma-pi-electron-')),entry=join(home,'entry.ts')
  const output=resolve('run-artifacts/compiled-fixtures/pi-electron-'+home.split(/[\\/]/).at(-1)+'.mjs')
  mkdirSync(dirname(output),{recursive:true})
  writeFileSync(entry,`import {app} from 'electron';import {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {runAgentLoop} from ${JSON.stringify(resolve('main/agent/loop/agent-loop.ts'))};
export async function main(){await app.whenReady();let calls=0,writes=0,observed;const home=process.env.PROMA_HOME;const result=await runAgentLoop({runtimeScope:'electron-test',projectId:'electron-fixture',sessionId:'electron-pi',requestId:'r',system:'HOST_ELECTRON_POLICY',task:'write',env:{ANTHROPIC_MODEL:'controlled',ANTHROPIC_BASE_URL:'https://fixture.invalid/v1'},maxTokens:1000,maxTurns:5,permissionMode:'allow-all',signal:AbortSignal.timeout(20000),publish:()=>{},onRuntimeObservation:value=>{observed=value},tools:[{name:'write_file',description:'fixture',input_schema:{type:'object',properties:{}},execute:async()=>{writes++;writeFileSync(join(home,'value.txt'),'one');return{output:'saved once'}}}],query:async function*(_prompt,options){calls++;if(options.tools?.map(t=>t.name).join(',')!=='write_file'||!JSON.stringify(options.messages).includes('HOST_ELECTRON_POLICY'))throw Error('WIRE_STATE_LOST');yield{type:'assistant',message:{role:'assistant',content:calls===1?[{type:'tool_use',id:'write',name:'write_file',input:{}}]:[{type:'text',text:'done'}]}};yield{type:'result',stop_reason:calls===1?'tool_use':'end_turn',usage:{input_tokens:10,output_tokens:5}}}});if(result.status!=='completed'||writes!==1||calls!==2)throw Error('PI_EXECUTION_FAILED');writeFileSync(join(home,'report.json'),JSON.stringify({status:result.status,writes,calls,value:readFileSync(join(home,'value.txt'),'utf8'),runtime:observed.runtime}));console.log('PI_ELECTRON_PASSED')}`)
  try{
    await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external'})
    const env:NodeJS.ProcessEnv={...process.env,PROMA_HOME:home,SOFTWARE_CRASH_RUNTIME:output};delete env.ELECTRON_RUN_AS_NODE
    const result=await promisify(execFile)(executable,[resolve('tests/fixtures/software-recovery/launch.mjs'),'--user-data-dir='+join(home,'user-data')],{cwd:process.cwd(),env,windowsHide:true,timeout:45000,maxBuffer:1024*1024})
    expect(result.stdout).toContain('PI_ELECTRON_PASSED')
    const report=JSON.parse(readFileSync(join(home,'report.json'),'utf8'))
    expect(report).toMatchObject({status:'completed',writes:1,calls:2,value:'one',runtime:{engine:'pi',packages:{'pi-coding-agent':'1.4.0','pi-agent-core':'1.4.0','pi-ai':'1.4.0'}}})
    expect(report.runtime.electron).not.toBe('none')
  }finally{if(existsSync(output))unlinkSync(output);rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
},60000)
