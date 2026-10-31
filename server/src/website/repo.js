import pool from '../db.js'
import {
  emptySiteDocument,
  normalizeSiteDocument,
  normalizeLookId,
  lookIdFromPublishedDoc,
  snapshotWithLook,
  projectPublishedSite,
} from './siteDocument.js'

const SITE_COLUMNS = `id, organization_id, draft_doc, published_doc, published_at,
            published_by_user_id, look_id, revision, custom_domain,
            created_at, updated_at`

export const SITE_REVISION_CONFLICT_MESSAGE =
  'Someone else edited this page. Your change was not saved. Reload the page to see their version, then try again.'

export function siteRevisionConflict() {
  const err = new Error(SITE_REVISION_CONFLICT_MESSAGE)
  err.status = 409
  err.code = 'site_revision_conflict'
  return err
}

function httpError(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

// Whole numbers only. Booleans, arrays, and numeric strings are refused
// so a client cannot coerce `true` into revision 1.
export function parseExpectedRevision(body) {
  const message = 'Reload the page before saving. Nothing was changed.'
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Object.prototype.hasOwnProperty.call(body, 'expected_revision')) {
    throw httpError(400, 'site_revision_required', message)
  }
  const raw = body.expected_revision
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw httpError(400, 'site_revision_required', message)
  }
  return raw
}

export function requireSiteConfirm(body) {
  if (!body || body.confirm !== true) {
    throw httpError(
      400,
      'site_confirm_required',
      'Confirm this before it changes what visitors see. Nothing was changed.',
    )
  }
}

function assertRevision(row, expectedRevision) {
  if (!row || Number(row.revision) !== expectedRevision) throw siteRevisionConflict()
}

async function withOrgTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function getSiteRow(organizationId, client = pool) {
  const { rows } = await client.query(
    `SELECT ${SITE_COLUMNS}
       FROM ochr_site_documents
      WHERE organization_id = $1
      LIMIT 1`,
    [organizationId],
  )
  return rows[0] ?? null
}

async function lockSiteRow(client, organizationId) {
  const { rows } = await client.query(
    `SELECT ${SITE_COLUMNS}
       FROM ochr_site_documents
      WHERE organization_id = $1
      FOR UPDATE`,
    [organizationId],
  )
  return rows[0] ?? null
}

async function lockOrCreate(client, organizationId) {
  let row = await lockSiteRow(client, organizationId)
  if (row) return row
  await client.query(
    `INSERT INTO ochr_site_documents (organization_id, draft_doc, look_id)
     VALUES ($1, $2::jsonb, 'warm-editorial')
     ON CONFLICT (organization_id) DO NOTHING`,
    [organizationId, JSON.stringify(emptySiteDocument())],
  )
  row = await lockSiteRow(client, organizationId)
  if (!row) {
    throw httpError(500, 'site_row_missing', 'The parish page could not be opened for saving.')
  }
  return row
}

async function latestHistory(client, organizationId) {
  const { rows } = await client.query(
    `SELECT id, seq, action, doc, previous_history_id, created_at
       FROM ochr_site_publish_history
      WHERE organization_id = $1
      ORDER BY seq DESC
      LIMIT 1`,
    [organizationId],
  )
  return rows[0] ?? null
}

async function historyById(client, organizationId, id) {
  if (id == null) return null
  const { rows } = await client.query(
    `SELECT id, action, doc, previous_history_id
       FROM ochr_site_publish_history
      WHERE organization_id = $1
        AND id = $2`,
    [organizationId, id],
  )
  return rows[0] ?? null
}

