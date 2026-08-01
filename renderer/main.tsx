import React from 'react'
<<<<<<< HEAD
import ReactDOM from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { setupGlobalAgentListeners } from './agent-atoms'
import App from './components/App'

// 创建全局 Jotai store，供 agent-atoms 的 setupGlobalAgentListeners 使用
const store = createStore()
;(window as any).__jotai_store__ = store

// 注册全局 Agent 流式事件监听器（在 Electron 环境生效）
setupGlobalAgentListeners()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

ReactDOM.createRoot(rootEl).render(
=======
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import App from './components/App'
import { setupGlobalAgentListeners } from './agent-atoms'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root element')

const store = createStore()
window.__jotai_store__ = store
setupGlobalAgentListeners()

createRoot(rootElement).render(
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>,
)
