#!/usr/bin/env node
// I18N-L1-13 — critical-surface language harness.
//
// Detects two defects on a fixed set of parish journeys:
//   1. Hard-coded user-facing Latin prose (English on a Spanish screen,
//      or an accessible name that never goes through t()).
//   2. A t() key those surfaces resolve — statically or from a same-file
//      enum — that is missing from `en` or from `es`. t() then renders
//      the key itself.
//
// It does not translate. Every prose finding must be classified by hand
// in scripts/i18n-critical-surfaces.classify.json. A new string fails
// the gate until someone reads it and assigns a class. Missing keys are
// not classifiable: they always fail.
//
// What this file refuses to call a finding (automatic, and named so a
// green run cannot be mistaken for a full-app translation audit):
//   - files outside SURFACES (marketing pages, PublicChurch / Spanish
//     About, the chancery app, tests, server errors)
//   - comments, import paths, className tokens, urls, hex colors
//   - the key argument of t()
//   - values inside a local { en, es } dictionary (key parity is checked
//     instead — loginDemo's COPY table)
//   - translation quality (identical en/es wording is NOT MEASURED)
//   - dynamic t() calls this file cannot bind to a closed enum; those
//     are listed under `unresolved` and must stay in the classify file
//     with a reason, or the gate fails closed
//   - variable initializers that are rendered later through an identifier
//     (`{displayRole}`, `{displayName}`). See KNOWN_WALKER_MISSES. The
//     account-menu fallbacks that used to hide there now call t().
//     The classify file is exhaustive for emitted findings only.
//
// Usage:
//   node scripts/i18n-critical-surfaces.mjs
//   node scripts/i18n-critical-surfaces.mjs --list
//   node --test scripts/i18n-critical-surfaces.test.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..')
export const CLASSIFY_PATH = join(HERE, 'i18n-critical-surfaces.classify.json')
export const STRINGS_PATH = join(REPO_ROOT, 'client/src/i18n/strings.js')

export const SURFACES = [
  {
    id: 'shell',
    files: [
      'client/src/App.jsx',
      'client/src/components/GlobalSearchPalette.jsx',
    ],
  },
  {
    id: 'auth',
    files: [
      'client/src/pages/Login.jsx',
      'client/src/pages/Signup.jsx',
      'client/src/pages/ForgotPassword.jsx',
      'client/src/pages/ResetPassword.jsx',
      'client/src/pages/loginDemo.jsx',
    ],
  },
  {
    id: 'audit',
    files: [
      'client/src/pages/Audit.jsx',
    ],
  },
  {
    id: 'schedule',
    files: [
      'client/src/pages/Schedule.jsx',
      'client/src/pages/ScheduleConflicts.jsx',
    ],
  },
  {
    id: 'intentions',
    files: [
      'client/src/pages/MassIntentions.jsx',
      'client/src/pages/SacristySheet.jsx',
      'client/src/components/MassIntentionAssign.jsx',
    ],
  },
  {
    id: 'members',
    files: [
      'client/src/pages/Clients.jsx',
      'client/src/pages/MemberDetail.jsx',
    ],
  },
  {
    id: 'certificate',
    files: [
      'client/src/pages/SacramentCertificate.jsx',
    ],
  },
  {
    id: 'pwa',
    files: [
      'client/src/components/InstallPrompt.jsx',
      'client/src/components/OfflineBanner.jsx',
      'client/src/components/UpdatePrompt.jsx',
    ],
  },
]

export const CLASSES = ['proper-noun', 'identifier', 'format-sample', 'hold']

