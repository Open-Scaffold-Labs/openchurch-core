// Append-only chart mappings. A new row starts on effectiveFrom. The row
// it replaces is closed on that date and kept, account code included, so
// a gift dated earlier still resolves to the account that was in effect
// then. A same-day edit closes that row and inserts another one.
//
// One save is checked as a whole, before and after, on the ledger itself:
//   · a line in a submitted or approved period that would change account
//     (gifts, refunds, payroll) → 409 period_submitted;
//   · a line already posted (dated on or before the parish's today) whose
//     known account would change or clear → 409 mapping_restates_posted.
//     Start the change tomorrow instead. Resolving unknown money is allowed.
// Keys match exactly, the same rule the ledger uses. A parish cannot send
// unknown or assessable money to a non-assessable account (2320, 4430,
// 4450, 4910) for a category or a fund: 403 diocese_mapping_required. A
// change that raises the base stays the parish's, as before.

import { civilDateInTimeZone, resolveParishTimeZone } from '../utils/timezone.js'
import {
  HISTORY_ONLY_ACCOUNT_CODES, isAssessableRevenue, mappingShrinksAssessableBase,
  isRestrictedFundAccount,
} from './booksMappings.js'

export class MappingRejected extends Error {
  constructor(status, code, error) {
    super(error)
    this.status = status
    this.code = code
  }
}

function conflict(err) {
  if (err?.code === '55P03') {
    throw new MappingRejected(409, 'mapping_conflict',
      'Another save is updating this mapping. Nothing was saved.')
  }
  if (err?.code === '23505') {
    // The open-row index is exact on source_key, the same rule the ledger
    // uses to resolve a gift. Only a save of this exact key that committed
    // first can collide here; a key that differs only by case is its own row.
    throw new MappingRejected(409, 'mapping_conflict',
      'A mapping for this exact name was saved at the same moment. Reload and try again. Nothing was saved.')
  }
  throw err
}

export async function lockParishBooks(client, orgId) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('oc-books-period:' || $1::text, 0))`,
    [orgId])
}

// Gift, refund, and payroll writes take this key SHARED from a trigger on
// their tables (migration 132, ochr_lock_parish_mappings). A mapping save
// takes it EXCLUSIVE, after lockParishBooks, so no such line can commit
// while a save is between its before/after reads (Carolina R3 race).
export async function lockMappingSave(client, orgId) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('oc-books-mapping:' || $1::text, 0))`,
    [orgId])
}

export async function parishToday(client, orgId) {
  const { rows } = await client.query(
    `SELECT timezone FROM ochr_organizations WHERE id = $1`, [orgId])
  return civilDateInTimeZone(new Date(), resolveParishTimeZone(rows[0]?.timezone))
}

export async function accountInEffect(client, orgId, sourceType, sourceKey, onDate) {
  return (await rowInEffect(client, orgId, sourceType, sourceKey, onDate))?.account_code ?? null
}

async function rowInEffect(client, orgId, sourceType, sourceKey, onDate) {
  const { rows } = await client.query(
    `SELECT m.account_code, m.set_by
       FROM ochr_coa_mappings m
      WHERE m.organization_id = $1
        AND m.source_type = $2
        AND m.source_key = $3
        AND m.effective_from <= $4::date
        AND (m.superseded_on IS NULL OR $4::date < m.superseded_on)
      ORDER BY m.effective_from DESC, m.id DESC
      LIMIT 1`,
    [orgId, sourceType, sourceKey, onDate])
  return rows[0] ?? null
}

async function fundFallback(client, orgId, fundKey, onDate) {
  const { rows } = await client.query(
    `SELECT DISTINCT ochr_mapping_account($1, 'donation_category',
              COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized'), $3::date) AS code
       FROM ochr_donations d
      WHERE d.organization_id = $1 AND d.fund_id::text = $2
      LIMIT 2`,
    [orgId, fundKey, onDate])
  if (rows.length === 1) return rows[0].code ?? null
  return null
}

