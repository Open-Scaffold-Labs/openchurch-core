// OC-WEB-1 PR-C — OpenChurch-owned site document validate / sanitize.
//
// Persistence is ochr_site_documents (migration 142). Dale's
// createWebsiteSchema is never called. Block HTML helpers from the
// vendored @openscaffold/website libraries stay available for later
// SSR; the public JSON API returns structured bilingual blocks so the
// React client can render them accessibly.

import { createRequire } from 'node:module'
import {
  isAllowedBlockType,
  isAllowedLookId,
  DEFAULT_LOOK_ID,
  OC_V1_BLOCK_TYPES,
  OC_V1_BLOCK_REJECTED,
} from './allowlist.js'
import { normalizeBilingual, isBilingualObject, MAX_SHORT } from './bilingual.js'

const require = createRequire(import.meta.url)
const {
  listSectionBlocks,
  listOfficialLooks,
  resolveOfficialLook,
  deriveWebsiteTheme,
  UPSTREAM,
} = require('../lib/openscaffold-website/index.js')

export const SITE_DOC_VERSION = 1
export const MAX_PAGES = 8
export const MAX_BLOCKS_PER_PAGE = 24
export const MAX_DOC_BYTES = 200_000

const HTTPS_RE = /^https:\/\//i

function trimStr(v, max = 500) {
  if (typeof v !== 'string') return ''
  return v.trim().slice(0, max)
}

function safeHttpsOrPath(url, { allowRelative = false } = {}) {
  if (typeof url !== 'string') return null
  const raw = url.trim()
  if (!raw || raw.length > 500) return null
  if (allowRelative && raw.startsWith('/') && !raw.startsWith('//')) {
    if (raw.includes('://') || raw.includes('\\')) return null
    return raw.slice(0, 500)
  }
  if (!HTTPS_RE.test(raw)) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    return u.toString()
  } catch {
    return null
  }
}

function normalizeFaqItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const question = normalizeBilingual(raw.question, { max: MAX_SHORT })
  const answer = normalizeBilingual(raw.answer, { max: 2000 })
  if (!question.en && !question.es) return null
  return { question, answer }
}

function normalizeTeamMember(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = normalizeBilingual(raw.name, { max: MAX_SHORT })
  const role = normalizeBilingual(raw.role ?? raw.title, { max: MAX_SHORT })
  if (!name.en && !name.es) return null
  return { name, role }
}

function normalizeDocumentItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = normalizeBilingual(raw.title, { max: MAX_SHORT })
  const url = safeHttpsOrPath(raw.url, { allowRelative: true })
  const category = normalizeBilingual(raw.category ?? 'PDF', { max: 40, fallbackEn: 'PDF' })
  if ((!title.en && !title.es) || !url) return null
  return { title, url, category }
}

function normalizeEventItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = normalizeBilingual(raw.title, { max: MAX_SHORT })
  const date = trimStr(raw.date, 40)
  const place = normalizeBilingual(raw.place ?? raw.location, { max: MAX_SHORT })
  if (!title.en && !title.es) return null
  // No ticketing / price fields — parish_events is display only.
  return { title, date, place }
}

function givingPortalPath(slug) {
  const s = typeof slug === 'string' ? slug.trim() : ''
  if (!s || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(s)) return '/give'
  return `/p/${s}/give`
}

function normalizeGivingBlock(block, { slug } = {}) {
  // Display / deep-link only. Payments stay ON HOLD; no platform markup;
  // chart codes 4110/2320/4450 wait on Ledger before PR-E/G money UI.
  const title = normalizeBilingual(block.title, {
    max: MAX_SHORT,
    fallbackEn: 'Give to the parish',
  })
  const description = normalizeBilingual(block.description, {
    max: 1000,
    fallbackEn: 'Support the parish online. OpenChurch collects $0 platform markup.',
  })
  const ctaText = normalizeBilingual(block.ctaText ?? block.cta_text, {
    max: 80,
    fallbackEn: 'Give online',
  })
  return {
    type: 'donation_dues_portal',
    title,
    description,
    ctaText,
    portalUrl: givingPortalPath(slug),
    money: Object.freeze({
      wired: false,
      platform_markup: 0,
      payments: 'on_hold',
      chart_codes_pending_ledger: ['4110', '2320', '4450'],
    }),
  }
}

