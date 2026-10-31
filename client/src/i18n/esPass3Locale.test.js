// Spanish audit pass 3 — confirms, toasts, and public powered-by
// (Beacon ES-PASS-3 top-30 inventory).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STRINGS } from './strings'

const dir = dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(join(dir, '..', rel), 'utf8')

const PASS3_KEYS = [
  'chk.disableKioskTitle',
  'chk.disableKioskBody',
  'chk.disableKioskConfirm',
  'chk.didntDelete',
  'chk.serviceNotOnSchedule',
  'chk.serviceOpenFailed',
  'cal.getLinkFailed',
  'cal.regenTitle',
  'cal.regenBody',
  'cal.regenConfirm',
  'grp.removeTitle',
  'grp.removeBody',
  'grp.removeConfirm',
  'orgs.dio.leaveTitle',
  'orgs.dio.leaveBody',
  'orgs.dio.leaveConfirm',
  'events.removeTitle',
  'events.removeConfirm',
  'events.saveConnError',
  'mem.removeAction',
  'dash.taskStillOpen',
  'fin.submitPeriodTitle',
  'fin.submitPeriodBody',
  'fin.submitPeriodConfirm',
  'don.sidesFailed',
  'don.side.cashCounts',
  'don.side.byFund',
  'don.side.recurring',
  'stmt.loadIssuedFailed',
  'stmt.issueFailed',
  'forms.resp.exportedOne',
  'forms.resp.exportedMany',
  'task.checklistSaveFailed',
  'att.markOneBeforeSave',
  'swap.reachServer',
  'swap.linkNotFound',
  'swap.openFailed',
  'give.powered',
  'events.powered',
  'bulletin.powered',
  'form.powered',
  'church.powered',
]

