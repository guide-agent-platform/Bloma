// Minimal standalone adapter. Embed the backend and UI in the product's confirmed design.
const {app,BrowserWindow,ipcMain,safeStorage}=require('electron')
const path=require('node:path'),fs=require('node:fs'),{pathToFileURL}=require('node:url')
const {createProductSettings,dispatchSettings}=require('./product_settings.cjs')
let backend
app.whenReady().then(()=>{
  const dataDir=process.env.APP_DATA_DIR||path.join(app.getPath('userData'),'product-data')
  fs.mkdirSync(dataDir,{recursive:true})
  backend=createProductSettings({dataDir,safeStorage})
  const window=new BrowserWindow({width:900,height:850,webPreferences:{preload:path.join(__dirname,'product_settings_preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}})
  const url=pathToFileURL(path.join(__dirname,'product_settings.html')).href
  for(const method of ['read','save','check','cancel'])ipcMain.handle('product-settings:'+method,(event,input)=>{
    if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==url)return{ok:false,code:'SETTINGS_SENDER_INVALID'}
    return dispatchSettings(backend,method,input)
  })
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  window.webContents.on('will-navigate',event=>event.preventDefault())
  window.on('closed',()=>backend.cancel())
  window.loadURL(url)
})
app.on('window-all-closed',()=>app.quit())
