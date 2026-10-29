import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {spawn} from 'node:child_process'
const require=createRequire(import.meta.url)
export const projectRoot=path.resolve(import.meta.dirname,'..')
export function materializeWorkbench(root){
 fs.mkdirSync(root,{recursive:true});const names=new Set()
 for(const folder of fs.readdirSync(path.join(projectRoot,'main/templates/components'))){const dir=path.join(projectRoot,'main/templates/components',folder);for(const file of fs.readdirSync(dir)){if(names.has(file))throw Error('DUPLICATE_COMPONENT_FILENAME');names.add(file);fs.copyFileSync(path.join(dir,file),path.join(root,file))}}
 for(const file of ['ai_service.cjs','ai_routes.cjs','ai_secrets.cjs','AI_SERVICE.template.json','http_connector.cjs','webhook_inbox.cjs','document_runtime.cjs','ocr_runtime.cjs','ocr_worker.ps1','speech_bridge.cjs','speech_runtime.py','speech_worker.py','speech_locator.py'])fs.copyFileSync(path.join(projectRoot,'main/templates/tools',file),path.join(root,file))
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'bloma-product-workbench',version:'1.0.0',private:true,main:'product_workbench_electron.cjs',dependencies:{'pdfjs-dist':'6.4.299',mammoth:'1.13.0'}}))
}
export async function installFixtureDependencies(root,log){
 const npm=path.join(path.dirname(require.resolve('npm/package.json')),'bin/npm-cli.js'),fd=fs.openSync(log,'w')
 const child=spawn(process.execPath,[npm,'install','--offline','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,windowsHide:true,stdio:['ignore',fd,fd]})
 try{await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('FIXTURE_DEPENDENCIES_FAILED; see '+log)))})}finally{fs.closeSync(fd)}
}
export const electronPath=require('electron')