function normalizeBlock(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'block must be an object' }
  }
  const type = typeof raw.type === 'string' ? raw.type.trim() : ''
  if (!type) return { ok: false, error: 'block.type is required' }
  if (OC_V1_BLOCK_REJECTED.includes(type)) {
    return { ok: false, error: `block type '${type}' is not in the OpenChurch v1 allowlist` }
  }
  if (!isAllowedBlockType(type)) {
    return { ok: false, error: `block type '${type}' is not allowed` }
  }

  switch (type) {
    case 'hero_split': {
      return {
        ok: true,
        block: {
          type,
          eyebrow: normalizeBilingual(raw.eyebrow, { max: 80 }),
          headline: normalizeBilingual(raw.headline ?? raw.title, { max: MAX_SHORT }),
          subheadline: normalizeBilingual(raw.subheadline ?? raw.subtitle, { max: 500 }),
          ctaText: normalizeBilingual(raw.ctaText ?? raw.cta_text, { max: 80, fallbackEn: 'Get connected' }),
          ctaLink: safeHttpsOrPath(raw.ctaLink ?? raw.cta_link ?? '#connect', { allowRelative: true }) || '#connect',
          secondaryCtaText: raw.secondaryCtaText || raw.secondary_cta_text
            ? normalizeBilingual(raw.secondaryCtaText ?? raw.secondary_cta_text, { max: 80 })
            : null,
          secondaryCtaLink: safeHttpsOrPath(raw.secondaryCtaLink ?? raw.secondary_cta_link, { allowRelative: true }),
          badges: Array.isArray(raw.badges)
            ? raw.badges.slice(0, 8).map((b) => normalizeBilingual(b, { max: 40 })).filter((b) => b.en || b.es)
            : [],
        },
      }
    }
    case 'mass_confession_times': {
      return {
        ok: true,
        block: {
          type,
          title: normalizeBilingual(raw.title, { max: MAX_SHORT, fallbackEn: 'Mass & Confession' }),
          mass_times: normalizeBilingual(raw.mass_times ?? raw.massTimes ?? raw.service_times, { max: 2000 }),
          confession_times: normalizeBilingual(raw.confession_times ?? raw.confessionTimes, { max: 2000 }),
          // Connector stub — PR-G may project calendar; free text is display override.
          source: 'site_doc',
        },
      }
    }
    case 'public_documents_vault': {
      const documents = Array.isArray(raw.documents)
        ? raw.documents.slice(0, 40).map(normalizeDocumentItem).filter(Boolean)
        : []
      return {
        ok: true,
        block: {
          type,
          title: normalizeBilingual(raw.title, { max: MAX_SHORT, fallbackEn: 'Bulletins & documents' }),
          documents,
          // Static placeholder until PR-G: documents[] is draft config only.
          // PR-G must project the live bulletin/docs spine — not a third writer.
          connector: 'documents',
        },
      }
    }
    case 'parish_events': {
      const events = Array.isArray(raw.events)
        ? raw.events.slice(0, 40).map(normalizeEventItem).filter(Boolean)
        : []
      const limit = Number.isFinite(Number(raw.limit))
        ? Math.min(40, Math.max(1, Math.floor(Number(raw.limit))))
        : 10
      return {
        ok: true,
        block: {
          type,
          title: normalizeBilingual(raw.title, { max: MAX_SHORT, fallbackEn: 'Upcoming events' }),
          events,
          limit,
          // Static placeholder until PR-G: events[] is draft config only.
          // PR-G projects live parish events; not event_ticketing_calendar.
          ticketing: false,
          connector: 'events',
        },
      }
    }
    case 'donation_dues_portal':
      return { ok: true, block: normalizeGivingBlock(raw, ctx) }
    case 'location_hours_map': {
      return {
        ok: true,
        block: {
          type,
          title: normalizeBilingual(raw.title, { max: MAX_SHORT, fallbackEn: 'Location & hours' }),
          address: normalizeBilingual(raw.address, { max: 500 }),
          hoursSummary: normalizeBilingual(raw.hoursSummary ?? raw.hours_summary, { max: 500 }),
          mapUrl: safeHttpsOrPath(raw.mapUrl ?? raw.map_url, { allowRelative: false }),
        },
      }
    }
    case 'team_roster_grid': {
      const members = Array.isArray(raw.members)
        ? raw.members.slice(0, 40).map(normalizeTeamMember).filter(Boolean)
        : []
      return {
        ok: true,
        block: {
          type,
          title: normalizeBilingual(raw.title, { max: MAX_SHORT, fallbackEn: 'Clergy & staff' }),
          members,
        },
      }
    }
    case 'faq_accordion': {
      const faqs = Array.isArray(raw.faqs)
        ? raw.faqs.slice(0, 40).map(normalizeFaqItem).filter(Boolean)
        : []
      return {
        ok: true,
        block: {
          type,
          title: normalizeBilingual(raw.title, { max: MAX_SHORT, fallbackEn: 'Frequently asked questions' }),
          faqs,
        },
      }
    }
    default:
      return { ok: false, error: `block type '${type}' is not allowed` }
  }
}