// Release residuals fixed in this pass. Classifying them as hold must not
// silence the gate — reintroducing the literal is a failure either way.
// `Search` is pinned as jsx-text (`>Search<`) and as jsx-expr
// (`{'Search'}`, `{"Search"}`, or a template with that text).
export const PINNED_ABSENT = [
  { file: 'client/src/App.jsx', kind: 'attr:aria-label', text: 'Open navigation menu' },
  { file: 'client/src/App.jsx', kind: 'attr:aria-label', text: 'Open search' },
  { file: 'client/src/App.jsx', kind: 'attr:title', text: 'Expand sidebar' },
  { file: 'client/src/App.jsx', kind: 'attr:aria-label', text: 'Expand sidebar' },
  { file: 'client/src/App.jsx', kind: 'attr:title', text: 'Collapse sidebar' },
  { file: 'client/src/App.jsx', kind: 'attr:aria-label', text: 'Collapse sidebar' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: 'Search' },
  { file: 'client/src/App.jsx', kind: 'jsx-expr', text: 'Search' },
  // APPLE-PRESENTATION-L2-01 — notification panel, account menu, search palette.
  // Filing any of these as hold must not put the English island back.
  { file: 'client/src/App.jsx', kind: 'return', text: 'just now' },
  { file: 'client/src/App.jsx', kind: 'return', text: '{...}m ago' },
  { file: 'client/src/App.jsx', kind: 'return', text: '{...}h ago' },
  { file: 'client/src/App.jsx', kind: 'return', text: '{...}d ago' },
  { file: 'client/src/App.jsx', kind: 'attr:aria-label', text: 'Notifications, {...} unread' },
  { file: 'client/src/App.jsx', kind: 'attr:aria-label', text: 'Notifications' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: 'Notifications' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: 'Mark all read' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: "This list may be out of date — the last check didn't reach the server." },
  { file: 'client/src/App.jsx', kind: 'jsx-expr', text: "We couldn't check your notifications just now." },
  { file: 'client/src/App.jsx', kind: 'jsx-expr', text: 'No notifications yet' },
  { file: 'client/src/App.jsx', kind: 'jsx-expr', text: 'Event' },
  { file: 'client/src/App.jsx', kind: 'jsx-expr', text: 'Task' },
  { file: 'client/src/App.jsx', kind: 'attr:aria-label', text: 'Account menu for {...}' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: 'Members' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: 'Events' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: 'Tasks' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: 'View Members' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: 'Manage Tasks' },
  { file: 'client/src/App.jsx', kind: 'jsx-text', text: 'Sign Out' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'prop:label', text: 'Members' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'prop:label', text: 'Events' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'prop:label', text: 'Tasks' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'prop:label', text: 'Staff' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'prop:label', text: 'Donations' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'return', text: 'Unknown' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'attr:aria-label', text: 'Search' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'attr:placeholder', text: 'Search members, events, tasks, donations…' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'attr:aria-label', text: 'Search query' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'attr:aria-label', text: 'Close search' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'jsx-text', text: 'All' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'jsx-text', text: 'Recent' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'jsx-text', text: 'Clear' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'jsx-text', text: 'Type to search across your church.' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'jsx-text', text: 'No results for' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'jsx-text', text: 'in' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'jsx-text', text: '↵ to open · Esc to close' },
  { file: 'client/src/components/GlobalSearchPalette.jsx', kind: 'jsx-text', text: 'to reopen anywhere' },
  // APPLE-INTENTIONS-L1-01 — row actions on the intention book.
  // Filing either name as hold must not put the English island back.
  { file: 'client/src/pages/MassIntentions.jsx', kind: 'attr:aria-label', text: 'Edit intention' },
  { file: 'client/src/pages/MassIntentions.jsx', kind: 'attr:aria-label', text: 'Delete intention' },
  // Schedule conflicts primary chrome. Row copy, en-US dates, and am/pm
  // stay classified hold. Filing these literals as hold must not put
  // the page title, lead, empty state, section lines, or the schedule
  // link back.
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'jsx-text', text: 'Schedule conflicts' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'jsx-text', text: 'Same member on two overlapping events. Scanning the next' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'jsx-text', text: 'week' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'attr:aria-label', text: 'Scan {...} weeks' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'attr:title', text: 'No conflicts' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'attr:body', text: 'Every scheduled slot for the next {...} weeks is clear — no member is double-booked.' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'jsx-text', text: 'conflict' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'jsx-text', text: 'across' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'jsx-text', text: 'View in Schedule' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'return', text: 'Week of {...}' },
  { file: 'client/src/pages/ScheduleConflicts.jsx', kind: 'jsx-text', text: 'Failed to scan conflicts' },
]

// Variable initializers are outside the node kinds the walker records, so
// `{displayRole}` does not pull a string back out of the declarator.
// ProfileDropdown's Administrator / OpenChurch Admin / Member fallbacks
// now go through t() (shell.role.*, shell.account.fallbackName, dash.member).
// The list is empty on purpose: a new initializer is not covered until
// someone names it here. `OpenChurch` as the org-name fallback is still
// an initializer; the product wordmark is already a finding where it is
// JSX text or document.title.
export const KNOWN_WALKER_MISSES = []

const USER_ATTRS = new Set([
  'aria-label', 'aria-description', 'aria-roledescription', 'aria-placeholder',
  'placeholder', 'title', 'alt', 'label', 'body',
])

const DATE_LOCALE_CALLEES = new Set(['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'])
const MERIDIEM = new Set(['am', 'pm', 'AM', 'PM'])
const SACRAMENT_ARRAY = /^(SACRAMENT_ORDER|SACRAMENT_TYPES|CERT_TYPES)$/