async function nextSeq(client, organizationId) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
       FROM ochr_site_publish_history
      WHERE organization_id = $1`,
    [organizationId],
  )
  return Number(rows[0].seq)
}

async function insertHistory(client, {
  organizationId, siteDocumentId, action, doc, previousHistoryId, actorUserId,
}) {
  const seq = await nextSeq(client, organizationId)
  const { rows } = await client.query(
    `INSERT INTO ochr_site_publish_history
       (organization_id, site_document_id, seq, action, doc,
        previous_history_id, actor_user_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING id, seq, action, previous_history_id, created_at`,
    [
      organizationId,
      siteDocumentId,
      seq,
      action,
      JSON.stringify(doc),
      previousHistoryId ?? null,
      actorUserId ?? null,
    ],
  )
  return rows[0]
}

export async function listPublishHistory(organizationId, client = pool) {
  const { rows } = await client.query(
    `SELECT seq, action, previous_history_id, created_at
       FROM ochr_site_publish_history
      WHERE organization_id = $1
      ORDER BY seq DESC
      LIMIT 20`,
    [organizationId],
  )
  return rows
}

function sameDocument(left, right, slug) {
  if (!left || !right) return false
  const a = normalizeSiteDocument(left, { slug })
  const b = normalizeSiteDocument(right, { slug })
  if (!a.ok || !b.ok) return false
  return JSON.stringify(a.doc) === JSON.stringify(b.doc)
}

async function previousIdForNewPublish(client, row, slug) {
  if (!row.published_doc) return null
  const latest = await latestHistory(client, row.organization_id)
  if (latest && latest.action !== 'unpublish') return latest.id
  if (latest && latest.action === 'unpublish') return latest.previous_history_id
  const preserved = normalizeSiteDocument(row.published_doc, { slug })
  if (!preserved.ok) return null
  const frozenLook = lookIdFromPublishedDoc(row.published_doc) ?? normalizeLookId(row.look_id)
  const inserted = await insertHistory(client, {
    organizationId: row.organization_id,
    siteDocumentId: row.id,
    action: 'publish',
    doc: snapshotWithLook(preserved.doc, frozenLook),
    previousHistoryId: null,
    actorUserId: row.published_by_user_id,
  })
  return inserted.id
}

function emptyDraftError(hasPublished) {
  return httpError(
    400,
    'site_draft_empty',
    hasPublished
      ? 'Add something to the draft before you publish. Visitors still see the page that is already public.'
      : 'Add something to the draft before you publish. Nothing was put on the public page.',
  )
}

export async function saveDraft({ organizationId, draftDoc, lookId, slug, expectedRevision }) {
  const normalized = normalizeSiteDocument(draftDoc, { slug })
  if (!normalized.ok) {
    throw httpError(400, 'site_doc_invalid', normalized.error)
  }
  return withOrgTransaction(async (client) => {
    const row = await lockOrCreate(client, organizationId)
    assertRevision(row, expectedRevision)
    const look = lookId == null || String(lookId).trim() === ''
      ? normalizeLookId(row.look_id)
      : normalizeLookId(lookId)
    const { rows } = await client.query(
      `UPDATE ochr_site_documents
          SET draft_doc = $1::jsonb,
              look_id = $2,
              revision = revision + 1,
              updated_at = NOW()
        WHERE organization_id = $3
          AND revision = $4
        RETURNING ${SITE_COLUMNS}`,
      [JSON.stringify(normalized.doc), look, organizationId, expectedRevision],
    )
    if (!rows[0]) throw siteRevisionConflict()
    return rows[0]
  })
}

export async function updateLookOnly({ organizationId, lookId, expectedRevision }) {
  const look = normalizeLookId(lookId)
  return withOrgTransaction(async (client) => {
    const row = await lockOrCreate(client, organizationId)
    assertRevision(row, expectedRevision)
    const { rows } = await client.query(
      `UPDATE ochr_site_documents
          SET look_id = $1,
              revision = revision + 1,
              updated_at = NOW()
        WHERE organization_id = $2
          AND revision = $3
        RETURNING ${SITE_COLUMNS}`,
      [look, organizationId, expectedRevision],
    )
    if (!rows[0]) throw siteRevisionConflict()
    return rows[0]
  })
}

export async function publishDraft({ organizationId, actorUserId, expectedRevision, slug }) {
  return withOrgTransaction(async (client) => {
    const row = await lockSiteRow(client, organizationId)
    if (!row) {
      if (expectedRevision !== 0) throw siteRevisionConflict()
      throw emptyDraftError(false)
    }
    assertRevision(row, expectedRevision)
    const normalized = normalizeSiteDocument(row.draft_doc, { slug })
    if (!normalized.ok) throw httpError(400, 'site_doc_invalid', normalized.error)
    const snapshot = snapshotWithLook(normalized.doc, row.look_id)
    const projected = projectPublishedSite({
      publishedDoc: snapshot,
      slug,
    })
    if (!projected) throw emptyDraftError(Boolean(row.published_doc))
    const previousId = await previousIdForNewPublish(client, row, slug)
    await insertHistory(client, {
      organizationId: row.organization_id,
      siteDocumentId: row.id,
      action: 'publish',
      doc: snapshot,
      previousHistoryId: previousId,
      actorUserId,
    })
    const { rows } = await client.query(
      `UPDATE ochr_site_documents
          SET published_doc = $1::jsonb,
              published_at = NOW(),
              published_by_user_id = $2,
              revision = revision + 1,
              updated_at = NOW()
        WHERE organization_id = $3
          AND revision = $4
        RETURNING ${SITE_COLUMNS}`,
      [JSON.stringify(snapshot), actorUserId, row.organization_id, expectedRevision],
    )
    if (!rows[0]) throw siteRevisionConflict()
    return rows[0]
  })
}

export async function unpublishSite({ organizationId, actorUserId, expectedRevision, slug }) {
  return withOrgTransaction(async (client) => {
    const row = await lockSiteRow(client, organizationId)
    if (!row) {
      if (expectedRevision !== 0) throw siteRevisionConflict()
      throw httpError(400, 'site_not_published', 'The composed page is already down. Nothing was changed.')
    }
    assertRevision(row, expectedRevision)
    if (!row.published_doc) {
      throw httpError(400, 'site_not_published', 'The composed page is already down. Nothing was changed.')
    }
    // N465-2: takedown must succeed even if today's allowlist no longer
    // accepts the live snapshot. Public reads already hide invalid docs;
    // refusing here would strand a page that visitors should not see.
    const normalized = normalizeSiteDocument(row.published_doc, { slug })
    const frozenLook = lookIdFromPublishedDoc(row.published_doc) ?? normalizeLookId(row.look_id)
    const snapshot = normalized.ok
      ? snapshotWithLook(normalized.doc, frozenLook)
      : snapshotWithLook(emptySiteDocument(), frozenLook)
    const latest = await latestHistory(client, row.organization_id)
    const previousId = latest && latest.action !== 'unpublish'
      ? latest.id
      : (latest?.previous_history_id ?? null)
    await insertHistory(client, {
      organizationId: row.organization_id,
      siteDocumentId: row.id,
      action: 'unpublish',
      doc: snapshot,
      previousHistoryId: previousId,
      actorUserId,
    })
    const { rows } = await client.query(
      `UPDATE ochr_site_documents
          SET published_doc = NULL,
              published_at = NULL,
              published_by_user_id = NULL,
              revision = revision + 1,
              updated_at = NOW()
        WHERE organization_id = $1
          AND revision = $2
        RETURNING ${SITE_COLUMNS}`,
      [row.organization_id, expectedRevision],
    )
    if (!rows[0]) throw siteRevisionConflict()
    // SP-307: "Take the page down" must also turn off the public address.
    // Leaving page_published=true returned /page 200 with site:null (legacy
    // empty shell). Visitors should get the same 404 as an unpublished page.
    await client.query(
      `UPDATE ochr_organizations
          SET page_published = FALSE
        WHERE id = $1`,
      [row.organization_id],
    )
    return rows[0]
  })
}

export async function revertPublished({ organizationId, actorUserId, expectedRevision, slug }) {
  return withOrgTransaction(async (client) => {
    const row = await lockSiteRow(client, organizationId)
    if (!row) {
      if (expectedRevision !== 0) throw siteRevisionConflict()
      throw httpError(400, 'site_no_previous', 'There is no earlier published page to restore. Nothing was changed.')
    }
    assertRevision(row, expectedRevision)
    const latest = await latestHistory(client, row.organization_id)
    if (!latest) {
      throw httpError(400, 'site_no_previous', 'There is no earlier published page to restore. Nothing was changed.')
    }

    let restoredDoc
    let restoredPrev
    if (!row.published_doc) {
      if (latest.action !== 'unpublish') {
        throw httpError(400, 'site_no_previous', 'There is no earlier published page to restore. Nothing was changed.')
      }
      const normalized = normalizeSiteDocument(latest.doc, { slug })
      if (!normalized.ok) {
        throw httpError(400, 'site_doc_invalid', 'The earlier page could not be read. Nothing was changed.')
      }
      const frozenLook = lookIdFromPublishedDoc(latest.doc) ?? normalizeLookId(row.look_id)
      restoredDoc = snapshotWithLook(normalized.doc, frozenLook)
      const liveNode = await historyById(client, row.organization_id, latest.previous_history_id)
      restoredPrev = liveNode?.previous_history_id ?? null
    } else {
      if (latest.previous_history_id == null) {
        throw httpError(400, 'site_no_previous', 'There is no earlier published page to restore. Nothing was changed.')
      }
      const target = await historyById(client, row.organization_id, latest.previous_history_id)
      if (!target?.doc) {
        throw httpError(400, 'site_no_previous', 'There is no earlier published page to restore. Nothing was changed.')
      }
      const normalized = normalizeSiteDocument(target.doc, { slug })
      if (!normalized.ok) {
        throw httpError(400, 'site_doc_invalid', 'The earlier page could not be read. Nothing was changed.')
      }
      const frozenLook = lookIdFromPublishedDoc(target.doc) ?? normalizeLookId(row.look_id)
      restoredDoc = snapshotWithLook(normalized.doc, frozenLook)
      restoredPrev = target.previous_history_id
    }

    await insertHistory(client, {
      organizationId: row.organization_id,
      siteDocumentId: row.id,
      action: 'revert',
      doc: restoredDoc,
      previousHistoryId: restoredPrev,
      actorUserId,
    })
    const { rows } = await client.query(
      `UPDATE ochr_site_documents
          SET published_doc = $1::jsonb,
              published_at = NOW(),
              published_by_user_id = $2,
              revision = revision + 1,
              updated_at = NOW()
        WHERE organization_id = $3
          AND revision = $4
        RETURNING ${SITE_COLUMNS}`,
      [JSON.stringify(restoredDoc), actorUserId, row.organization_id, expectedRevision],
    )
    if (!rows[0]) throw siteRevisionConflict()
    return rows[0]
  })
}

export async function getPublishedProjectionForOrg({ organizationId, slug }) {
  const row = await getSiteRow(organizationId)
  if (!row) return null
  // look_id is frozen inside published_doc; live row.look_id is draft-only.
  return projectPublishedSite({
    publishedDoc: row.published_doc,
    publishedAt: row.published_at,
    slug,
  })
}

export function adminSitePayload(row, { slug, pagePublished = false, history = [] } = {}) {
  const latest = history[0] ?? null
  const hasPublished = Boolean(row?.published_doc)
  const canRevert = !latest
    ? false
    : hasPublished
      ? latest.previous_history_id != null && latest.action !== 'unpublish'
      : latest.action === 'unpublish'
  const draft = row
    ? (() => {
      const draftNorm = normalizeSiteDocument(row.draft_doc, { slug })
      return draftNorm.ok ? draftNorm.doc : emptySiteDocument()
    })()
    : emptySiteDocument()
  const published = row
    ? projectPublishedSite({
      publishedDoc: row.published_doc,
      publishedAt: row.published_at,
      slug,
    })
    : null
  return {
    draft,
    published,
    look_id: normalizeLookId(row?.look_id),
    revision: row ? Number(row.revision) : 0,
    published_at: row?.published_at ?? null,
    has_published: hasPublished,
    draft_matches_published: Boolean(row) && sameDocument(row.draft_doc, row.published_doc, slug),
    can_revert: canRevert,
    page_published: pagePublished === true,
    history: history
      .filter((h) => h && ['publish', 'unpublish', 'revert'].includes(h.action))
      .map((h) => ({
        seq: Number(h.seq),
        action: h.action,
        created_at: h.created_at,
      })),
    custom_domain: null, // reserved; CHECK forces NULL until PR-K
  }
}
