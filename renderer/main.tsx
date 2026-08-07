import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { setupGlobalAgentListeners } from './agent-atoms'
import App from './components/App'

const store = createStore()
window.__jotai_store__ = store
setupGlobalAgentListeners()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root element')

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>,
)
