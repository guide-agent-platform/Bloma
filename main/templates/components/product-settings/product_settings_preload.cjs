const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('productSettings',Object.freeze(Object.fromEntries(['read','save','check','cancel'].map(method=>[method,input=>ipcRenderer.invoke('product-settings:'+method,input)]))))
