// client-scope — the checks `vite build` does not perform.
//
// HISTORY, because it explains every design choice below.
//
// 26 Aug: client/src/pages/Tasks.jsx shipped a green `vite build` with
// `setTasksFailed` never declared. The bundler does not resolve free
// identifiers, so the ReferenceError waited for a user to hit the error path.
//
// 27 Aug: the first version of THIS gate was itself audited and found to fail
// open three ways — it was file-scoped rather than function-scoped, its
// comment-stripping regex treated `accept="image/*"` as the start of a block
// comment and blanked 28 lines of real code, and its locale-block detection
// broke on a single extra space. All three were demonstrated, not theorised.
// It was rewritten on a real parser. A gate that fails open is worse than no
// gate, because it is also a claim.
//
// WHAT IT ENFORCES
//   1. Every referenced identifier resolves — to a binding in an enclosing
//      scope, an import, or a known global. Catches the 26 Aug defect and the
//      `AlertCircle` used-but-never-imported defect found 27 Aug.
//   2. Every STATIC t('key') exists in both `en` and `es`. t() falls back to
//      returning the key, so an en-only key renders the literal "some.key".
//   3. Dynamic t(`prefix.${x}`) keys are REPORTED, not checked — see below.
//
// WHAT IT DOES NOT ENFORCE, stated so nobody mistakes green for coverage:
//   - t(variable) and t(`${...}`) keys cannot be resolved statically. They are
//     counted and printed so the number is visible rather than implied.
//   - Runtime behaviour of any kind. This is a scope and string check.

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// Resolved from client/node_modules — the CI step must run AFTER the client
// install. Missing parser is a HARD FAILURE: silently skipping would turn
// this gate into a green check that verified nothing.
const require = createRequire(join(process.cwd(), 'client/'))
let parse
try {
  ;({ parse } = require('@babel/parser'))
} catch {
  console.error('\nclient-scope: @babel/parser not resolvable from client/node_modules.')
  console.error('This gate parses real JSX and will not run without it. Install client')
  console.error('dependencies before this step. Refusing to pass by default.\n')
  process.exit(1)
}

const ROOTS = ['client/src', 'client-diocese/src']
const STRINGS = {
  'client/src': 'client/src/i18n/strings.js',
  'client-diocese/src': 'client-diocese/src/i18n/strings.js',
}

const GLOBALS = new Set([
  'window','document','console','fetch','localStorage','sessionStorage','navigator',
  'location','history','setTimeout','clearTimeout','setInterval','clearInterval',
  'requestAnimationFrame','cancelAnimationFrame','queueMicrotask','structuredClone',
  'Promise','Array','Object','String','Number','Boolean','Math','JSON','Date','RegExp',
  'Error','TypeError','RangeError','Map','Set','WeakMap','WeakSet','Symbol','BigInt',
  'Intl','URL','URLSearchParams','FormData','Blob','File','FileReader','Image','Audio',
  'AbortController','Event','CustomEvent','IntersectionObserver','ResizeObserver',
  'MutationObserver','matchMedia','getComputedStyle','alert','confirm','prompt','crypto',
  'performance','process','globalThis','undefined','NaN','Infinity','isNaN','isFinite',
  'parseInt','parseFloat','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'Uint8Array','ArrayBuffer','TextEncoder','TextDecoder','Notification','WebSocket','Worker',
  'HTMLElement','Node','DOMParser','btoa','atob','scrollTo','open','close','print','React',
  // Service-worker context (client/src/sw.js runs as a worker, not a page).
  'self','caches','clients','skipWaiting','registration','importScripts',
  // Added 27 Aug after an audit: every one of these is legitimate and was
  // being reported. A hand-maintained list plus a false positive is how a
  // gate gets `continue-on-error`'d, so the bar for adding is "real global",
  // not "currently used in this repo".
  'Response','Headers','Request','FormDataEvent','KeyboardEvent','MouseEvent',
  'PointerEvent','TouchEvent','DragEvent','FocusEvent','InputEvent','Element',
  'screen','innerWidth','innerHeight','outerWidth','outerHeight','scrollX','scrollY',
  'requestIdleCallback','cancelIdleCallback','XMLHttpRequest','Reflect','Proxy',
  'SyntaxError','ReferenceError','EvalError','URIError','AggregateError',
  'indexedDB','PerformanceObserver','ReadableStream','WritableStream','TransformStream',
  'MessageChannel','BroadcastChannel','SharedWorker','Headers','AbortSignal',
  'arguments','NodeList','DOMRect','CSS','visualViewport','speechSynthesis',
])

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.jsx?$/.test(p) && !/\.test\.jsx?$/.test(p)) out.push(p)
  }
  return out
}