let parse
export function loadParser() {
  if (parse) return parse
  const candidates = [
    join(REPO_ROOT, 'client'),
    process.cwd(),
    join(process.cwd(), 'client'),
  ]
  let last
  for (const base of candidates) {
    try {
      const require = createRequire(join(base, 'package.json'))
      ;({ parse } = require('@babel/parser'))
      return parse
    } catch (err) {
      last = err
    }
  }
  const error = new Error(
    'i18n-critical-surfaces: @babel/parser is not resolvable. Install client dependencies. Refusing to pass by default.',
  )
  error.cause = last
  throw error
}

function parseSource(src, filename) {
  return loadParser()(src, {
    sourceType: 'module',
    plugins: ['jsx'],
    errorRecovery: false,
    sourceFilename: filename,
  })
}

function walk(node, visit) {
  const stack = []
  const go = (n) => {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return
    visit(n, stack)
    stack.push(n)
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue
      const v = n[k]
      if (Array.isArray(v)) {
        for (const child of v) go(child)
      } else if (v && typeof v.type === 'string') go(v)
    }
    stack.pop()
  }
  go(node)
}

function propName(p) {
  if (!p || p.type !== 'ObjectProperty') return null
  if (p.key.type === 'Identifier' && !p.computed) return p.key.name
  if (p.key.type === 'StringLiteral') return p.key.value
  return null
}

function isTCallee(callee) {
  return callee?.type === 'Identifier' && callee.name === 't'
}

function isTranslationKeyNode(node, stack) {
  const parent = stack[stack.length - 1]
  return parent?.type === 'CallExpression' && isTCallee(parent.callee) && parent.arguments[0] === node
}

function lineOf(node) {
  return node.loc?.start?.line ?? 0
}

function norm(s) {
  return String(s).replace(/\s+/g, ' ').trim()
}

function hasWord(s) {
  return /[A-Za-z]{2,}/.test(s)
}

function isDesignToken(s) {
  if (/dark:|sm:|md:|lg:|xl:|hover:|focus:|print:|[@]/.test(s) && /[:/]/.test(s) && !/\s{2,}/.test(s)) {
    if (/(^|\s)(bg|text|flex|grid|px|py|pt|pb|border|rounded|shadow|font|items|justify|gap|w-|h-|min-|max-|absolute|relative|overflow|transition)-/.test(s) || s.includes('dark:')) {
      return true
    }
  }
  if (/^(bg|text|flex|grid|px|py|border|rounded|shadow|font|items|justify|gap|absolute|relative|overflow|transition)[\w\-:/.[\] ]+$/.test(s) && !/[A-Z][a-z]+ [A-Z]/.test(s)) {
    return s.split(/\s+/).every(tok => /^[\w\-:/.[\]%]+$/.test(tok) && (tok.includes('-') || tok.includes(':') || tok.includes('/')))
  }
  return false
}

const INTL_OPTION_KEYS = new Set([
  'weekday', 'era', 'month', 'day', 'year', 'hour', 'minute', 'second',
  'timeZone', 'hourCycle', 'dayPeriod', 'numberingSystem', 'calendar',
  'dateStyle', 'timeStyle', 'formatMatcher', 'localeMatcher',
])

function isCodeOperand(node, stack) {
  const parent = stack[stack.length - 1]
  if (!parent || node.type !== 'StringLiteral') return false
  if (parent.type === 'BinaryExpression' && /^(===|!==|==|!=)$/.test(parent.operator)) return true
  if (parent.type === 'MemberExpression' && parent.computed && parent.property === node) return true
  if (parent.type === 'CallExpression' && parent.callee?.type === 'MemberExpression' && DATE_LOCALE_CALLEES.has(parent.callee.property?.name || parent.callee.property?.value)) return true
  if (parent.type === 'ObjectProperty' && !String(node.value).includes(' ')) {
    const key = propName(parent)
    if (INTL_OPTION_KEYS.has(key)) return true
  }
  return false
}

function isNonCopy(s) {
  if (!hasWord(s)) return true
  if (isDesignToken(s)) return true
  if (/^https?:\/\//.test(s)) return true
  if (s.startsWith('/') && !s.includes(' ')) return true
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return true
  if (/^[\w.+-]+@[\w.-]+$/.test(s) === false && /^[a-z0-9_./:-]+$/.test(s) && s.includes('/') && !s.includes(' ')) return true
  return false
}

function exprSource(src, node) {
  if (node.start == null || node.end == null) return ''
  return src.slice(node.start, node.end)
}

function templateShape(src, tpl) {
  if (tpl.expressions.length !== 1) return null
  if (tpl.quasis.length !== 2) return null
  const prefix = tpl.quasis[0].value.cooked ?? ''
  const suffix = tpl.quasis[1].value.cooked ?? ''
  if (suffix !== '') return null
  if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)*\.$/.test(prefix)) return null
  return { prefix, expr: tpl.expressions[0], exprText: exprSource(src, tpl.expressions[0]) }
}

