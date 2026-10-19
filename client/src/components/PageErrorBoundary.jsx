import { Component } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { useOptionalLocale } from '../i18n'

// Per-page error boundary. Different from the root ErrorBoundary in
// two ways:
//
//   1. The fallback is COMPACT — it renders inside the main content
//      area, leaving the Sidebar + Header intact so the user can
//      navigate to a different page without reloading. The root
//      boundary's full-viewport fallback is for catastrophic crashes
//      (outer ErrorBoundary wrapping Auth/Locale in main.jsx); this
//      one is for "this page hit a bug, the rest of the app is fine."
//
//   2. The retry button RESETS the boundary's error state instead of
//      reloading the whole app. If the error was transient (a flaky
//      fetch, a timing bug), retry clears the fallback and the page
//      re-mounts fresh.
//
// Async errors (rejected promises, fetch failures, setTimeout throws)
// are NOT caught — those still need explicit try/catch in the calling
// code. React error boundaries are render-time only by design.
//
// Copy lives in strings.js / t() (OC-READY-01-027). This class does
// not call hooks — the fallback shell reads the live locale spine
// (this boundary sits inside LocaleProvider).
//
// Usage in App.jsx:
//
//   <Route path="/clients" element={
//     <PageErrorBoundary scope="Members">
//       <Clients />
//     </PageErrorBoundary>
//   } />

function PageErrorFallback({ onRetry, devMessage }) {
  const { t } = useOptionalLocale()
  return (
    <div className="max-w-2xl mx-auto py-12">
      <div className="rounded-2xl bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 p-6 text-center">
        <div className="inline-flex w-12 h-12 rounded-2xl bg-rose-100 dark:bg-rose-900/40 items-center justify-center text-rose-700 dark:text-rose-300 mb-4">
          <AlertTriangle size={20} />
        </div>
        <h2 className="font-display text-xl font-semibold text-ink-900 dark:text-parchment-50">
          {t('error.pageTitle')}
        </h2>
        <p className="mt-2 text-sm text-ink-600 dark:text-parchment-300/80 leading-relaxed">
          {t('error.pageBody')}
        </p>
        <div className="mt-5 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
          >
            <RotateCw size={13} /> {t('error.tryAgain')}
          </button>
        </div>
        {import.meta.env.DEV && devMessage && (
          <pre className="mt-5 text-left text-xs font-mono text-rose-700 dark:text-rose-300 bg-rose-100/60 dark:bg-rose-900/30 border border-rose-200/60 dark:border-rose-800/40 rounded-lg px-3 py-2 overflow-auto max-h-48">
            {devMessage}
          </pre>
        )}
      </div>
    </div>
  )
}

export default class PageErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Same structured log shape as the root ErrorBoundary so log
    // aggregation (once we wire one) can coalesce them.
    // eslint-disable-next-line no-console
    console.error(`[PageErrorBoundary:${this.props.scope || 'unknown'}]`, {
      message: error?.message,
      stack:   error?.stack,
      componentStack: info?.componentStack,
    })
  }

  handleRetry = () => {
    // Just clear the error — the wrapped page re-renders. If the
    // error was transient (network blip, race condition), the user
    // is back in business without losing the rest of the app's state.
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <PageErrorFallback
        onRetry={this.handleRetry}
        devMessage={this.state.error?.message}
      />
    )
  }
}
