// Spanish audit pass 2 — spot-check wiring for Saint findings + #450 deferred
// (Kiosk Try again, check-in kiosk toasts, Events aria labels).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STRINGS } from './strings'

const dir = dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(join(dir, '..', rel), 'utf8')

const PASS2_KEYS = [
  // Spot-check surfaces from the brief
  'don.title',
  'lib.title',
  'tm.title',
  'dio.title',
  'gs.title',
  'fb.title',
  'wb.title',
  // Deferred from #450 / findings
  'kiosk.try_again',
  'kiosk.checkinFail',
  'kiosk.checkinConnFail',
  'chk.kiosk_enabled',
  'chk.new_kiosk_link',
  'chk.kiosk_disabled',
  'chk.kiosk_link_copied',
  'events.aria_title',
  'events.aria_category',
  'events.aria_location',
  // Beacon #459 leftovers
  'tm.name',
  'tm.email',
  'tm.role',
  'tm.joined',
  'tm.adminAccess',
  'tm.loadFailed',
  'lib.emptyTitle',
  'lib.emptyBody',
  'lib.noMatchTitle',
  'lib.noMatchBody',
  'lib.clearFilters',
  'lib.allTypes',
  'lib.type.sermon',
  'lib.type.message',
  'lib.type.devotional',
  'lib.type.announcement',
  'don.add',
  'don.saving',
  'don.addFund',
  'don.adding',
  'don.removeGiftTitle',
  'don.removeGiftBody',
  'don.removeGiftConfirm',
  'don.removeFundTitle',
  'don.removeFundBody',
  'don.voidNamedTitle',
  'don.voidBody',
  'don.voidConfirm',
  'don.cancelRecurringTitle',
  'don.cancelRecurringBody',
  'don.cancelRecurringConfirm',
  // Beacon B-459-8: cash-count confirms + toast fallbacks
  'don.didntVoidGift',
  'don.didntSaveGift',
  'don.didntVoid',
  'don.didntSend',
  'don.didntSaveChanged',
  'don.statementUnchanged',
  'don.providerRefund',
  'don.clear',
  'don.cc.singleTitle',
  'don.cc.singleBody',
  'don.cc.singleConfirm',
  'don.cc.voidTitle',
  'don.cc.voidBody',
  'don.cc.voidConfirm',
  'don.cc.requestTitle',
  'don.cc.requestBody',
  'don.cc.requestConfirm',
  'don.cc.approveTitle',
  'don.cc.approveBody',
  'don.cc.approveConfirm',
  'don.cc.rejectTitle',
  'don.cc.rejectBody',
  'don.cc.noteLabel',
  'don.cc.rejectConfirm',
  'don.cc.deleteTitle',
  'don.cc.deleteConfirm',
  'don.cc.voidedBy',
  'don.cc.voidedNoName',
  'don.cc.voidRequestedBy',
  'don.cc.voidRequestedNoName',
  'don.cc.secondCounterAria',
  // Sample of findings inventory
  'save.saving',
  'save.saved',
  'dict.dictation_is_not_supported_in',
  'att.attendance',
  'att.mark_all_present',
  'att.present',
  'att.absent',
  'swap.try_again',
  'swap.accept',
  'imp.evt.cancel',
  'imp.mem.import_members_from_csv',
  'forms.resp.no_responses_yet',
  'org.has_invited_this_parish_to',
]

