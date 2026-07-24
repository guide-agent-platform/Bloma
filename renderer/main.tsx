import React from 'react'
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
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>,
)
