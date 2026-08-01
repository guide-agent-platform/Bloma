import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { setupGlobalAgentListeners } from './agent-atoms'
import App from './components/App'

const store = createStore()
;(window as any).__jotai_store__ = store
setupGlobalAgentListeners()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>,
)