function arrayConstants(ast) {
  const arrays = new Map()
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier' || !node.init) return
    let elements = null
    if (node.init.type === 'ArrayExpression') elements = node.init.elements
    else if (node.init.type === 'NewExpression' && node.init.callee?.name === 'Set' && node.init.arguments[0]?.type === 'ArrayExpression') {
      elements = node.init.arguments[0].elements
    } else if (node.init.type === 'NewExpression' && node.init.callee?.name === 'Set' && node.init.arguments[0]?.type === 'Identifier') {
      const inner = arrays.get(node.init.arguments[0].name)
      if (inner) arrays.set(node.id.name, inner)
      return
    }
    if (!elements || elements.some(el => !el || el.type !== 'StringLiteral')) return
    arrays.set(node.id.name, elements.map(el => el.value))
  })
  return arrays
}

function navShaped(ast) {
  const labels = []
  const sections = []
  walk(ast, (node) => {
    if (node.type !== 'ObjectExpression') return
    const props = node.properties.filter(p => p.type === 'ObjectProperty')
    const names = new Set(props.map(propName))
    if (!(names.has('to') && names.has('icon') && names.has('label'))) return
    for (const p of props) {
      const name = propName(p)
      if (name === 'label' && p.value?.type === 'StringLiteral') labels.push(p.value.value)
      if (name === 'section' && p.value?.type === 'StringLiteral') sections.push(p.value.value)
    }
  })
  return { labels, sections }
}

function dictionaryNodes(ast) {
  const nodes = new Set()
  const gaps = []
  walk(ast, (node) => {
    if (node.type !== 'ObjectExpression') return
    const en = node.properties.find(p => propName(p) === 'en' && p.value?.type === 'ObjectExpression')
    const es = node.properties.find(p => propName(p) === 'es' && p.value?.type === 'ObjectExpression')
    if (!en || !es) return
    nodes.add(node)
    nodes.add(en.value)
    nodes.add(es.value)
    const enKeys = new Map()
    const esKeys = new Map()
    for (const p of en.value.properties) {
      const k = propName(p)
      if (k) enKeys.set(k, p)
    }
    for (const p of es.value.properties) {
      const k = propName(p)
      if (k) esKeys.set(k, p)
    }
    for (const k of enKeys.keys()) if (!esKeys.has(k)) gaps.push({ locale: 'es', key: k, line: lineOf(enKeys.get(k)) })
    for (const k of esKeys.keys()) if (!enKeys.has(k)) gaps.push({ locale: 'en', key: k, line: lineOf(esKeys.get(k)) })
  })
  return { nodes, gaps }
}

function inDictionary(stack, dictNodes) {
  return stack.some(n => dictNodes.has(n))
}

function resolveTemplate(shape, stack, arrays, nav, src) {
  const keys = new Set()
  const reasons = []
  if (!shape) return { keys: [], resolved: false }

  if (shape.prefix === 'nav.' && /(^|\.)label$/.test(shape.exprText) && nav.labels.length) {
    for (const label of nav.labels) keys.add(`nav.${label}`)
    reasons.push('nav-object')
  }
  if (shape.prefix === 'navsec.' && /section$/.test(shape.exprText) && nav.sections.length) {
    for (const section of nav.sections) keys.add(`navsec.${section}`)
    reasons.push('nav-section')
  }

  if (shape.expr.type === 'Identifier') {
    for (let i = stack.length - 1; i >= 0; i--) {
      const n = stack[i]
      if (!/Function|Arrow/.test(n.type)) continue
      const params = (n.params || []).filter(p => p.type === 'Identifier').map(p => p.name)
      if (!params.includes(shape.expr.name)) break
      const parent = stack[i - 1]
      const callee = parent?.type === 'CallExpression' ? parent.callee : null
      if (callee?.type === 'MemberExpression' && callee.property?.name === 'map' && callee.object?.type === 'Identifier' && arrays.has(callee.object.name)) {
        for (const item of arrays.get(callee.object.name)) keys.add(`${shape.prefix}${item}`)
        reasons.push(`map:${callee.object.name}`)
      }
      break
    }
  }

  for (const [name, values] of arrays) {
    const needleIncludes = `.includes(${shape.exprText})`
    const needleHas = `.has(${shape.exprText})`
    if (src.includes(`${name}${needleIncludes}`) || src.includes(`${name}${needleHas}`)) {
      for (const item of values) keys.add(`${shape.prefix}${item}`)
      reasons.push(`guard:${name}`)
    }
  }

  if ((shape.prefix === 'sac.' || shape.prefix === 'cert.title.' || shape.prefix === 'cert.phrase.') && /type$/.test(shape.exprText)) {
    for (const [name, values] of arrays) {
      if (!SACRAMENT_ARRAY.test(name)) continue
      for (const item of values) keys.add(`${shape.prefix}${item}`)
      reasons.push(`sacrament:${name}`)
    }
  }

  return { keys: [...keys], resolved: keys.size > 0, via: reasons }
}

