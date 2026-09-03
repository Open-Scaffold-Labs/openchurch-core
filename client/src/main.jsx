import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted design-system fonts. Weights here MUST stay in lockstep with
// tailwind.config.js (fontFamily.sans / fontFamily.serif) and index.css.
//
// LATIN + LATIN-EXT SUBSETS ONLY. The bare '@fontsource/inter/400.css'
// entrypoints pull every subset the family ships (cyrillic, greek,
// vietnamese, ...), which added ~600KB to the service worker's precache for
// glyphs neither English nor Spanish will ever render. If a language beyond
// the Latin scripts is ever added, widen these imports deliberately.
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/inter/latin-ext-400.css'
import '@fontsource/inter/latin-ext-500.css'
import '@fontsource/inter/latin-ext-600.css'
import '@fontsource/inter/latin-ext-700.css'
import '@fontsource/cormorant-garamond/latin-500.css'
import '@fontsource/cormorant-garamond/latin-600.css'
import '@fontsource/cormorant-garamond/latin-700.css'
import '@fontsource/cormorant-garamond/latin-ext-500.css'
import '@fontsource/cormorant-garamond/latin-ext-600.css'
import '@fontsource/cormorant-garamond/latin-ext-700.css'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastProvider } from './components/ToastProvider'
import { installFetchInterceptor } from './auth/fetchInterceptor'

// Attach the auth token to every /api request before React mounts so the
// very first page-load fetches (e.g. /api/auth/me for rehydration) carry it.
installFetchInterceptor()

// Window-level handlers catch async failures the React ErrorBoundary
// can't see — rejected promises, setTimeout throws, etc. Logging here
// surfaces them in dev tools and (eventually) any monitoring SDK we
// wire up via the same call site.
window.addEventListener('error', (e) => {
  console.error('[window.onerror]', { message: e.message, filename: e.filename, lineno: e.lineno, error: e.error })
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', { reason: e.reason })
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      {/* ConfirmProvider used to sit here. It moved inside <LocaleProvider>
          in App.jsx when the dialog started speaking — its recoverable
          note has to be translated, and a provider cannot read a context
          that is mounted below it. The build was perfectly happy; every
          page threw on first paint. */}
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>
)