describe('Spanish audit pass 3', () => {
  it('en and es have the same keys (full catalog parity)', () => {
    const en = Object.keys(STRINGS.en).sort()
    const es = Object.keys(STRINGS.es).sort()
    expect(es).toEqual(en)
  })

  it('pass-3 keys exist in both locales with Spanish that is not a copy of English', () => {
    for (const key of PASS3_KEYS) {
      expect(STRINGS.en[key], `en missing ${key}`).toBeTruthy()
      expect(STRINGS.es[key], `es missing ${key}`).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(STRINGS.es['chk.disableKioskTitle']).toBe('¿Apagar el quiosco?')
    expect(STRINGS.es['church.powered']).toBe('Con tecnología de ScaffoldLabs')
    expect(STRINGS.es['give.powered']).toBe(STRINGS.es['church.powered'])
    expect(STRINGS.es['events.powered']).toBe(STRINGS.es['church.powered'])
    expect(STRINGS.es['bulletin.powered']).toBe(STRINGS.es['church.powered'])
    expect(STRINGS.es['form.powered']).toBe(STRINGS.es['church.powered'])
  })

  it('Check-in kiosk disable, empty-service titles go through t()', () => {
    const checkin = src('pages/Checkin.jsx')
    expect(checkin).toMatch(/t\('chk\.disableKioskTitle'\)/)
    expect(checkin).toMatch(/t\('chk\.disableKioskBody'\)/)
    expect(checkin).toMatch(/t\('chk\.disableKioskConfirm'\)/)
    expect(checkin).toMatch(/t\('chk\.didntDelete'\)/)
    expect(checkin).toMatch(/t\('chk\.serviceNotOnSchedule'\)/)
    expect(checkin).toMatch(/t\('chk\.serviceOpenFailed'\)/)
    expect(checkin).not.toMatch(/Turn off the kiosk\?/)
    expect(checkin).not.toMatch(/Turn off kiosk/)
  })

  it('CalendarSync confirm and get-link toast go through t()', () => {
    const cal = src('components/CalendarSync.jsx')
    expect(cal).toMatch(/t\('cal\.getLinkFailed'\)/)
    expect(cal).toMatch(/t\('cal\.regenTitle'\)/)
    expect(cal).toMatch(/t\('cal\.regenBody'\)/)
    expect(cal).toMatch(/t\('cal\.regenConfirm'\)/)
    expect(cal).not.toMatch(/Generate a new calendar link\?/)
    expect(cal).not.toMatch(/Failed to get calendar link/)
  })

  it('Groups/OrgSettings/Events/Clients confirms go through t()', () => {
    const groups = src('pages/Groups.jsx')
    const org = src('pages/OrgSettings.jsx')
    const events = src('pages/Events.jsx')
    const clients = src('pages/Clients.jsx')
    expect(groups).toMatch(/t\('grp\.removeTitle'/)
    expect(groups).toMatch(/t\('grp\.removeBody'\)/)
    expect(groups).toMatch(/t\('grp\.removeConfirm'\)/)
    expect(org).toMatch(/t\('orgs\.dio\.leaveTitle'\)/)
    expect(org).toMatch(/t\('orgs\.dio\.leaveBody'\)/)
    expect(org).toMatch(/t\('orgs\.dio\.leaveConfirm'\)/)
    expect(events).toMatch(/t\('events\.removeTitle'\)/)
    expect(events).toMatch(/t\('events\.removeConfirm'\)/)
    expect(events).toMatch(/t\('events\.saveConnError'\)/)
    expect(clients).toMatch(/t\('mem\.removeAction'\)/)
    expect(clients).not.toMatch(/confirmLabel: 'Remove member'/)
  })

  it('Team/Dashboard/Finance/Donations/DonorStatement/FormResponses/Tasks/Attendance/PublicSwap go through t()', () => {
    expect(src('pages/Team.jsx')).toMatch(/t\('signup\.passwordMin'/)
    expect(src('pages/Dashboard.jsx')).toMatch(/t\('dash\.taskStillOpen'\)/)
    const fin = src('pages/Finance.jsx')
    expect(fin).toMatch(/t\('fin\.submitPeriodTitle'/)
    expect(fin).toMatch(/t\('fin\.submitPeriodBody'\)/)
    expect(fin).toMatch(/t\('fin\.submitPeriodConfirm'\)/)
    expect(src('pages/Donations.jsx')).toMatch(/t\('don\.sidesFailed'/)
    expect(src('pages/DonorStatement.jsx')).toMatch(/t\('stmt\.loadIssuedFailed'\)/)
    expect(src('pages/DonorStatement.jsx')).toMatch(/t\('stmt\.issueFailed'\)/)
    expect(src('pages/FormResponses.jsx')).toMatch(/forms\.resp\.exported/)
    expect(src('pages/Tasks.jsx')).toMatch(/t\('task\.checklistSaveFailed'/)
    expect(src('components/AttendanceSection.jsx')).toMatch(/t\('att\.markOneBeforeSave'\)/)
    const swap = src('pages/PublicSwap.jsx')
    expect(swap).toMatch(/t\('swap\.reachServer'\)/)
    expect(swap).toMatch(/t\('swap\.linkNotFound'\)/)
    expect(swap).toMatch(/t\('swap\.openFailed'\)/)
    expect(swap).toMatch(/t\('swap\.linkGone'\)/)
    expect(swap).toMatch(/t\('swap\.unreachableSide'\)/)
    expect(swap).not.toMatch(/linkIsGone \? 'Link not found'/)
    expect(swap).not.toMatch(/We couldn't open your swap link/)
    expect(swap).not.toMatch(/We couldn't reach the server just now/)
    expect(swap).toMatch(/t\('swap\.linkMissing'\)/)
    expect(swap).not.toMatch(/We couldn't find that link\./)
    const cal = src('components/CalendarSync.jsx')
    expect(cal).toMatch(/t\('cal\.rotateFailed'\)/)
    expect(cal).not.toMatch(/Failed to rotate calendar link/)
    const chk = src('pages/Checkin.jsx')
    expect(chk).toMatch(/t\('chk\.serviceNotOnScheduleBody'\)/)
    expect(chk).toMatch(/t\('chk\.serviceOpenFailedBody'\)/)
    expect(chk).not.toMatch(/Nobody has been checked in\. Choose a service from the Schedule to continue/)
  })

  it('leftover keys differ EN vs ES', () => {
    const keys = [
      'chk.serviceNotOnScheduleBody',
      'chk.serviceOpenFailedBody',
      'cal.rotateFailed',
      'swap.linkGone',
      'swap.unreachableSide',
      'swap.linkMissing',
    ]
    for (const k of keys) {
      expect(STRINGS.en[k]).toBeTruthy()
      expect(STRINGS.es[k]).toBeTruthy()
      expect(STRINGS.es[k]).not.toBe(STRINGS.en[k])
    }
  })
})
