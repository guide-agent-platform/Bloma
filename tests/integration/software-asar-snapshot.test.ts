import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const require=createRequire(import.meta.url)
const runtimeRoot=dirname(require.resolve('electron/package.json'))
const executable=join(runtimeRoot,'dist',process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron')
it.skipIf(!existsSync(executable))('keeps actual ASAR archives as byte-identical physical files in Electron release snapshots',async()=>{
 const home=mkdtempSync(join(tmpdir(),'bloma-asar-')),entry=join(home,'entry.ts'),output=resolve('run-artifacts/compiled-fixtures/main/asar-snapshot-regression-'+home.split(/[\\/]/).at(-1)+'.mjs')
 const source=join(runtimeRoot,'dist/resources/default_app.asar')
 mkdirSync(dirname(output),{recursive:true});cpSync(resolve('main/templates'),join(dirname(output),'templates'),{recursive:true,filter:p=>!p.includes('__pycache__')})
 writeFileSync(entry,`import {app} from 'electron';import {createRequire} from 'node:module';import {join} from 'node:path';import {createHash} from 'node:crypto';import {createProject} from ${JSON.stringify(resolve('main/project/project-service.ts'))};import {prepareSoftwareRelease} from ${JSON.stringify(resolve('main/software/release-store.ts'))};
 export async function main(){await app.whenReady();const fs=createRequire(import.meta.url)('original-fs');const p=createProject({request_id:'asar',mode:'quick'},{workflowVersion:'software-v1'});const archive=join(p.root_path,'node_modules/native-runtime/resources/default_app.asar');fs.mkdirSync(join(archive,'..'),{recursive:true});fs.copyFileSync(${JSON.stringify(source)},archive);fs.writeFileSync(join(p.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,mode:'command',command:['node','-e','console.log(1)']}));const release=await prepareSoftwareRelease(p.project_id,p.root_path);const copied=join(release.root,'node_modules/native-runtime/resources/default_app.asar');const hash=x=>createHash('sha256').update(fs.readFileSync(x)).digest('hex');if(!fs.lstatSync(copied).isFile()||hash(copied)!==hash(archive))throw Error('ASAR_PHYSICAL_BYTES_CHANGED');console.log('ASAR_PHYSICAL_BYTES_PASSED');}`)
 try{
  await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external'})
  const env: NodeJS.ProcessEnv={...process.env,PROMA_HOME:home,SOFTWARE_CRASH_RUNTIME:output};delete env.ELECTRON_RUN_AS_NODE
  const result=await promisify(execFile)(executable,[resolve('tests/fixtures/software-recovery/launch.mjs')],{cwd:process.cwd(),env,windowsHide:true,timeout:45000,maxBuffer:1024*1024})
  expect(result.stdout).toContain('ASAR_PHYSICAL_BYTES_PASSED')
 }finally{if(existsSync(output))unlinkSync(output);rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
},60000)
