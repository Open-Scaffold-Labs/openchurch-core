import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ConfirmProvider } from './components/ConfirmProvider'
import { installSessionFetch } from './sessionFetch'

installSessionFetch()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </StrictMode>
)
