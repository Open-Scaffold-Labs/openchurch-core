// App Review 2026-10-26 (Beacon) — key parity for the namespaces this pass
// touched, plus source pins so the fixed English literals cannot creep back.
// Not a translation-quality review: Spanish wording is NOT MEASURED here
// beyond "present, non-empty, and not a copy of English".

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { STRINGS } from './strings'
import { TEMPLATES } from '../../../server/src/notifications/templates.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..')
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const NAMESPACES = ['bul.', 'sched.dlg.', 'sched.type.', 'picker.', 'avatar.', 'notif.', 'register.', 'shell.', 'login.', 'prefs.']
const SINGLE_KEYS = ['sched.awaitingTitle', 'sched.moreN', 'conflicts.doubleBooked', 'orgs.stmtLetterheadPh']

// Pairs that are legitimately identical across locales.
const SAME_OK = new Set([
  'register.rowAction',      // '{action}: {entry}' — pure template
])

const inScope = (k) => NAMESPACES.some(ns => k.startsWith(ns)) || SINGLE_KEYS.includes(k)
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

describe('App Review i18n key parity', () => {
  const enKeys = Object.keys(STRINGS.en).filter(inScope)
  const esKeys = Object.keys(STRINGS.es).filter(inScope)

  it('every touched-namespace key exists in both en and es', () => {
    expect(enKeys.length).toBeGreaterThan(150)
    expect(enKeys.filter(k => !(k in STRINGS.es))).toEqual([])
    expect(esKeys.filter(k => !(k in STRINGS.en))).toEqual([])
  })

  it('no value is empty and interpolation variables match', () => {
    for (const k of enKeys) {
      expect(String(STRINGS.en[k]).trim(), `en ${k}`).not.toBe('')
      expect(String(STRINGS.es[k]).trim(), `es ${k}`).not.toBe('')
      expect(vars(STRINGS.es[k]), k).toEqual(vars(STRINGS.en[k]))
    }
  })

  it('the keys this pass added are actually Spanish, not English copies', () => {
    const added = enKeys.filter(k =>
      k.startsWith('bul.') && !k.startsWith('bul.pull') && !k.startsWith('bul.listFailed')
      || k.startsWith('sched.dlg.') || k.startsWith('sched.type.') || k.startsWith('picker.')
      || k.startsWith('avatar.') || k.startsWith('notif.') || SINGLE_KEYS.includes(k)
      || ['login.invalid', 'login.emptyFields', 'login.rateAccount', 'login.rateNetwork', 'login.failedStatus', 'login.network',
          'prefs.profilePicture', 'prefs.avatarUpdated', 'prefs.avatarRemoved', 'prefs.avatarFailed', 'prefs.avatarSaveFailed',
          'prefs.langInline.en', 'prefs.langInline.es', 'register.actions',
          'shell.skipToContent', 'shell.navDrawer', 'shell.closeNav'].includes(k))
    expect(added.length).toBeGreaterThan(150)
    const copies = added.filter(k => !SAME_OK.has(k) && STRINGS.es[k] === STRINGS.en[k])
    expect(copies).toEqual([])
  })

  it('every server notification type has a client label and description', () => {
    expect(Object.keys(TEMPLATES).length).toBeGreaterThan(10)
    for (const [type, tpl] of Object.entries(TEMPLATES)) {
      // English stays identical to the server copy, so EN users see no change.
      expect(STRINGS.en[`notif.type.${type}.label`], type).toBe(tpl.label)
      expect(STRINGS.en[`notif.type.${type}.desc`], type).toBe(tpl.description)
      expect(STRINGS.es[`notif.type.${type}.label`], type).toBeTruthy()
      expect(STRINGS.es[`notif.type.${type}.desc`], type).toBeTruthy()
    }
  })
})

describe('App Review source pins: fixed English literals stay gone', () => {
  const PINS = {
    'pages/Bulletin.jsx': ['Admins only', 'Bulletin date', "This week's services", 'Pull readings from service plan',
      'Copy public bulletin link', 'Create bulletin', 'No bulletins yet.', 'Replace the current Readings?', 'Bulletin saved',
      'Remove this bulletin?', 'Parish news, events, and notices'],
    'pages/Schedule.jsx': ['Edit Event', 'New Event', 'Assigned Members', 'Auto-fill rotation', 'Save anyway', 'Add anyway',
      'Delete the whole recurring series?', 'Delete this scheduled event?', 'Save & apply to following', 'marked themselves unavailable'],
    'pages/ScheduleConflicts.jsx': ['double-booked'],
    'components/MemberPicker.jsx': ['No matching members', 'Search members to assign'],
    'components/OrderedMemberPicker.jsx': ['No matching members', 'Move up', 'Move down'],
    'components/AvatarUploader.jsx': ['Change photo', 'Upload photo', 'Please choose an image file', 'Square works best'],
    'components/NotificationPrefs.jsx': ['Notification preferences', 'Email delivery is being set up', 'Failed to load preferences'],
    'pages/Preferences.jsx': ['Profile picture updated', 'Profile picture removed', 'Could not update profile picture'],
  }
  for (const [file, phrases] of Object.entries(PINS)) {
    it(`${file} renders its chrome through t()`, () => {
      const src = stripComments(read(file))
      for (const p of phrases) expect(src, `${file}: ${p}`).not.toContain(p)
    })
  }

  it('the shell has a skip link to a focusable main landmark', () => {
    const app = stripComments(read('App.jsx'))
    expect(app).toMatch(/href="#main-content"/)
    expect(app).toMatch(/t\('shell\.skipToContent'\)/)
    expect(app).toMatch(/<main className="oc-fab-clearance [^"]*"[^>]*id="main-content"[^>]*tabIndex=\{-1\}/)
  })

  it('the FAB clearance also clears keyboard focus scrolling', () => {
    const css = read('index.css')
    expect(css).toMatch(/\.oc-fab-clearance\s*\{[^}]*scroll-padding-bottom:/)
  })

  it('Register action column stays pinned visible beside a wide table', () => {
    const reg = stripComments(read('pages/SacramentalRegister.jsx'))
    expect(reg).toMatch(/sticky right-0[^"]*print:hidden/)
    expect(reg).toMatch(/aria-label=\{rowActionLabel\(t\('register\.open'\), r\)\}/)
    expect(reg).toMatch(/aria-label=\{rowActionLabel\(t\('register\.certificate'\), r\)\}/)
  })
})
