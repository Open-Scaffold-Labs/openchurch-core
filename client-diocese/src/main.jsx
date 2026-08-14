import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ConfirmProvider } from './components/ConfirmProvider'

// Same token, same interceptor idea as the parish client, inlined:
// attach the bearer token to every /api call. Literal 'ochr_token' so
// the ecosystem registry audit can pattern-match it.
const base = import.meta.env.VITE_API_URL || ''
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? ''
  const attach = url.startsWith('/api/') || (base && url.startsWith(base + '/api/'))
  let finalInit = init
  if (attach) {
    const token = localStorage.getItem('ochr_token')
    if (token) {
      finalInit = { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } }
    }
  }
  const res = await originalFetch(input, finalInit)
  if (attach && res.status === 401) {
    window.dispatchEvent(new Event('opendiocese:unauthorized'))
  }
  return res
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </StrictMode>
)