function bindingInit(name, stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const n = stack[i]
    if (n.type !== 'FunctionDeclaration' && n.type !== 'FunctionExpression' && n.type !== 'ArrowFunctionExpression' && n.type !== 'Program') continue
    const body = n.type === 'Program' ? n.body : (n.body?.type === 'BlockStatement' ? n.body.body : [])
    if (!Array.isArray(body)) continue
    for (const stmt of body) {
      if (stmt.type !== 'VariableDeclaration') continue
      for (const d of stmt.declarations) {
        if (d.id?.type === 'Identifier' && d.id.name === name) return d.init
      }
    }
  }
  return null
}

export function scanSource(filename, src, surface) {
  const ast = parseSource(src, filename)
  const arrays = arrayConstants(ast)
  const nav = navShaped(ast)
  const dict = dictionaryNodes(ast)
  const findings = new Map()
  const staticKeys = new Set()
  const resolvedKeys = []
  const unresolved = []

  const add = (kind, text, node) => {
    const value = norm(text)
    if (isNonCopy(value)) return
    if (MERIDIEM.has(value) && kind !== 'meridiem') return
    const id = `${filename}|${kind}|${value}`
    const line = lineOf(node)
    const prev = findings.get(id)
    if (prev) {
      if (!prev.lines.includes(line)) prev.lines.push(line)
      return
    }
    findings.set(id, { id, file: filename, surface, kind, text: value, lines: [line] })
  }

  const addTemplateProse = (kind, tpl, node) => {
    const staticBits = tpl.quasis.map(q => q.value.cooked ?? '').join(' ')
    const shown = norm(tpl.quasis.map(q => (q.value.cooked ?? '')).reduce((acc, q, i) => acc + q + (i < tpl.expressions.length ? '{...}' : ''), ''))
    if (!hasWord(staticBits)) return
    add(kind, shown, node)
  }

  const considerProse = (kind, node, stack) => {
    if (inDictionary(stack, dict.nodes)) return
    if (isTranslationKeyNode(node, stack)) return
    if (isCodeOperand(node, stack)) return
    if (node.type === 'StringLiteral') add(kind, node.value, node)
    else if (node.type === 'TemplateLiteral') {
      if (isTranslationKeyNode(node, stack)) return
      if (templateShape(src, node)) return
      addTemplateProse(kind, node, node)
    }
  }

  const walkProseTree = (node, kind, stack) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    if (node.type === 'CallExpression' && isTCallee(node.callee)) return
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') return
    if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') {
      considerProse(kind, node, stack)
      return
    }
    const next = stack.concat(node)
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'range') continue
      const v = node[k]
      if (Array.isArray(v)) v.forEach(c => walkProseTree(c, kind, next))
      else if (v && typeof v.type === 'string') walkProseTree(v, kind, next)
    }
  }

  walk(ast, (node, stack) => {
    if (inDictionary(stack, dict.nodes)) return

    if (node.type === 'JSXText') add('jsx-text', node.value, node)

    if (node.type === 'JSXAttribute' && USER_ATTRS.has(jsxAttrName(node) || '')) {
      const attr = jsxAttrName(node)
      if (node.value?.type === 'StringLiteral') considerProse(`attr:${attr}`, node.value, stack.concat(node))
    }

    if (node.type === 'JSXExpressionContainer' && node.expression && node.expression.type !== 'JSXEmptyExpression') {
      const parent = stack[stack.length - 1]
      const attr = parent?.type === 'JSXAttribute' ? jsxAttrName(parent) : null
      if (!(attr && !USER_ATTRS.has(attr))) {
        const kind = attr ? `attr:${attr}` : 'jsx-expr'
        walkProseTree(node.expression, kind, stack.concat(node))
      }
    }

    if (node.type === 'ObjectProperty' && node.value && ['label', 'title', 'body', 'placeholder'].includes(propName(node))) {
      if (node.value.type === 'StringLiteral' || node.value.type === 'TemplateLiteral') {
        considerProse(`prop:${propName(node)}`, node.value, stack.concat(node))
      }
    }

    if (node.type === 'CallExpression') {
      const callee = node.callee
      if (isTCallee(callee)) collectT(node, stack, { src, arrays, nav, ast, filename, surface, staticKeys, resolvedKeys, unresolved })
      const toast = callee?.type === 'MemberExpression' && callee.object?.type === 'Identifier' && callee.object.name === 'toast'
      const setError = callee?.type === 'Identifier' && callee.name === 'setError'
      if (toast || setError) {
        for (const arg of node.arguments) walkProseTree(arg, toast ? 'toast' : 'setError', stack.concat(node))
      }
      if (callee?.type === 'MemberExpression' && DATE_LOCALE_CALLEES.has(callee.property?.name)) {
        for (const arg of node.arguments) {
          if (arg?.type === 'StringLiteral' && /^en(-[A-Z]{2})?$/.test(arg.value)) {
            add('date-locale', arg.value, arg)
          }
        }
      }
    }

    if (node.type === 'StringLiteral' && MERIDIEM.has(node.value) && !inDictionary(stack, dict.nodes) && !isTranslationKeyNode(node, stack)) {
      add('meridiem', node.value, node)
    }

    if (node.type === 'ReturnStatement' && node.argument && node.argument.type !== 'JSXElement' && node.argument.type !== 'JSXFragment') {
      walkProseTree(node.argument, 'return', stack.concat(node))
    }

    if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression') {
      const obj = node.left.object
      const prop = node.left.property
      if (obj?.type === 'Identifier' && obj.name === 'document' && prop?.name === 'title') {
        walkProseTree(node.right, 'document-title', stack.concat(node))
      }
    }
  })

  for (const f of findings.values()) {
    if (f.kind === 'return' && !f.text.includes(' ') && !/^[A-Z]/.test(f.text)) {
      findings.delete(f.id)
      continue
    }
    if (f.kind === 'return' && /^[a-z0-9_]+$/.test(f.text)) findings.delete(f.id)
    if (f.kind === 'return' && /^[A-Z0-9_]{2,6}$/.test(f.text) && !MERIDIEM.has(f.text)) findings.delete(f.id)
  }

  const unresolvedById = new Map()
  for (const item of unresolved) unresolvedById.set(`${item.file}|${item.template}|${item.expr}`, item)

  return {
    findings: [...findings.values()].map(f => ({ ...f, lines: f.lines.sort((a, b) => a - b) })),
    staticKeys: [...staticKeys],
    resolvedKeys,
    unresolved: [...unresolvedById.values()],
    dictionaryGaps: dict.gaps.map(g => ({ ...g, file: filename, surface })),
  }
}