// Every ledger line a mapping can move, keyed without its account, in the
// two ranges a mapping save must not restate:
//   · a period already submitted to or approved by the diocese, any source
//     (donations, refunds, payroll), from effectiveFrom on;
//   · lines already posted on or before the parish's today, from
//     effectiveFrom on. An unknown (NULL) account may be resolved there; a
//     known account may not be changed or cleared.
// Lines dated after today are not posted yet and follow the new mapping.
async function movableLines(client, orgId, effectiveFrom, today) {
  const { rows } = await client.query(
    `SELECT l.source_type || '|' || l.source_id::text || '|' || l.entry_date::text
              || '|' || l.amount::text || '|' || COALESCE(l.memo, '') AS k,
            l.account_code,
            (l.entry_date <= $3::date) AS posted,
            EXISTS (
              SELECT 1 FROM ochr_report_submissions s
               WHERE s.organization_id = l.organization_id
                 AND s.status IN ('submitted', 'approved')
                 AND l.entry_date BETWEEN s.period_start AND s.period_end
            ) AS frozen
       FROM ochr_parish_ledger l
      WHERE l.organization_id = $1
        AND l.source_type IN ('donation', 'donation_refund', 'payroll')
        AND l.entry_date >= $2::date
        AND (
          l.entry_date <= $3::date
          OR EXISTS (
            SELECT 1 FROM ochr_report_submissions s
             WHERE s.organization_id = l.organization_id
               AND s.status IN ('submitted', 'approved')
               AND l.entry_date BETWEEN s.period_start AND s.period_end
          )
        )`,
    [orgId, effectiveFrom, today])
  const byKey = new Map()
  for (const r of rows) {
    const entry = byKey.get(r.k) ?? { accounts: [], posted: r.posted, frozen: r.frozen }
    entry.accounts.push(r.account_code ?? '')
    byKey.set(r.k, entry)
  }
  for (const entry of byKey.values()) entry.accounts.sort()
  return byKey
}

// Fast per-item check that keeps the earlier answer for gifts: a change
// that would move a gift in a submitted period is period_submitted, even
// when the save would also be refused for another reason.
async function assertSubmittedPeriodUnmoved(client, orgId, type, key, code, effectiveFrom) {
  const { rows } = await client.query(
    `SELECT 1
       FROM ochr_donations d
       JOIN ochr_report_submissions s
         ON s.organization_id = d.organization_id
        AND s.status IN ('submitted', 'approved')
        AND d.date::date BETWEEN s.period_start AND s.period_end
      WHERE d.organization_id = $1
        AND d.date::date >= $4::date
        AND (
          ($2 = 'fund' AND d.fund_id::text = $3)
          OR (
            $2 = 'donation_category'
            AND COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') = $3
            AND (
              d.fund_id IS NULL
              OR ochr_mapping_account(d.organization_id, 'fund', d.fund_id::text, d.date::date) IS NULL
            )
          )
        )
        AND COALESCE((
          SELECT l.account_code FROM ochr_parish_ledger l
           WHERE l.organization_id = d.organization_id
             AND l.source_type = 'donation'
             AND l.source_id = d.id
        ), '') IS DISTINCT FROM COALESCE(
          CASE
            WHEN $2 = 'fund' AND NULLIF($5::text, '') IS NOT NULL THEN NULLIF($5::text, '')
            WHEN $2 = 'fund' THEN ochr_mapping_account(
              d.organization_id, 'donation_category',
              COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized'), d.date::date)
            ELSE NULLIF($5::text, '')
          END, '')
      LIMIT 1`,
    [orgId, type, key, effectiveFrom, code || ''])
  if (rows.length) {
    throw new MappingRejected(409, 'period_submitted',
      'That change would move gifts in a period already sent to the diocese. Nothing was saved.')
  }
}

export function assertNothingRestated(before, after) {
  let restated = false
  for (const [k, prior] of before) {
    const next = after.get(k)?.accounts ?? []
    if (prior.accounts.length === next.length && prior.accounts.every((a, i) => a === next[i])) continue
    if (prior.frozen) {
      throw new MappingRejected(409, 'period_submitted',
        'That change would move entries in a period already sent to the diocese. Nothing was saved.')
    }
    // Resolving unknown money is allowed. Changing or clearing a known
    // account on a line already posted is a restatement.
    const resolvesUnknown = prior.accounts.every(a => a === '')
      && next.length === prior.accounts.length
    if (prior.posted && !resolvesUnknown) restated = true
  }
  if (restated) {
    throw new MappingRejected(409, 'mapping_restates_posted',
      'That change would move entries already posted on or before today. Start it tomorrow or later so posted entries keep their account. Nothing was saved.')
  }
}

