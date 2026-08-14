// 066 — "Sacramental Fees" → "Offerings — Weddings & Funerals".
//
// The post-handoff sacramental-language audit (2026-08-13) swept every
// label, button, help text, prompt, and seed for money-words attached to
// sacraments. One finding survived in shipped data: migration 057's
// standard chart of accounts seeds revenue account 4220 as "Sacramental
// Fees". Standard parish-accounting nomenclature — and exactly the phrase
// the hard rule exists to keep out of OpenChurch: sacraments are never
// sold, so no default we ship may read as a price on one.
//
// The rename targets rows still carrying the exact shipped name — the
// NULL-org template row plus any org shadow rows created for other edits
// (assessable flag, retirement) whose name was never customized. A parish
// that deliberately renamed 4220 keeps its own words; we don't overwrite
// a bookkeeper's choices.
//
// 4210 ("Sacramental Offerings & Stipends") remains the intention-book
// money; 4220 is where wedding/funeral/ceremony offerings and the coming
// offerings-and-fees workbench route. 4710 keeps plain facility rental.
//
// Approved by José 2026-08-13 (audit action #2).

import pool from '../db.js'

export async function up() {
  console.log('Migration 066: coa-offerings-rename — applying...')

  const { rowCount } = await pool.query(`
    UPDATE ochr_coa_accounts
       SET name = 'Offerings — Weddings & Funerals'
     WHERE code = '4220'
       AND name = 'Sacramental Fees'
  `)
  console.log(`Migration 066: coa-offerings-rename — applied (${rowCount} row(s) renamed).`)
}