function jsxAttrName(attr) {
  if (attr.name?.type === 'JSXIdentifier') return attr.name.name
  if (attr.name?.type === 'JSXNamespacedName') return `${attr.name.namespace.name}:${attr.name.name.name}`
  return null
}

function keysFromParamCalls(paramName, stack, ast) {
  if (!ast) return null
  let fnName = null
  let index = -1
  for (let i = stack.length - 1; i >= 0; i--) {
    const n = stack[i]
    if (n.type !== 'ArrowFunctionExpression' && n.type !== 'FunctionExpression' && n.type !== 'FunctionDeclaration') continue
    index = (n.params || []).findIndex(p => p.type === 'Identifier' && p.name === paramName)
    if (index < 0) return null
    if (n.id?.type === 'Identifier') fnName = n.id.name
    else {
      const parent = stack[i - 1]
      if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') fnName = parent.id.name
    }
    break
  }
  if (!fnName || index < 0) return null
  const keys = []
  let partial = false
  walk(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier' || node.callee.name !== fnName) return
    const arg = node.arguments[index]
    if (!arg) return
    if (arg.type === 'StringLiteral') keys.push(arg.value)
    else partial = true
  })
  if (!keys.length) return null
  return { keys, partial }
}

function collectT(call, stack, ctx) {
  const arg = call.arguments[0]
  if (!arg) return
  harvestKeyExpr(arg, stack.concat(call), ctx, lineOf(call))
}

function harvestKeyExpr(node, stack, ctx, line) {
  if (!node) return
  if (node.type === 'StringLiteral') {
    ctx.staticKeys.add(node.value)
    ctx.resolvedKeys.push({ key: node.value, file: ctx.filename, surface: ctx.surface, via: 'static', line })
    return
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    harvestKeyExpr(node.consequent || node.left, stack, ctx, line)
    harvestKeyExpr(node.alternate || node.right, stack, ctx, line)
    return
  }
  if (node.type === 'Identifier') {
    const init = bindingInit(node.name, stack)
    if (init && init !== node && (init.type === 'StringLiteral' || init.type === 'TemplateLiteral' || init.type === 'ConditionalExpression')) {
      harvestKeyExpr(init, stack, ctx, line)
      return
    }
    const fromCalls = keysFromParamCalls(node.name, stack, ctx.ast)
    if (fromCalls && !fromCalls.partial && fromCalls.keys.length) {
      for (const key of fromCalls.keys) {
        ctx.staticKeys.add(key)
        ctx.resolvedKeys.push({ key, file: ctx.filename, surface: ctx.surface, via: `param:${node.name}`, line })
      }
      return
    }
    ctx.unresolved.push({
      file: ctx.filename,
      surface: ctx.surface,
      template: `t(${node.name})`,
      expr: node.name,
      line,
    })
    return
  }
  if (node.type === 'TemplateLiteral') {
    const shape = templateShape(ctx.src, node)
    if (!shape) {
      const shown = node.quasis.map((q, i) => (q.value.cooked ?? '') + (node.expressions[i] ? '${...}' : '')).join('')
      ctx.unresolved.push({
        file: ctx.filename,
        surface: ctx.surface,
        template: norm(shown),
        expr: node.expressions.map(e => exprSource(ctx.src, e)).join(','),
        line,
      })
      return
    }
    const resolved = resolveTemplate(shape, stack, ctx.arrays, ctx.nav, ctx.src)
    if (!resolved.resolved) {
      ctx.unresolved.push({
        file: ctx.filename,
        surface: ctx.surface,
        template: `${shape.prefix}\${${shape.exprText}}`,
        expr: shape.exprText,
        line,
      })
      return
    }
    for (const key of resolved.keys) {
      ctx.resolvedKeys.push({ key, file: ctx.filename, surface: ctx.surface, via: resolved.via.join('+'), line })
    }
  }
}