function normalizePage(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'page must be an object' }
  }
  const id = trimStr(raw.id || 'home', 64) || 'home'
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    return { ok: false, error: `page id '${id}' is invalid` }
  }
  const slug = trimStr(raw.slug ?? (id === 'home' ? '' : id), 64)
  const title = normalizeBilingual(raw.title, { max: MAX_SHORT, fallbackEn: id === 'home' ? 'Home' : id })
  const blocksIn = Array.isArray(raw.blocks) ? raw.blocks : []
  if (blocksIn.length > MAX_BLOCKS_PER_PAGE) {
    return { ok: false, error: `page '${id}' has too many blocks (max ${MAX_BLOCKS_PER_PAGE})` }
  }
  const blocks = []
  for (let i = 0; i < blocksIn.length; i++) {
    const result = normalizeBlock(blocksIn[i], ctx)
    if (!result.ok) {
      return { ok: false, error: `page '${id}' block[${i}]: ${result.error}` }
    }
    blocks.push(result.block)
  }
  return { ok: true, page: { id, slug, title, blocks } }
}

/**
 * Validate + normalize a site document for draft storage.
 * @returns {{ ok: true, doc } | { ok: false, error: string }}
 */
export function normalizeSiteDocument(input, { slug } = {}) {
  if (input == null) {
    return { ok: true, doc: emptySiteDocument() }
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'site document must be an object' }
  }
  const encoded = JSON.stringify(input)
  if (encoded.length > MAX_DOC_BYTES) {
    return { ok: false, error: `site document exceeds ${MAX_DOC_BYTES} bytes` }
  }
  const pagesIn = Array.isArray(input.pages) ? input.pages : []
  if (pagesIn.length > MAX_PAGES) {
    return { ok: false, error: `too many pages (max ${MAX_PAGES})` }
  }
  const pages = []
  const seen = new Set()
  for (let i = 0; i < pagesIn.length; i++) {
    const result = normalizePage(pagesIn[i], { slug })
    if (!result.ok) return result
    if (seen.has(result.page.id)) {
      return { ok: false, error: `duplicate page id '${result.page.id}'` }
    }
    seen.add(result.page.id)
    pages.push(result.page)
  }
  // Nav is a stub for PR-D — accept empty array only in C.
  const nav = Array.isArray(input.nav) ? input.nav.slice(0, 0) : []
  return {
    ok: true,
    doc: {
      version: SITE_DOC_VERSION,
      pages,
      nav,
    },
  }
}

