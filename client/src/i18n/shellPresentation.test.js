// APPLE-PRESENTATION-L2-01 — notification panel, account menu, and
// GlobalSearchPalette chrome go through strings.js. Restoring a hard-coded
// English island in those surfaces goes red. English copy stays the
// previous sentence; Spanish must differ.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STRINGS } from './strings'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = readFileSync(join(root, 'App.jsx'), 'utf8')
const PALETTE = readFileSync(join(root, 'components/GlobalSearchPalette.jsx'), 'utf8')

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const APP_ABSENT = [
  'Mark all read',
  "We couldn't check your notifications just now.",
  'No notifications yet',
  'View Members',
  'Manage Tasks',
  'Sign Out',
  'OpenChurch Admin',
  'just now',
  'Account menu for',
  "'Administrator'",
  "'Member'",
]

const PALETTE_ABSENT = [
  'Search query',
  'Close search',
  'Type to search across your church.',
  'Search members, events, tasks, donations',
  'to reopen anywhere',
  'No results for',
  "'Unknown'",
  'label: \'Members\'',
  'label: \'Staff\'',
]

const KEYS = [
  'shell.notif.unread',
  'shell.notif.markAll',
  'shell.notif.stale',
  'shell.notif.checkFailed',
  'shell.notif.empty',
  'shell.notif.event',
  'shell.notif.task',
  'shell.account.menu',
  'shell.account.fallbackName',
  'shell.role.admin',
  'shell.role.staff',
  'shell.role.viewer',
  'shell.account.viewMembers',
  'shell.account.manageTasks',
  'shell.account.signOut',
  'shell.search.all',
  'shell.search.recent',
  'shell.search.clear',
  'shell.search.hint',
  'shell.search.placeholder',
  'shell.search.query',
  'shell.search.close',
  'shell.search.noneBefore',
  'shell.search.noneIn',
  'shell.search.footer',
  'shell.search.reopen',
  'shell.search.unknown',
  'aist.agoMinOne',
  'aist.agoMin',
  'aist.agoHourOne',
  'aist.agoHour',
  'aist.agoDayOne',
  'aist.agoDay',
]

describe('APPLE-PRESENTATION-L2-01 shell chrome', () => {
  it('the three surfaces call t() and do not keep the old English literals', () => {
    const app = stripComments(APP)
    const palette = stripComments(PALETTE)
    for (const phrase of APP_ABSENT) expect(app, phrase).not.toContain(phrase)
    for (const phrase of PALETTE_ABSENT) expect(palette, phrase).not.toContain(phrase)
    expect(app).toMatch(/t\('nav\.Notifications'\)/)
    expect(app).toMatch(/t\('shell\.notif\.unread'/)
    expect(app).toMatch(/t\('shell\.notif\.markAll'\)/)
    expect(app).toMatch(/t\('shell\.notif\.stale'\)/)
    expect(app).toMatch(/t\('shell\.notif\.checkFailed'\)/)
    expect(app).toMatch(/t\('shell\.notif\.empty'\)/)
    expect(app).toMatch(/t\('shell\.notif\.event'\)/)
    expect(app).toMatch(/t\('shell\.notif\.task'\)/)
    expect(app).toMatch(/t\('aist\.justNow'\)/)
    expect(app).toMatch(/t\('aist\.agoMinOne'\)/)
    expect(app).toMatch(/t\('aist\.agoMin'/)
    expect(app).toMatch(/t\('aist\.agoHourOne'\)/)
    expect(app).toMatch(/t\('aist\.agoHour'/)
    expect(app).toMatch(/t\('aist\.agoDayOne'\)/)
    expect(app).toMatch(/t\('aist\.agoDay'/)
    expect(app).not.toMatch(/t\('aist\.ago'/)
    expect(app).not.toMatch(/`\$\{[^`]*\}[mhd]`/)
    expect(app).toMatch(/t\('shell\.account\.menu'/)
    expect(app).toMatch(/t\('shell\.account\.signOut'\)/)
    expect(app).toMatch(/t\('shell\.account\.viewMembers'\)/)
    expect(app).toMatch(/t\('shell\.account\.manageTasks'\)/)
    expect(app).toMatch(/t\('dash\.glance\.members'\)/)
    expect(app).toMatch(/t\('dash\.glance\.events'\)/)
    expect(app).toMatch(/t\('dash\.glance\.tasks'\)/)
    expect(palette).toMatch(/t\('shell\.searchShort'\)/)
    expect(palette).toMatch(/t\('shell\.search\.query'\)/)
    expect(palette).toMatch(/t\('shell\.search\.close'\)/)
    expect(palette).toMatch(/t\('shell\.search\.placeholder'\)/)
    expect(palette).toMatch(/t\('shell\.search\.all'\)/)
    expect(palette).toMatch(/t\('shell\.search\.hint'\)/)
    expect(palette).toMatch(/t\('nav\.Members'\)/)
    expect(palette).toMatch(/t\('nav\.Donations'\)/)
    expect(palette).toMatch(/t\('mem\.role\.Staff'\)/)
  })

  it('the new keys exist in en and es, and Spanish does not copy English', () => {
    for (const key of KEYS) {
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(STRINGS.en['shell.notif.markAll']).toBe('Mark all read')
    expect(STRINGS.en['shell.account.signOut']).toBe('Sign Out')
    expect(STRINGS.en['shell.account.fallbackName']).toBe('OpenChurch Admin')
    expect(STRINGS.en['shell.role.admin']).toBe('Administrator')
    expect(STRINGS.en['shell.search.query']).toBe('Search query')
    expect(STRINGS.en['shell.search.placeholder']).toBe('Search members, events, tasks, donations…')
    expect(STRINGS.es['shell.notif.empty']).toBe('Aún no hay notificaciones')
    expect(STRINGS.es['shell.notif.stale']).toBe('Esta lista puede estar desactualizada — la última consulta no llegó al servidor.')
    expect(STRINGS.es['shell.account.signOut']).toBe('Cerrar sesión')
    expect(STRINGS.es['shell.search.hint']).toBe('Escriba para buscar en su iglesia.')
    expect(STRINGS.en['aist.agoMin']).toBe('{n}m ago')
    expect(STRINGS.en['aist.agoHour']).toBe('{n}h ago')
    expect(STRINGS.en['aist.agoDay']).toBe('{n}d ago')
    expect(STRINGS.es['aist.agoMinOne']).toBe('hace un minuto')
    expect(STRINGS.es['aist.agoMin']).toBe('hace {n} minutos')
    expect(STRINGS.es['aist.agoHourOne']).toBe('hace una hora')
    expect(STRINGS.es['aist.agoHour']).toBe('hace {n} horas')
    expect(STRINGS.es['aist.agoDayOne']).toBe('hace un día')
    expect(STRINGS.es['aist.agoDay']).toBe('hace {n} días')
    for (const key of ['aist.agoMinOne', 'aist.agoMin', 'aist.agoHourOne', 'aist.agoHour', 'aist.agoDayOne', 'aist.agoDay']) {
      expect(STRINGS.es[key], key).not.toMatch(/\d+[mhd]\b/)
      expect(STRINGS.es[key], key).not.toMatch(/\{n\}[mhd]/)
    }
  })
})