export function localeTables(src, filename = STRINGS_PATH) {
  const ast = parseSource(src, filename)
  let tables = null
  walk(ast, (node) => {
    if (node.type !== 'ObjectExpression') return
    const en = node.properties.find(p => propName(p) === 'en' && p.value?.type === 'ObjectExpression')
    const es = node.properties.find(p => propName(p) === 'es' && p.value?.type === 'ObjectExpression')
    if (!en || !es) return
    const read = (obj) => {
      const map = new Map()
      for (const p of obj.properties) {
        const k = propName(p)
        if (!k || p.type !== 'ObjectProperty') continue
        const value = p.value?.type === 'StringLiteral' ? p.value.value : null
        map.set(k, value)
      }
      return map
    }
    tables = { en: read(en.value), es: read(es.value) }
  })
  if (!tables) throw new Error(`${filename}: could not find both an en and an es string table`)
  return tables
}

export function unresolvedId(item) {
  return `${item.file}|${item.template}|${item.expr}`
}

export function loadClassification(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!data || typeof data !== 'object' || !data.entries || !data.unresolved) {
    throw new Error('classify file must have entries and unresolved')
  }
  return data
}

export function evaluate(scan, tables, classification) {
  const problems = []
  const findingIds = new Set(scan.findings.map(f => f.id))
  const entryIds = new Set(Object.keys(classification.entries || {}))

  for (const f of scan.findings) {
    if (PINNED_ABSENT.some(p => p.file === f.file && p.kind === f.kind && p.text === f.text)) {
      problems.push(`REINTRODUCED ${f.id}`)
    }
    const entry = classification.entries[f.id]
    if (!entry) {
      problems.push(`UNCLASSIFIED ${f.id} (${f.surface}, lines ${f.lines.join(',')})`)
      continue
    }
    if (!CLASSES.includes(entry.class)) {
      problems.push(`BAD CLASS ${f.id}: ${entry.class}`)
    }
    if (typeof entry.note !== 'string' || !entry.note.trim()) {
      problems.push(`MISSING NOTE ${f.id}`)
    }
  }
  for (const id of entryIds) {
    if (!findingIds.has(id)) problems.push(`STALE CLASSIFICATION ${id}`)
  }

  const seenKey = new Set()
  for (const item of scan.resolvedKeys) {
    const token = `${item.file}|${item.key}`
    if (seenKey.has(token)) continue
    seenKey.add(token)
    for (const locale of ['en', 'es']) {
      if (!tables[locale].has(item.key)) {
        problems.push(`MISSING ${locale} ${item.key} (${item.file} via ${item.via}, line ${item.line})`)
      } else if (tables[locale].get(item.key) === '') {
        problems.push(`EMPTY ${locale} ${item.key} (${item.file})`)
      }
    }
  }

  for (const gap of scan.dictionaryGaps) {
    problems.push(`LOCAL DICTIONARY missing ${gap.locale} "${gap.key}" (${gap.file}:${gap.line})`)
  }

  const foundUnresolved = new Set(scan.unresolved.map(unresolvedId))
  const listed = new Map((classification.unresolved || []).map(item => [item.id, item]))
  for (const id of foundUnresolved) {
    const entry = listed.get(id)
    if (!entry) problems.push(`UNRESOLVED NOT LISTED ${id}`)
    else if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`UNRESOLVED MISSING REASON ${id}`)
  }
  for (const id of listed.keys()) {
    if (!foundUnresolved.has(id)) problems.push(`STALE UNRESOLVED ${id}`)
  }

  return { ok: problems.length === 0, problems }
}

