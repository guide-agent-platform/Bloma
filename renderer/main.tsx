import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { setupGlobalAgentListeners, networkOnlineAtom } from './agent-atoms'
import App from './components/App'

const store = createStore()
window.__jotai_store__ = store
setupGlobalAgentListeners()

// QW#1 审查 P3：online/offline 事件同步 networkOnlineAtom（否则「离线」三态运行期不可达）
window.addEventListener('online', () => store.set(networkOnlineAtom, true))
window.addEventListener('offline', () => store.set(networkOnlineAtom, false))

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root element')

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>,
)