export function emptySiteDocument() {
  return { version: SITE_DOC_VERSION, pages: [], nav: [] }
}

export function normalizeLookId(lookId) {
  if (!lookId) return DEFAULT_LOOK_ID
  const key = String(lookId).trim().toLowerCase()
  if (isAllowedLookId(key)) return key
  // Aliases from Dale resolveOfficialLook, still within admin set.
  if (key === 'dark') return 'midnight'
  if (key === 'light' || key === 'clinical') return 'clinical-light'
  if (key === 'earthy' || key === 'earthy-light' || key === 'classic') return 'warm-editorial'
  return DEFAULT_LOOK_ID
}

/**
 * Look frozen into a published / history snapshot.
 * normalizeSiteDocument strips look_id, so callers must read it from the
 * raw JSON before normalizing.
 */
export function lookIdFromPublishedDoc(publishedDoc) {
  if (!publishedDoc || typeof publishedDoc !== 'object' || Array.isArray(publishedDoc)) {
    return null
  }
  if (!Object.prototype.hasOwnProperty.call(publishedDoc, 'look_id')) return null
  return normalizeLookId(publishedDoc.look_id)
}

/**
 * Embed the current draft look into a pages/nav snapshot for publish/history.
 */
export function snapshotWithLook(normalizedDoc, lookId) {
  return {
    ...normalizedDoc,
    look_id: normalizeLookId(lookId),
  }
}

/**
 * Public projection: only published_doc contents, already normalized.
 * Returns null when there is nothing to show (legacy 4-box path).
 *
 * Atlas P1 / Argus N465-3: look comes from the frozen published_doc when
 * present. Live row.look_id is draft-only and must not reach visitors.
 */
export function projectPublishedSite({ publishedDoc, lookId: _draftLookId, publishedAt, slug } = {}) {
  if (!publishedDoc || typeof publishedDoc !== 'object') return null
  // Read look before normalize — normalizeSiteDocument drops look_id.
  // Atlas P1: when published_doc is set, ignore the draft look column /
  // lookId argument. Missing embedded look falls back to the default.
  const frozen = lookIdFromPublishedDoc(publishedDoc)
  const look = frozen != null ? frozen : normalizeLookId(undefined)
  const normalized = normalizeSiteDocument(publishedDoc, { slug })
  if (!normalized.ok) return null
  if (!normalized.doc.pages.length) return null
  const hasBlocks = normalized.doc.pages.some((p) => p.blocks.length > 0)
  if (!hasBlocks) return null
  const theme = deriveWebsiteTheme({
    look_id: look,
    // Accent comes from org branding at render time; look supplies the rest.
  })
  return {
    look_id: look,
    look_label: theme.lookLabel,
    published_at: publishedAt ? new Date(publishedAt).toISOString() : null,
    visitor_controls: Object.freeze({
      // Dale Q3: parish admin picks the look; visitors get high-contrast only.
      look_switcher: false,
      high_contrast_toggle: true,
    }),
    doc: normalized.doc,
  }
}

export function libraryCatalog() {
  const dale = listSectionBlocks()
  return {
    upstream: UPSTREAM,
    oc_v1: OC_V1_BLOCK_TYPES.map((id) => {
      const daleEntry = dale.find((b) => b.id === id)
      return {
        id,
        label: daleEntry?.label || id,
        dale: Boolean(daleEntry),
        oc_native: !daleEntry,
      }
    }),
    rejected_v1: OC_V1_BLOCK_REJECTED,
    looks: listOfficialLooks().filter((l) => isAllowedLookId(l.id)),
  }
}

export function resolveLook(lookId) {
  return resolveOfficialLook(normalizeLookId(lookId))
}

export { isBilingualObject, listSectionBlocks, deriveWebsiteTheme }