describe('Spanish audit pass 2', () => {
  it('en and es have the same keys (full catalog parity)', () => {
    const en = Object.keys(STRINGS.en).sort()
    const es = Object.keys(STRINGS.es).sort()
    expect(es).toEqual(en)
  })

  it('pass-2 keys exist in both locales with Spanish that is not a copy of English', () => {
    // Cognates / schema column lists may match on purpose — exclude those.
    const mayMatch = new Set([
      'imp.evt.title_service_division_date_time',
      'imp.mem.name_email_phone_role_tags',
      'imp.evt.yyyy_mm_dd',
    ])
    for (const key of PASS2_KEYS) {
      expect(STRINGS.en[key], `en missing ${key}`).toBeTruthy()
      expect(STRINGS.es[key], `es missing ${key}`).toBeTruthy()
      if (!mayMatch.has(key)) {
        expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
      }
    }
    expect(STRINGS.es['kiosk.try_again']).toBe('Inténtelo de nuevo')
    expect(STRINGS.es['save.saving']).toBe('Guardando…')
    expect(STRINGS.es['att.present']).toBe('Presente')
    expect(STRINGS.es['chk.kiosk_enabled']).toBe('Quiosco activado')
  })

  it('Kiosk Try again, check-in toasts, and Events aria go through t()', () => {
    const kiosk = src('pages/Kiosk.jsx')
    const checkin = src('pages/Checkin.jsx')
    const events = src('pages/Events.jsx')
    expect(kiosk).toMatch(/t\('kiosk\.try_again'\)/)
    expect(kiosk).toMatch(/t\('kiosk\.checkinFail'\)/)
    expect(kiosk).toMatch(/t\('kiosk\.checkinConnFail'\)/)
    expect(kiosk).not.toMatch(/>\s*Try again\s*</)
    expect(kiosk).not.toMatch(/setFlash\("[^"]*check-in[^"]*"\)/)
    expect(checkin).toMatch(/t\('chk\.kiosk_enabled'\)/)
    expect(checkin).toMatch(/t\('chk\.new_kiosk_link'\)/)
    expect(checkin).toMatch(/t\('chk\.kiosk_disabled'\)/)
    expect(checkin).toMatch(/t\('chk\.kiosk_link_copied'\)/)
    expect(events).toMatch(/aria-label=\{t\('events\.aria_title'\)\}/)
    expect(events).toMatch(/aria-label=\{t\('events\.aria_category'\)\}/)
    expect(events).toMatch(/aria-label=\{t\('events\.aria_location'\)\}/)
  })

  it('Team headers/errors, Library empty/filters, Donations confirms go through t()', () => {
    const team = src('pages/Team.jsx')
    const library = src('pages/Library.jsx')
    const donations = src('pages/Donations.jsx')
    expect(team).toMatch(/t\('tm\.name'\)/)
    expect(team).toMatch(/t\('tm\.email'\)/)
    expect(team).toMatch(/t\('tm\.role'\)/)
    expect(team).toMatch(/t\('tm\.joined'\)/)
    expect(team).toMatch(/t\('tm\.adminAccess'\)/)
    expect(team).toMatch(/t\('tm\.loadFailed'\)/)
    expect(team).not.toMatch(/\['Name', 'Email', 'Role', 'Joined'/)
    expect(library).toMatch(/t\('lib\.emptyTitle'\)/)
    expect(library).toMatch(/t\('lib\.noMatchTitle'\)/)
    expect(library).toMatch(/t\('lib\.clearFilters'\)/)
    expect(library).toMatch(/labelKey: 'lib\.allTypes'/)
    expect(library).toMatch(/labelKey: 'lib\.type\.sermon'/)
    expect(library).toMatch(/t\(o\.labelKey\)/)
    expect(library).toMatch(/t\(meta\.labelKey\)/)
    expect(library).not.toMatch(/\? 'No matching generations' : 'Your library is empty'/)
    expect(donations).toMatch(/t\('don\.add'\)/)
    expect(donations).toMatch(/t\('don\.addFund'\)/)
    expect(donations).toMatch(/t\('don\.removeGiftTitle'\)/)
    expect(donations).toMatch(/t\('don\.removeFundTitle'/)
    expect(donations).toMatch(/t\('don\.voidNamedTitle'/)
    expect(donations).toMatch(/t\('don\.cancelRecurringTitle'\)/)
    expect(donations).not.toMatch(/Remove this gift\?/)
  })

  it('B-459-8: cash-count confirms, void notes and toast fallbacks go through t()', () => {
    const donations = src('pages/Donations.jsx')
    for (const k of ['don.cc.singleTitle', 'don.cc.voidTitle', 'don.cc.requestTitle', 'don.cc.approveTitle',
      'don.cc.rejectTitle', 'don.cc.deleteTitle', 'don.cc.voidedBy', 'don.cc.voidRequestedBy',
      'don.cc.secondCounterAria', 'don.didntVoid', 'don.didntSend', 'don.didntSaveChanged',
      'don.statementUnchanged', 'don.providerRefund']) {
      expect(donations).toContain(`t('${k}'`)
    }
    for (const en of ['Post as a single count?', 'Approve this void?', 'Reject this void request?',
      'Delete this cash-count session?', "That didn't send", "That didn't void", 'Second counter for',
      'Waiting for an admin to approve', "Note (optional)", "inputLabel: 'Reason'"]) {
      expect(donations).not.toContain(en)
    }
    expect(donations).not.toMatch(/"That didn't (save|delete)/)
    expect(STRINGS.es['don.cc.approveBody']).toContain('{reason}')
    expect(STRINGS.es['don.cc.voidTitle']).toContain('{service}')
    expect(STRINGS.es['don.cc.singleBody']).toContain(STRINGS.es['don.singleNotVerified'])
  })

  it('SaveButton, Dictation, Attendance, Import, FeedbackModal use t()', () => {
    expect(src('components/SaveButton.jsx')).toMatch(/t\('save\.saving'\)/)
    expect(src('components/SaveButton.jsx')).toMatch(/t\('save\.saved'\)/)
    expect(src('components/DictationInput.jsx')).toMatch(/t\('dict\.dictation_is_not_supported_in'\)/)
    expect(src('components/AttendanceSection.jsx')).toMatch(/t\('att\.mark_all_present'\)/)
    expect(src('components/ImportEventsModal.jsx')).toMatch(/t\('imp\.evt\.import_events_from_csv'\)/)
    expect(src('components/ImportMembersModal.jsx')).toMatch(/t\('imp\.mem\.import_members_from_csv'\)/)
    expect(src('components/FeedbackModal.jsx')).toMatch(/useLocale/)
  })
})
