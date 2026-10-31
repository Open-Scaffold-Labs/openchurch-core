// Quiet craft 2: status codes stay behind Details (OPERATOR.md).
// The plain words name the failure; support can open Details for the code.

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import LoadFailure from './LoadFailure'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { organization: { locale: 'en' } }, token: 't', loading: false }),
}))

function show(props) {
  return render(
    <LocaleProvider>
      <LoadFailure {...props} />
    </LocaleProvider>
  )
}

describe('LoadFailure — status codes behind Details', () => {
  it('shows plain words and keeps the cause closed by default', () => {
    show({ cause: 'Failed (500)' })
    expect(screen.getByText(STRINGS.en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['load.failedBody'])).toBeInTheDocument()
    // Not inlined after the body the old way: "(Failed (500))"
    const body = screen.getByText(STRINGS.en['load.failedBody'])
    expect(body.textContent).not.toMatch(/Failed \(500\)/)
    const details = screen.getByText(STRINGS.en['load.details']).closest('details')
    expect(details).toBeTruthy()
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent('Failed (500)')
  })

  it('reveals the cause when Details is opened', () => {
    show({ cause: 'Failed (503)' })
    const summary = screen.getByText(STRINGS.en['load.details'])
    const details = summary.closest('details')
    fireEvent.click(summary)
    expect(details).toHaveAttribute('open')
    expect(screen.getByText('Failed (503)')).toBeInTheDocument()
  })

  it('omits Details when there is no cause', () => {
    show({})
    expect(screen.queryByText(STRINGS.en['load.details'])).not.toBeInTheDocument()
  })

  it('Spanish labels the disclosure', () => {
    localStorage.setItem('ochr_locale', 'es')
    show({ cause: 'Failed (500)' })
    expect(screen.getByText(STRINGS.es['load.details'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.details'])).not.toBeInTheDocument()
    localStorage.clear()
  })
})
