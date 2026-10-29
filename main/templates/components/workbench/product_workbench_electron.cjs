const {app,BrowserWindow,ipcMain,safeStorage,dialog,nativeImage}=require('electron'),path=require('node:path'),fs=require('node:fs'),{pathToFileURL}=require('node:url')
const {createWorkbench}=require('./product_workbench.cjs')
let workbench,closing=false
app.whenReady().then(()=>{
 const dataDir=process.env.APP_DATA_DIR||path.join(app.getPath('userData'),'product-data');fs.mkdirSync(dataDir,{recursive:true})
 const speech=path.join(__dirname,'resources/speech'),python=path.join(speech,'python/python.exe'),models=path.join(speech,'models')
 if(!process.env.BLOMA_SPEECH_PYTHON&&fs.existsSync(python))process.env.BLOMA_SPEECH_PYTHON=python
 if(!process.env.BLOMA_SPEECH_MODEL_DIR&&fs.existsSync(models))process.env.BLOMA_SPEECH_MODEL_DIR=models
 workbench=createWorkbench({dataDir,safeStorage,dialog,nativeImage,recognizeImage:require('./ocr_runtime.cjs').recognizeImage,transcribeWav:require('./speech_bridge.cjs').transcribeWav})
 const window=new BrowserWindow({width:1220,height:900,webPreferences:{preload:path.join(__dirname,'product_workbench_preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}}),url=pathToFileURL(path.join(__dirname,'product_workbench.html')).href
 const allowed=event=>event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame.url===url
 ipcMain.handle('product-workbench',(event,{method,input}={})=>allowed(event)?workbench.dispatch(method,input):{ok:false,code:'SENDER_INVALID'})
 for(const method of ['read','save','check','cancel'])ipcMain.handle('product-settings:'+method,(event,input)=>allowed(event)?workbench.dispatchSettings(method,input):{ok:false,code:'SENDER_INVALID'})
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.loadURL(url)
})
app.on('window-all-closed',()=>app.quit())
app.on('before-quit',event=>{if(workbench&&!closing){event.preventDefault();closing=true;workbench.close().finally(()=>app.quit())}})
