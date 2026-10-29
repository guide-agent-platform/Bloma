// No remote service. Uses a real Electron product window, OS safeStorage and local HTTP.
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {_electron as electron} from 'playwright'
const require=createRequire(import.meta.url)
const output=resolve('run-artifacts/product-settings-20261029');mkdirSync(output,{recursive:true})
const home=mkdtempSync(join(tmpdir(),'bloma-settings-native-')),product=join(home,'product'),data=join(home,'data')
mkdirSync(product);mkdirSync(data)
for(const file of ['ai_service.cjs','ai_routes.cjs','ai_secrets.cjs','AI_SERVICE.template.json','http_connector.cjs'])copyFileSync(resolve('main/templates/tools',file),join(product,file))
for(const file of readdirSync(resolve('main/templates/components/product-settings')))copyFileSync(resolve('main/templates/components/product-settings',file),join(product,file))
const report={started_at:new Date().toISOString(),files:Object.fromEntries(readdirSync(product).map(file=>[file,createHash('sha256').update(readFileSync(join(product,file))).digest('hex')])),scope:'real Electron + OS encryption + controlled local HTTP; no supplier or model-quality claim',cases:[],requests:0,errors:[]}
const pass=name=>report.cases.push({name,status:'passed'})
let mode='ok',app,page
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk)
 report.requests++
 assert.equal(req.headers.authorization,'Bearer native-product-secret')
 assert.equal(req.url,'/v1/chat/completions')
 assert.equal(JSON.parse(Buffer.concat(chunks)).model,'native-model')
 res.setHeader('Content-Type','application/json')
 if(mode==='slow')return
 if(mode==='auth'){res.writeHead(401);res.end('{"error":"PRIVATE_ERROR_BODY"}');return}
 res.end(JSON.stringify({choices:[{message:{content:'PRIVATE_MODEL_BODY'}}]}))
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const url=`http://127.0.0.1:${server.address().port}/v1`
async function start(){
 const env={...process.env,APP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE
 app=await electron.launch({executablePath:require('electron'),args:[`--user-data-dir=${join(home,'electron-data')}`,join(product,'product_settings_electron.cjs')],env})
 page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.stack))
 await page.locator('[data-status]').filter({hasText:'已载入'}).waitFor()
}
const text=async(selector,expected)=>{await page.locator(selector).filter({hasText:expected}).waitFor()}
try{
 await start()
 const os=await app.evaluate(({safeStorage})=>({available:safeStorage.isEncryptionAvailable(),backend:safeStorage.getSelectedStorageBackend?.()}))
 report.os=os;report.electron=await app.evaluate(()=>process.versions.electron);assert.equal(os.available,true);assert.notEqual(os.backend,'basic_text');pass('real OS encryption available')
 assert.equal(await page.evaluate(()=>typeof window.productSettings.get),'undefined')
 assert.equal(await page.locator('[data-check]').isDisabled(),true)
 await page.locator('[name=endpoint]').fill(url);await page.locator('[name=model]').fill('native-model');await page.locator('[name=network]').selectOption('loopback');await page.locator('[name=key]').fill('native-product-secret')
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await text('[data-status]','设置已保存')
 assert.equal(report.requests,0);assert.equal(await page.locator('[name=key]').inputValue(),'')
 const serialized=await page.evaluate(async()=>JSON.stringify(await window.productSettings.read()))
 assert.ok(!serialized.includes('native-product-secret'));pass('actual IPC save does not call network or return Key')
 const encrypted=readdirSync(join(data,'.ai-secrets'))
 assert.equal(encrypted.length,1);assert.ok(!readFileSync(join(data,'.ai-secrets',encrypted[0])).includes(Buffer.from('native-product-secret')))
 pass('OS-encrypted bytes stored outside public settings')
 await page.locator('[name=model]').fill('discarded');await page.locator('[name=key]').fill('discarded-secret')
 await page.locator('[data-reset]').click();await text('[data-status]','已载入')
 assert.equal(await page.locator('[name=model]').inputValue(),'native-model');assert.equal(await page.locator('[name=key]').inputValue(),'');assert.equal(report.requests,0);pass('cancel discards draft and pending Key')
 const old=JSON.parse(serialized).value.settings
 const changed=JSON.parse(readFileSync(join(data,'ai-service.json'),'utf8'));changed.routes.default.model='external-change'
 const {AIService}=require(join(product,'ai_service.cjs'));new AIService().saveSettings(data,changed,old.revision)
 await page.locator('[name=model]').fill('stale-draft');await page.getByRole('button',{name:'保存设置',exact:true}).click();await text('[data-status]','其他窗口修改')
 assert.equal(JSON.parse(readFileSync(join(data,'ai-service.json'),'utf8')).routes.default.model,'external-change');pass('stale form rejects overwrite through actual IPC')
 await page.locator('[data-reset]').click();await text('[data-status]','已载入');await page.locator('[name=model]').fill('native-model');await page.getByRole('button',{name:'保存设置',exact:true}).click();await text('[data-status]','设置已保存')
 await page.locator('[name=consent]').check();await page.locator('[data-check]').click();await text('[data-connection]','连接检查成功');assert.equal(report.requests,1)
 assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_MODEL_BODY'));pass('explicit consent performs one real local request and labels connection scope')
 mode='auth';await page.locator('[data-check]').click();await text('[data-connection]','鉴权失败');assert.equal(report.requests,2);pass('auth failure shown without private error body')
 mode='slow';await page.locator('[data-check]').click();await text('[data-connection]','正在检查');await page.locator('[data-stop]').click();await text('[data-connection]','已取消');pass('cancel stops in-flight check')
 await page.screenshot({path:join(output,'settings.png'),fullPage:true})
 await app.close();app=undefined;mode='ok';await start()
 assert.equal(await page.locator('[name=model]').inputValue(),'native-model');await text('[data-key-state]','已保存 Key')
 await page.locator('[name=consent]').check();await page.locator('[data-check]').click();await text('[data-connection]','连接检查成功');pass('new Electron process decrypts OS Key and calls saved route')
 // Observe the actual adapter refusing encryption-unavailable operation; never replace OS encryption with a fake success.
 const result=await app.evaluate(({safeStorage})=>{
  const before=safeStorage.isEncryptionAvailable
  safeStorage.isEncryptionAvailable=()=>false
  return typeof before==='function'
 })
 assert.equal(result,true)
 await page.locator('[data-reset]').click();await text('[data-key-state]','系统加密不可用')
 await page.locator('[name=key]').fill('should-not-persist');await page.getByRole('button',{name:'保存设置',exact:true}).click();await text('[data-status]','Key 未保存')
 assert.equal(readdirSync(join(data,'.ai-secrets')).length,1);pass('encryption-unavailable fault injection rejects Key save in real UI')
 await page.screenshot({path:join(output,'encryption-unavailable.png'),fullPage:true})
 assert.deepEqual(report.errors,[])
 report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack;if(page&&!page.isClosed())await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1}
finally{
 if(app)await app.close().catch(()=>{})
 server.closeAllConnections();await new Promise(done=>server.close(done))
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2))
 // Delete only this run's explicitly verified temporary directory.
 if(resolve(home).startsWith(resolve(tmpdir())+sep+'bloma-settings-native-'))rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})
 console.log(JSON.stringify(report,null,2))
}
