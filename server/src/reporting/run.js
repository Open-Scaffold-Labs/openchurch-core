// The report runner (RPT.1).
//
// Deliberately small. A definition is a list of fields, each with one
// query; running a report is running them and attaching provenance. If this
// file ever grows a query builder, a caching layer or a scheduler, the
// design has drifted — the value is in the definitions and the honesty of
// the provenance, not in the machinery.
//
// Every field comes back with its number AND with where the number came
// from AND with whether we have verified the report asks for it. A figure
// somebody is going to sign should never arrive without those.

import pool from '../db.js'
import { computeEaster } from '../routes/liturgical.js'
import { DISTINCT_PEOPLE } from './definitions.js'
import { guardFormula } from '../utils/csv.js'

// Easter is a movable feast, so its query cannot live as a static string in
// the definition. It is the one field that needs the liturgical calendar.
async function easterAttendance(orgId, start, end) {
  const years = new Set([Number(start.slice(0, 4)), Number(end.slice(0, 4))])
  const dates = [...years]
    .map(y => computeEaster(y).toISOString().slice(0, 10))
    .filter(d => d >= start && d <= end)
  if (!dates.length) return 0
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(n), 0)::int AS value
       FROM (
         SELECT ck.calendar_event_id AS id, ${DISTINCT_PEOPLE} AS n
           FROM ochr_checkins ck
          WHERE ck.organization_id = $1
            AND ck.attended_date IS NOT NULL
            AND ck.attended_date = ANY($2::date[])
          GROUP BY ck.calendar_event_id
       ) per_service`,
    [orgId, dates]
  )
  return rows[0]?.value ?? 0
}

const SPECIAL = { easter_attendance: easterAttendance }

export async function runReport(report, { orgId, start, end }) {
  const fields = []
  for (const f of report.fields) {
    // 'unsupported' emits NO number. A zero and a blank are different
    // claims, and only one of them is true here.
    if (f.requirement === 'unsupported') {
      fields.push({
        key: f.key, label: f.label, requirement: f.requirement,
        value: null, source: f.source, note: f.note ?? null,
      })
      continue
    }

    let value = null
    let error = null
    try {
      if (SPECIAL[f.key]) {
        value = await SPECIAL[f.key](orgId, start, end)
      } else if (f.sql) {
        const { rows } = await pool.query(f.sql, [orgId, start, end])
        value = rows[0]?.value ?? 0
      }
    } catch (err) {
      // One failing line must not take the sheet down — a parish with nine
      // good numbers and one error is far better served by nine numbers and
      // a named failure than by a 500.
      error = 'Could not compute this figure'
      value = null
    }

    fields.push({
      key: f.key, label: f.label, requirement: f.requirement,
      value, source: f.source, note: f.note ?? null, ...(error ? { error } : {}),
    })
  }

  return {
    key: report.key,
    title: report.title,
    subtitle: report.subtitle,
    period: { start, end },
    fields,
    // Said on every response, not buried in documentation. This is a
    // dataset for a human to check against a form, and the moment it starts
    // describing itself as a filing we have made a claim we cannot support.
    disclaimer:
      'These are the figures OpenChurch holds for this period, with the source of each. ' +
      'Lines marked "unverified" are ones we believe the report asks for but have not confirmed against the form itself. ' +
      'Nothing here is filed, and nothing here replaces reading the form.',
  }
}

export function toCSV(result) {
  const esc = v => {
    // ARG-LEAK-7: neutralise formula-leading text; plain numbers stay numbers.
    const s = guardFormula(v, { allowNumbers: true })
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const lines = [
    ['field', 'value', 'requirement', 'source', 'note'].join(','),
    ...result.fields.map(f => [
      f.label,
      f.value == null ? '' : f.value,
      f.requirement,
      f.source,
      f.note ?? '',
    ].map(esc).join(',')),
  ]
  // The disclaimer rides on the export too. A CSV emailed to a treasurer
  // outlives the screen it was generated on.
  lines.push('')
  lines.push(esc(result.disclaimer))
  return lines.join('\n')
}
