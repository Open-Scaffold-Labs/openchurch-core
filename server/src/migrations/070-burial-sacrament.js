// 'burial' joins the sacramental register (migration 070).
//
// Not one of the seven sacraments — a RITE — but the register is the
// parish's book of record and every liturgical polity records burials in
// it: the Episcopal Parochial Report and Lutheran congregational reports
// ask for burial counts by year, and a register that can't answer "where
// do the funerals go?" fails the first sharp parish secretary who asks.
//
// The 045 CHECK was written as a constraint precisely so this would be a
// constraint replace, not a type migration. Two consumers deliberately do
// NOT gain burial: the anniversaries endpoint and the pastoral digest —
// an automated "N years since X's Burial" note drafted for an active-
// member join is at best wrong and at worst cruel. Memorial anniversaries
// are Mass-intention territory, initiated by a human.

import pool from '../db.js'

export async function up() {
  console.log('Migration 070: burial-sacrament — applying...')

  await pool.query(`
    ALTER TABLE ochr_sacramental_records
      DROP CONSTRAINT IF EXISTS ochr_sacramental_records_type_check
  `)
  await pool.query(`
    ALTER TABLE ochr_sacramental_records
      ADD CONSTRAINT ochr_sacramental_records_type_check
      CHECK (type IN ('baptism', 'reconciliation', 'first_communion',
                      'confirmation', 'marriage', 'holy_orders',
                      'anointing', 'burial'))
  `)

  console.log('Migration 070: burial-sacrament — applied.')
}