export function auditSources(sources, tables, classification) {
  const merged = { findings: [], resolvedKeys: [], unresolved: [], dictionaryGaps: [] }
  for (const source of sources) {
    const scan = scanSource(source.file, source.src, source.surface)
    merged.findings.push(...scan.findings)
    merged.resolvedKeys.push(...scan.resolvedKeys)
    merged.unresolved.push(...scan.unresolved)
    merged.dictionaryGaps.push(...scan.dictionaryGaps)
  }
  merged.findings.sort((a, b) => a.id.localeCompare(b.id))
  return { scan: merged, result: evaluate(merged, tables, classification) }
}

export function repoSources(root = REPO_ROOT) {
  const sources = []
  for (const surface of SURFACES) {
    for (const file of surface.files) {
      const abs = join(root, file)
      sources.push({ file, surface: surface.id, src: readFileSync(abs, 'utf8') })
    }
  }
  return sources
}

export function auditRepo(root = REPO_ROOT, classification = loadClassification(readFileSync(CLASSIFY_PATH, 'utf8'))) {
  const tables = localeTables(readFileSync(join(root, 'client/src/i18n/strings.js'), 'utf8'))
  return auditSources(repoSources(root), tables, classification)
}

function summary(scan) {
  const byClass = {}
  const bySurface = {}
  for (const f of scan.findings) {
    bySurface[f.surface] = (bySurface[f.surface] || 0) + 1
  }
  return { findings: scan.findings.length, bySurface, unresolved: scan.unresolved.length, byClass }
}

function dumpScan() {
  const tables = localeTables(readFileSync(STRINGS_PATH, 'utf8'))
  const sources = repoSources()
  const merged = { findings: [], resolvedKeys: [], unresolved: [], dictionaryGaps: [] }
  for (const source of sources) {
    const scan = scanSource(source.file, source.src, source.surface)
    merged.findings.push(...scan.findings)
    merged.resolvedKeys.push(...scan.resolvedKeys)
    merged.unresolved.push(...scan.unresolved)
    merged.dictionaryGaps.push(...scan.dictionaryGaps)
  }
  const missing = []
  const seen = new Set()
  for (const item of merged.resolvedKeys) {
    const token = `${item.file}|${item.key}`
    if (seen.has(token)) continue
    seen.add(token)
    for (const locale of ['en', 'es']) {
      if (!tables[locale].has(item.key)) missing.push({ locale, ...item })
    }
  }
  console.log(JSON.stringify({
    findings: merged.findings,
    missing,
    unresolved: merged.unresolved,
    dictionaryGaps: merged.dictionaryGaps,
  }, null, 2))
}

function main() {
  if (process.argv.includes('--dump')) {
    dumpScan()
    return
  }
  const list = process.argv.includes('--list')
  let classification
  try {
    classification = loadClassification(readFileSync(CLASSIFY_PATH, 'utf8'))
  } catch (err) {
    console.error(`\ni18n-critical-surfaces: ${err.message}`)
    console.error('Refusing to pass without a classification file.\n')
    process.exit(1)
  }
  let audited
  try {
    audited = auditRepo(REPO_ROOT, classification)
  } catch (err) {
    console.error(`\ni18n-critical-surfaces: ${err.message}\n`)
    process.exit(1)
  }
  if (list) {
    for (const f of audited.scan.findings) {
      const entry = classification.entries[f.id]
      console.log(`${entry?.class || 'UNCLASSIFIED'}\t${f.surface}\t${f.kind}\t${f.file}:${f.lines.join(',')}\t${f.text}`)
    }
    if (audited.scan.unresolved.length) {
      console.log('\n# unresolved dynamic keys')
      for (const item of audited.scan.unresolved) console.log(`${unresolvedId(item)}`)
    }
  }
  if (!audited.result.ok) {
    console.error(`\ni18n-critical-surfaces: ${audited.result.problems.length} problem(s)\n`)
    for (const p of audited.result.problems) console.error(`  ${p}`)
    console.error('\nClassify new prose by hand. Do not auto-translate identifiers, proper nouns, samples, or backend errors.\n')
    process.exit(1)
  }
  const counts = {}
  for (const f of audited.scan.findings) {
    const c = classification.entries[f.id].class
    counts[c] = (counts[c] || 0) + 1
  }
  const surfaces = summary(audited.scan).bySurface
  console.log(`i18n-critical-surfaces: ${audited.scan.findings.length} classified prose findings (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}).`)
  console.log(`  surfaces: ${Object.entries(surfaces).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  console.log(`  resolved keys checked in en+es: ${new Set(audited.scan.resolvedKeys.map(k => k.file + '|' + k.key)).size}`)
  console.log(`  unresolved dynamic (NOT MEASURED, listed): ${audited.scan.unresolved.length}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