// --- locale keys -----------------------------------------------------------
// Parsed, not regexed. The previous version located the `en`/`es` blocks by
// matching the literal string '  en: {'; adding one space silently disabled
// the entire check while still printing success.
function localeKeys(path) {
  const src = readFileSync(path, 'utf8')          // throws if absent — deliberate
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx'] })
  const out = {}
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'ObjectProperty' && ['en', 'es'].includes(node.key?.name)
        && node.value?.type === 'ObjectExpression') {
      out[node.key.name] = new Set(
        node.value.properties
          .filter(p => p.type === 'ObjectProperty')
          .map(p => p.key?.value ?? p.key?.name)
          .filter(Boolean))
    }
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(ast.program)
  if (!out.en || !out.es) {
    throw new Error(`${path}: could not find both an \`en\` and an \`es\` string table`)
  }
  return out
}

// --- scope analysis --------------------------------------------------------
// A real scope chain. The previous version pooled every declaration in a file
// into one bucket, so a setter declared inside one component cleared a typo of
// the same name inside a sibling component. Demonstrated on Tasks.jsx.
class Scope {
  constructor(parent) { this.parent = parent; this.names = new Set() }
  add(n) { if (n) this.names.add(n) }
  has(n) { return this.names.has(n) || (this.parent ? this.parent.has(n) : false) }
}

function bindPattern(node, scope) {
  if (!node) return
  switch (node.type) {
    case 'Identifier': scope.add(node.name); break
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') bindPattern(p.argument, scope)
        else bindPattern(p.value, scope)
      }
      break
    case 'ArrayPattern': node.elements.forEach(e => bindPattern(e, scope)); break
    case 'AssignmentPattern': bindPattern(node.left, scope); break
    case 'RestElement': bindPattern(node.argument, scope); break
  }
}

const problems = []

