import { Component } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { useOptionalLocale } from '../i18n'

// Top-level error boundary. Catches render-time errors anywhere in the
// tree so a single broken component can't white-screen the whole app.
//
// Async errors (rejected promises, setTimeout throws, fetch failures)
// are NOT caught by error boundaries — those need explicit try/catch
// or a window-level handler. This is intentional in React; the error
// boundary contract is for synchronous render-time crashes.
//
// Logs to console.error so the failure is visible in dev tools and,
// in production, in Vercel's runtime logs (the client side is harder
// to capture without an SDK — we accept that tradeoff for now).
//
// Copy lives in strings.js / t() (OC-READY-01-027). This class does
// not call hooks — the fallback shell reads locale below. main.jsx
// mounts this twice: the inner copy sits inside LocaleProvider so
// App-tree crash chrome follows the live app locale; the outer copy
// wraps AuthProvider so a crash in Auth or Locale still shows this
// chrome (useOptionalLocale → ochr_locale / EN).

function ErrorFallback({ onReload, devMessage }) {
  const { t } = useOptionalLocale()
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-parchment-50 dark:bg-ink-950">
      <div className="w-full max-w-md text-center">
        <div className="inline-flex w-14 h-14 rounded-2xl bg-rose-50 dark:bg-rose-900/30 items-center justify-center text-rose-700 dark:text-rose-300 mb-6">
          <AlertTriangle size={22} />
        </div>
        <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
          {t('error.title')}
        </h1>
        <p className="mt-3 text-sm text-ink-500 dark:text-parchment-300/70 leading-relaxed">
          {t('error.body')}
        </p>
        <button
          type="button"
          onClick={onReload}
          className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
        >
          <RotateCw size={14} /> {t('error.reload')}
        </button>
        {import.meta.env.DEV && devMessage && (
          <pre className="mt-6 text-left text-xs font-mono text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2 overflow-auto max-h-48">
            {devMessage}
          </pre>
        )}
      </div>
    </div>
  )
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Structured log — when we eventually wire a monitoring SDK, this
    // is the call site that becomes Sentry.captureException etc.
    console.error('[ErrorBoundary]', {
      message: error?.message,
      stack:   error?.stack,
      componentStack: info?.componentStack,
    })
  }

  handleReset = () => {
    // A hard reload is the safest reset — component state, fetch caches,
    // and the auth context all get a clean rehydration from the token in
    // localStorage.
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <ErrorFallback
        onReload={this.handleReset}
        devMessage={this.state.error?.message}
      />
    )
  }
}
