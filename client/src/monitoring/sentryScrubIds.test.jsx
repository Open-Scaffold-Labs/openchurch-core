// The client has no Sentry SDK. The objects ErrorBoundary, PageErrorBoundary,
// and the window handlers hand to console.error are the capture payload.
// They go through the same beforeSend scrub as the server.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { STRINGS } from '../i18n/strings'
import ErrorBoundary from '../components/ErrorBoundary'
import PageErrorBoundary from '../components/PageErrorBoundary'
import * as clientCapture from './clientCapture.js'
import { reportWindowError, reportUnhandledRejection } from './clientCapture.js'
import { buildSentryInitOptions } from '../../../server/src/monitoring/sentryPrivacy.js'

function Boom({ message }) {
  throw new Error(message)
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  console.error.mockRestore()
})

function logged(label) {
  const call = console.error.mock.calls.find(args => args[0] === label)
  expect(call, label).toBeTruthy()
  return JSON.stringify(call[1])
}

describe('client capture scrubs userId and orgId', () => {
  it('ErrorBoundary does not log the identifiers', () => {
    render(
      <ErrorBoundary>
        <Boom message="render failed userId=17 orgId=9" />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(STRINGS.en['error.title'])
    const json = logged('[ErrorBoundary]')
    expect(json).not.toMatch(/userId|orgId/)
    expect(json).not.toMatch(/user[_-]?id|org(?:anization)?[_-]?id/i)
    expect(json).toContain('render failed [id] [id]')
  })

  it('PageErrorBoundary does not log the identifiers', () => {
    render(
      <PageErrorBoundary scope="Schedule">
        <Boom message="page failed userId=17 orgId=9" />
      </PageErrorBoundary>,
    )
    const json = logged('[PageErrorBoundary:Schedule]')
    expect(json).not.toMatch(/userId|orgId|organizationId/i)
    expect(json).toContain('page failed [id] [id]')
  })

  it('window error and rejection reports drop the identifiers and keep the line', () => {
    reportWindowError({ message: 'script userId=17 orgId=9', filename: 'app.js', lineno: 40 })
    reportUnhandledRejection({ reason: new Error('rejected userId=17 orgId=9') })
    const win = logged('[window.onerror]')
    const rej = logged('[unhandledrejection]')
    for (const json of [win, rej]) {
      expect(json).not.toMatch(/userId|orgId/)
      expect(json).not.toContain('17')
    }
    expect(win).toContain('40')
    expect(win).toContain('app.js')
  })

  it('uses the same beforeSend hook as the server', () => {
    const out = buildSentryInitOptions('https://public@127.0.0.1/1').beforeSend({
      message: 'userId=17',
      tags: { userId: '17', scope: 'client' },
      extra: { orgId: 9, status: 500 },
    })
    const json = JSON.stringify(out)
    expect(json).not.toMatch(/userId|orgId/)
    expect(out.tags.scope).toBe('client')
    expect(out.extra.status).toBe(500)
  })
})

describe('browser capture never carries raw stack text', () => {
  const stackWithIds = [
    'Error: boom',
    '    at Roster (https://parish.example/assets/Roster-abc.js?userId=17&org=9#org-id-9:12:34)',
    '    at People (https://parish.example/people/u_4417/org_9.js:5:6)',
    '    at UserId17Org9 (webpack://app/src/user-17/org-9.jsx:1:2)',
  ].join('\n')
  const componentStackWithIds = '\n    at Member user-17 (https://parish.example/members/17?orgId=9)\n    at Org org_9'

  it('drops stack and componentStack, keeps parsed filename and line/col', () => {
    const err = new Error('boom')
    err.stack = stackWithIds
    const { reportBoundary } = clientCapture
    reportBoundary('[ErrorBoundary]', err, { componentStack: componentStackWithIds }, 'ErrorBoundary')
    const payload = console.error.mock.calls.find(a => a[0] === '[ErrorBoundary]')[1]
    const json = JSON.stringify(payload)
    expect(payload.extra.stack).toBeUndefined()
    expect(payload.extra.componentStack).toBeUndefined()
    expect(json).not.toMatch(/userId|orgId|org-id|u_4417|org_9|user-17|Member|\?|#/)
    expect(payload.extra.filename).toBe('https://parish.example/assets/Roster-abc.js')
    expect(payload.extra.lineno).toBe(12)
    expect(payload.extra.colno).toBe(34)
  })

  it('window error filename loses its query string and fragment', () => {
    reportWindowError({ message: 'x', filename: 'https://parish.example/app.js?userId=17#orgId=9', lineno: 3, colno: 4 })
    const payload = console.error.mock.calls.find(a => a[0] === '[window.onerror]')[1]
    expect(payload.extra.filename).toBe('https://parish.example/app.js')
    expect(JSON.stringify(payload)).not.toMatch(/userId|orgId|17/)
  })

  it('shared allowlist no longer passes raw stack or componentStack in extra', () => {
    const out = buildSentryInitOptions('https://public@127.0.0.1/1').beforeSend({
      message: 'm', extra: { stack: stackWithIds, componentStack: componentStackWithIds, lineno: 3 },
    })
    expect(out.extra?.stack).toBeUndefined()
    expect(out.extra?.componentStack).toBeUndefined()
    expect(out.extra.lineno).toBe(3)
  })
})
