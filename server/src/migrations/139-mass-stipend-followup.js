// 139 — Mass stipend follow-up (SP-266 / SP-267 / SP-269 / SP-270).
// SP-268 Release stipend deferred (José 2026-10-28 3:44 PM PT) — remittance
// counter-account still OPEN for José/Dale/Ledger; fulfilled 2330 stays held.
//
// José 2026-10-28 1:37 PM PT (money OK): book a stipend on the day the
// money was received, not the Mass date; admin void/disposition UI path;
// Finance source label. (Release stipend deferred — see header.)
//
// ADDITIVE. received_date + payment_method on ochr_mass_intentions so the
// intention form can carry the cash-in day and method. Facts keep using
// effective_date; create/sync paths pass received_date. Existing facts are
// NOT rewritten (history stays honest). Idempotent column adds + CHECK.
//
// SP-268 remittance counter-account (5110 vs honoraria vs cash) is an OPEN
// product decision — this migration does not invent one. Release stipend is
// deferred; fulfilled 2330 stays held until remittance CoA is decided.

import pool from '../db.js'

export async function up() {
  console.log('Migration 139: mass-stipend-followup — applying...')
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await client.query(`SET LOCAL lock_timeout = '5s'`)

    await client.query(`
      ALTER TABLE ochr_mass_intentions
        ADD COLUMN IF NOT EXISTS received_date DATE,
        ADD COLUMN IF NOT EXISTS payment_method TEXT
    `)

    // CHECK is confined to payment_method, which this migration adds.
    // Values are inlined (not ${…}) so rollback-classify can read the
    // constrained columns without treating a JS identifier as a column.
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_mass_intentions_payment_method_check'
      ) THEN
        ALTER TABLE ochr_mass_intentions
          ADD CONSTRAINT ochr_mass_intentions_payment_method_check
          CHECK (payment_method IS NULL OR payment_method IN ('cash', 'check', 'card', 'other'));
      END IF;
    END $$;`)

    await client.query('COMMIT')
    console.log('Migration 139: mass-stipend-followup — done.')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