async function applyOne(client, orgId, sourceType, sourceKey, code, effectiveFrom, setBy = 'parish') {
  let rows
  try {
    const locked = await client.query(
      `SELECT id, superseded_on, set_by,
              (effective_from > $4::date) AS starts_later
         FROM ochr_coa_mappings
        WHERE organization_id = $1
          AND source_type = $2
          AND source_key = $3
        FOR UPDATE NOWAIT`,
      [orgId, sourceType, sourceKey, effectiveFrom])
    rows = locked.rows
  } catch (err) {
    conflict(err)
  }
  if (rows.some(r => r.starts_later)) {
    throw new MappingRejected(409, 'mapping_overlaps',
      'A later mapping already exists for this source. Nothing was saved.')
  }
  for (const row of rows) {
    if (row.superseded_on != null) continue
    // N438-1 / D2: parish (and any non-diocese writer) cannot supersede an
    // open mapping the chancery set. Chancery may replace its own rows.
    if (setBy !== 'diocese' && row.set_by === 'diocese') {
      throw new MappingRejected(403, 'diocese_mapping_locked',
        'That mapping was set by the diocese. Nothing was saved.')
    }
    await client.query(
      `UPDATE ochr_coa_mappings
          SET superseded_on = $3::date
        WHERE id = $1 AND organization_id = $2 AND superseded_on IS NULL`,
      [row.id, orgId, effectiveFrom])
  }
  if (!code) return
  try {
    await client.query(
      `INSERT INTO ochr_coa_mappings
         (organization_id, source_type, source_key, account_code, effective_from, set_by)
       VALUES ($1, $2, $3, $4, $5::date, $6)`,
      [orgId, sourceType, sourceKey, code, effectiveFrom, setBy])
  } catch (err) {
    conflict(err)
  }
}

export async function applyMappingList(client, orgId, list, requestedFrom, byCode, options = {}) {
  const setBy = options.setBy === 'diocese' ? 'diocese' : 'parish'
  await lockParishBooks(client, orgId)
  await lockMappingSave(client, orgId)
  const today = await parishToday(client, orgId)
  const effectiveFrom = requestedFrom || today
  if (effectiveFrom < today) {
    throw new MappingRejected(400, 'mapping_effective_in_past',
      "A mapping starts today or later on this parish's calendar. Earlier gifts keep the account they had. Nothing was saved.")
  }
  await client.query(
    `SELECT id FROM ochr_report_submissions
      WHERE organization_id = $1
        AND status IN ('submitted', 'approved')
        AND period_end >= $2::date
      FOR UPDATE`,
    [orgId, effectiveFrom])
  const before = await movableLines(client, orgId, effectiveFrom, today)
  for (const item of list) {
    const key = item.source_key.trim()
    const code = String(item.account_code ?? '').trim()
    const type = item.source_type
    if (code && HISTORY_ONLY_ACCOUNT_CODES.has(code)) {
      throw new MappingRejected(400, 'history_only_account',
        `${code} is kept for history. New second-collection mappings use 2320. Nothing was saved.`)
    }
    // BOOKS-1.1: a fund with donor restriction may map only to 4450/2320.
    if (type === 'fund' && code) {
      const { rows: funds } = await client.query(
        `SELECT net_asset_class FROM ochr_funds
          WHERE id = $1::bigint AND organization_id = $2`,
        [key, orgId])
      if (funds.length && funds[0].net_asset_class === 'with_donor_restriction'
          && !isRestrictedFundAccount(code)) {
        throw new MappingRejected(400, 'restricted_fund_account',
          'A fund with donor restrictions maps only to 4450 or 2320. Nothing was saved.')
      }
    }
    await assertSubmittedPeriodUnmoved(client, orgId, type, key, code, effectiveFrom)
    if (type === 'donation_category' || type === 'fund') {
      const previous = await accountInEffect(client, orgId, type, key, effectiveFrom)
      const next = code || (type === 'fund' ? await fundFallback(client, orgId, key, effectiveFrom) : null)
      // Unknown money resolved to a non-assessable account leaves the base
      // the same way a shrink does, so it is the diocese's call for a fund
      // and for a category alike. Chancery writes (set_by='diocese') are
      // the authorized path for that call (BOOKS-1.1 D2).
      const lowers = mappingShrinksAssessableBase(previous, next, byCode)
        || (code && !isAssessableRevenue(code, byCode) && previous == null)
      if (lowers && setBy !== 'diocese') {
        throw new MappingRejected(403, 'diocese_mapping_required',
          'A mapping that lowers the assessable base is the diocese\'s to set. Nothing was saved.')
      }
    }
    await applyOne(client, orgId, type, key, code, effectiveFrom, setBy)
  }
  // Then the whole save, on the ledger itself: refunds and payroll in a
  // submitted period, and known accounts on lines already posted.
  assertNothingRestated(before, await movableLines(client, orgId, effectiveFrom, today))
}