function analyse(file, ast) {
  const module = new Scope(null)

  // Hoist module-level bindings first — order of declaration within a module
  // does not matter for our purposes.
  const hoist = (body, scope) => {
    for (const n of body) {
      if (n.type === 'ImportDeclaration') n.specifiers.forEach(s => scope.add(s.local.name))
      else if (n.type === 'VariableDeclaration') n.declarations.forEach(d => bindPattern(d.id, scope))
      else if (n.type === 'FunctionDeclaration' && n.id) scope.add(n.id.name)
      else if (n.type === 'ClassDeclaration' && n.id) scope.add(n.id.name)
      else if (n.type === 'ExportNamedDeclaration' && n.declaration) hoist([n.declaration], scope)
      else if (n.type === 'ExportDefaultDeclaration' && n.declaration?.id) scope.add(n.declaration.id.name)
    }
  }
  hoist(ast.program.body, module)

  const dynamicKeys = []

  const visit = (node, scope, parent) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return

    // New scope for anything with parameters or a block of its own.
    let inner = scope
    if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod'
        || node.type === 'ObjectMethod') {
      inner = new Scope(scope)
      ;(node.params || []).forEach(p => bindPattern(p, inner))
      if (node.body?.type === 'BlockStatement') hoistBlock(node.body.body, inner)
    } else if (/Function(Declaration|Expression)|ArrowFunctionExpression|CatchClause/.test(node.type)) {
      inner = new Scope(scope)
      if (node.id?.name) inner.add(node.id.name)
      ;(node.params || []).forEach(p => bindPattern(p, inner))
      if (node.param) bindPattern(node.param, inner)
      if (node.body?.type === 'BlockStatement') {
        hoistBlock(node.body.body, inner)
        hoistVars(node.body, inner)   // `var` ignores blocks; bind at the function
      }
    } else if (node.type === 'BlockStatement' && parent && !/Function|Arrow|CatchClause/.test(parent.type)) {
      inner = new Scope(scope)
      hoistBlock(node.body, inner)
    } else if (node.type === 'SwitchStatement') {
      inner = new Scope(scope)
      for (const c of node.cases) hoistBlock(c.consequent, inner)
    } else if (node.type === 'ForStatement' || node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      inner = new Scope(scope)
      if (node.init?.type === 'VariableDeclaration') node.init.declarations.forEach(d => bindPattern(d.id, inner))
      if (node.left?.type === 'VariableDeclaration') node.left.declarations.forEach(d => bindPattern(d.id, inner))
    }

    // The check: a referenced identifier must resolve somewhere.
    if (node.type === 'Identifier' && parent) {
      const skip =
        parent.type === 'MetaProperty' ||
        parent.type === 'PrivateName' ||
        (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
        (parent.type === 'OptionalMemberExpression' && parent.property === node && !parent.computed) ||
        (parent.type === 'ObjectProperty' && parent.key === node && !parent.computed) ||
        (parent.type === 'ObjectMethod' && parent.key === node) ||
        (parent.type === 'ClassMethod' && parent.key === node) ||
        ((parent.type === 'ClassProperty' || parent.type === 'PropertyDefinition' ||
          parent.type === 'ClassPrivateProperty') && parent.key === node) ||
        (parent.type === 'JSXAttribute' && parent.name === node) ||
        parent.type === 'JSXAttribute' ||
        (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' ||
         parent.type === 'ImportNamespaceSpecifier') ||
        (parent.type === 'ExportSpecifier') ||
        (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
         parent.type === 'ContinueStatement')
      if (!skip && !GLOBALS.has(node.name) && !inner.has(node.name)) {
        problems.push(`${file}:${node.loc.start.line} :: \`${node.name}\` is used but never declared or imported`)
      }
    }

    // JSX component references are identifiers too, but live in a different slot.
    if (node.type === 'JSXOpeningElement') {
      // Two shapes: <Foo> (JSXIdentifier) and <Foo.Bar> / <a.b.c>
      // (JSXMemberExpression, whose ROOT object is the real reference).
      // The root object is what must resolve — missing it is how
      // `<motion.div>` with no framer-motion import passed this gate and
      // `vite build` together on 27 Aug, across 57 files.
      let root = node.name
      let label = null
      if (root.type === 'JSXMemberExpression') {
        const parts = []
        while (root.type === 'JSXMemberExpression') { parts.unshift(root.property.name); root = root.object }
        label = `${root.name}.${parts.join('.')}`
      }
      if (root.type === 'JSXIdentifier') {
        const isComponent = /^[A-Z]/.test(root.name) || label !== null
        if (isComponent && !GLOBALS.has(root.name) && !inner.has(root.name)) {
          problems.push(`${file}:${node.loc.start.line} :: <${label ?? root.name}> is used but \`${root.name}\` is never imported or defined`)
        }
      }
    }

    // t('key') — static only; dynamic keys are counted, not silently dropped.
    if ((node.type === 'CallExpression') && node.callee?.type === 'Identifier' && node.callee.name === 't') {
      const arg = node.arguments[0]
      if (arg?.type === 'StringLiteral') node.__tKey = arg.value
      else if (arg) dynamicKeys.push(`${file}:${node.loc.start.line}`)
    }

    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue
      const v = node[k]
      if (Array.isArray(v)) v.forEach(c => visit(c, inner, node))
      else if (v && typeof v.type === 'string') visit(v, inner, node)
    }
  }

  // `var` is function-scoped. hoistBlock binds it to whatever block it sits
  // in, so `if (c) { var v = 1 } return v` reported `v` as free. Walk the
  // whole function body (stopping at nested functions, which own their vars).
  const hoistVars = (node, scope) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    if (/Function(Declaration|Expression)|ArrowFunctionExpression/.test(node.type)) return
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      node.declarations.forEach(d => bindPattern(d.id, scope))
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue
      const v = node[k]
      if (Array.isArray(v)) v.forEach(c => hoistVars(c, scope))
      else if (v && typeof v.type === 'string') hoistVars(v, scope)
    }
  }

  const hoistBlock = (body, scope) => {
    for (const n of body) {
      if (n.type === 'VariableDeclaration') n.declarations.forEach(d => bindPattern(d.id, scope))
      else if (n.type === 'FunctionDeclaration' && n.id) scope.add(n.id.name)
      else if (n.type === 'ClassDeclaration' && n.id) scope.add(n.id.name)
    }
  }

  hoistVars(ast.program, module)   // module-level `var`
  visit(ast.program, module, null)
  return dynamicKeys
}

