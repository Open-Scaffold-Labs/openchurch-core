// QUALITY-L2-17 — the shell must not carry an unused lucide binding.
// Re-importing `X` without a reference goes red. Using the icon (a real
// JSX or value reference) stays green.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import { describe, it, expect } from 'vitest'

const traverse = _traverse.default ?? _traverse
const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.jsx'), 'utf8')

function unusedImports(src) {
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx'] })
  const imports = []
  const used = new Set()
  traverse(ast, {
    ImportDeclaration(p) {
      for (const s of p.node.specifiers) {
        imports.push({ name: s.local.name, from: p.node.source.value, line: p.node.loc.start.line })
      }
    },
    Identifier(p) {
      if (p.parent.type === 'ImportSpecifier' || p.parent.type === 'ImportDefaultSpecifier' || p.parent.type === 'ImportNamespaceSpecifier') return
      if (p.parent.type === 'ImportDeclaration') return
      if (p.parent.type === 'MemberExpression' && p.parent.property === p.node && !p.parent.computed) return
      if (p.parent.type === 'ObjectProperty' && p.parent.key === p.node && !p.parent.computed && !p.parent.shorthand) return
      used.add(p.node.name)
    },
    JSXIdentifier(p) {
      used.add(p.node.name)
    },
  })
  return imports.filter(i => !used.has(i.name))
}

describe('QUALITY-L2-17 shell imports', () => {
  it('App.jsx has no unused import, including lucide X', () => {
    const dead = unusedImports(APP)
    expect(dead, dead.map(d => `${d.name} from ${d.from}:${d.line}`).join('\n')).toEqual([])
  })
})
