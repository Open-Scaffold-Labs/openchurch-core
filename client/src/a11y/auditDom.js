// A11Y-L2-14 — DOM contracts the critical surfaces can actually prove.
//
// Uses the accessible-name algorithm already shipped with Testing Library
// (`dom-accessibility-api`). jsdom does not layout, does not resolve
// `pointer: coarse`, and does not speak. This module therefore refuses
// contrast ratios, hit-test pixels, screen-reader announcements, and
// VoiceOver. Those stay NOT MEASURED in docs/A11Y-L2-14.md.

import { computeAccessibleName, computeAccessibleDescription } from 'dom-accessibility-api'

const INTERACTIVE = 'a[href], button, input, select, textarea, [role="button"], [role="link"]'

export function accessibleName(el) {
  try {
    return computeAccessibleName(el).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

export function accessibleDescription(el) {
  try {
    return computeAccessibleDescription(el).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

function hiddenFromTree(el) {
  return Boolean(el.closest('[aria-hidden="true"]'))
}

function labelElements(el) {
  const out = []
  if (el.labels) {
    for (const label of el.labels) out.push(label)
  }
  const id = el.getAttribute('id')
  if (id && out.length === 0) {
    const root = el.ownerDocument
    for (const label of root.querySelectorAll('label')) {
      if (label.htmlFor === id || label.getAttribute('for') === id) out.push(label)
    }
  }
  const wrap = el.parentElement?.closest?.('label') || el.closest('label')
  if (wrap && !out.includes(wrap)) out.push(wrap)
  return out
}

function controlKind(el) {
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') || '').toLowerCase()
  return type ? `${tag}[type=${type}]` : tag
}

export function auditInteractiveNames(root) {
  const findings = []
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    if (hiddenFromTree(el)) continue
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (type === 'hidden') continue
    const name = accessibleName(el)
    if (!name) {
      findings.push({ code: 'unnamed', control: controlKind(el) })
    }
  }
  return findings
}

// A programmatic name from a <label>, aria-label, or aria-labelledby.
// Placeholder and title do not count: both are the relationship this
// audit exists to catch missing.
export function auditLabelRelationship(root) {
  const findings = []
  for (const el of root.querySelectorAll('input, select, textarea')) {
    if (hiddenFromTree(el)) continue
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue
    const aria = (el.getAttribute('aria-label') || '').trim()
    const labelledBy = (el.getAttribute('aria-labelledby') || '').trim()
    const labels = labelElements(el).filter((label) => label.textContent.replace(/\s+/g, ' ').trim())
    if (!aria && !labelledBy && labels.length === 0) {
      findings.push({
        code: 'unlabeled',
        control: controlKind(el),
        placeholder: el.getAttribute('placeholder') || '',
      })
    }
  }
  return findings
}

export function auditDescribedBy(root) {
  const findings = []
  for (const el of root.querySelectorAll('[aria-describedby]')) {
    if (hiddenFromTree(el)) continue
    const ids = el.getAttribute('aria-describedby').split(/\s+/).filter(Boolean)
    for (const id of ids) {
      const node = el.ownerDocument.getElementById(id)
      const text = node?.textContent?.replace(/\s+/g, ' ').trim() || ''
      if (!text) findings.push({ code: 'describedby-missing', id, control: controlKind(el) })
    }
  }
  return findings
}

export function auditHeadingOrder(root) {
  const findings = []
  let prev = 0
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (hiddenFromTree(h)) continue
    const level = Number(h.tagName[1])
    if (prev && level > prev + 1) {
      findings.push({
        code: 'heading-skip',
        from: prev,
        to: level,
        text: h.textContent.replace(/\s+/g, ' ').trim().slice(0, 80),
      })
    }
    prev = level
  }
  return findings
}

export function auditFocusable(root) {
  const findings = []
  for (const el of root.querySelectorAll('a[href], button, input, select, textarea')) {
    if (hiddenFromTree(el)) continue
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (type === 'hidden') continue
    if (el.hasAttribute('disabled')) continue
    if (el.getAttribute('tabindex') === '-1') {
      findings.push({
        code: 'removed-from-tab-order',
        control: controlKind(el),
        name: accessibleName(el),
      })
    }
  }
  return findings
}

export function auditDialogs(root) {
  const findings = []
  for (const el of root.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    if (hiddenFromTree(el)) continue
    if (!accessibleName(el)) findings.push({ code: 'dialog-unnamed', role: el.getAttribute('role') })
    const described = (el.getAttribute('aria-describedby') || '').trim()
    if (described) {
      for (const id of described.split(/\s+/).filter(Boolean)) {
        const node = el.ownerDocument.getElementById(id)
        const text = node?.textContent?.replace(/\s+/g, ' ').trim() || ''
        if (!text) findings.push({ code: 'dialog-describedby-missing', id })
      }
    }
  }
  return findings
}

export function auditLive(root) {
  const findings = []
  for (const el of root.querySelectorAll('[aria-live]')) {
    const value = el.getAttribute('aria-live')
    if (value !== 'polite' && value !== 'assertive' && value !== 'off') {
      findings.push({ code: 'aria-live-invalid', value: value || '' })
    }
  }
  return findings
}

export function auditSurface(root) {
  return [
    ...auditInteractiveNames(root),
    ...auditLabelRelationship(root),
    ...auditDescribedBy(root),
    ...auditHeadingOrder(root),
    ...auditFocusable(root),
    ...auditDialogs(root),
    ...auditLive(root),
  ]
}