function staticTKeys(ast) {
  const keys = []
  const visit = node => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier'
        && node.callee.name === 't' && node.arguments[0]?.type === 'StringLiteral') {
      keys.push({ key: node.arguments[0].value, line: node.loc.start.line })
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue
      const v = node[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(ast.program)
  return keys
}

let scanned = 0
let dynamicTotal = 0

for (const root of ROOTS) {
  let files
  try {
    files = walk(root)
  } catch (err) {
    // ENOENT on the ROOT itself is the only acceptable skip — a repo that
    // genuinely has no client-diocese/. Anything else (a broken symlink, a
    // permission problem) previously discarded the entire root while the
    // script still printed its success sentence. Observed 27 Aug: one
    // dangling symlink took client/src's 118 files out of the scan and left
    // exit 0. Fail loudly instead.
    if (err.code === 'ENOENT' && err.path === root) continue
    console.error(`\nclient-scope: could not walk ${root} — ${err.message}`)
    console.error(`Refusing to report success on a partial scan.\n`)
    process.exit(1)
  }
  if (!files.length) {
    console.error(`\nclient-scope: ${root} produced no files to scan. That is not a pass.\n`)
    process.exit(1)
  }

  // A root with t() calls MUST have a string table. Previously a missing
  // strings.js silently disabled check 2 for the whole root.
  let keys = null
  try { keys = localeKeys(STRINGS[root]) }
  catch (err) { keys = { missing: err.message } }

  for (const file of files) {
    scanned++
    const src = readFileSync(file, 'utf8')
    let ast
    try { ast = parse(src, { sourceType: 'module', plugins: ['jsx'] }) }
    catch (err) { problems.push(`${file} :: could not be parsed — ${err.message}`); continue }

    dynamicTotal += analyse(file, ast).length

    const tKeys = staticTKeys(ast)
    if (!tKeys.length) continue
    if (keys.missing) {
      problems.push(`${file} :: uses t() but ${keys.missing}`)
      continue
    }
    for (const { key, line } of tKeys) {
      if (!keys.en.has(key)) problems.push(`${file}:${line} :: t('${key}') has no English string`)
      if (!keys.es.has(key)) problems.push(`${file}:${line} :: t('${key}') has no Spanish string`)
    }
  }
}

if (problems.length) {
  console.error(`\nclient-scope: ${problems.length} problem(s)\n`)
  for (const p of [...new Set(problems)].sort()) console.error(`  ${p}`)
  console.error(`\nA free identifier or a missing locale key survives \`vite build\`.`)
  console.error(`It fails at runtime instead — usually on the error path, where`)
  console.error(`nobody looks until a parish is already looking at it.\n`)
  process.exit(1)
}
console.log(`client-scope: ${scanned} files parsed — every identifier resolves, every static t() key is in both locales.`)
console.log(`             ${dynamicTotal} dynamic t() key(s) are NOT checked (computed at runtime).`)
