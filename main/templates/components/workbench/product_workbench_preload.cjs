const {contextBridge,ipcRenderer}=require('electron')
const methods=['status','query','selectFiles','inspect','parse','commit','analyze','correct','cancel','resume','pull','sync','saveConnection','reconcile','export','restore','remove','diagnostics','startWebhook']
contextBridge.exposeInMainWorld('productWorkbench',Object.freeze(Object.fromEntries(methods.map(method=>[method,input=>ipcRenderer.invoke('product-workbench',{method,input})]))))
contextBridge.exposeInMainWorld('productSettings',Object.freeze(Object.fromEntries(['read','save','check','cancel'].map(method=>[method,input=>ipcRenderer.invoke('product-settings:'+method,input)]))))
