// 063 — Bring-your-own AI provider (AIP.1).
//
// Each org may plug in its OWN AI credentials — their provider, their
// key, their bill. Answers the open product question from the AI-quota
// work ("whose credits burn?") with: the platform's by default, the
// parish's when they choose. The key is encrypted at rest (AES-256-GCM,
// key derived from AI_KEY_SECRET or JWT_SECRET — see src/ai/orgProvider.js)
// and never returned by any API after write; only its last four
// characters are shown back.

import pool from '../db.js'

export async function up() {
  console.log('Migration 063: org-ai-provider — applying...')

  await pool.query(`ALTER TABLE ochr_organizations ADD COLUMN IF NOT EXISTS ai_provider TEXT`)
  await pool.query(`ALTER TABLE ochr_organizations ADD COLUMN IF NOT EXISTS ai_api_key_enc TEXT`)
  await pool.query(`ALTER TABLE ochr_organizations ADD COLUMN IF NOT EXISTS ai_model TEXT`)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_organizations_ai_provider_check'
      ) THEN
        ALTER TABLE ochr_organizations
          ADD CONSTRAINT ochr_organizations_ai_provider_check
          CHECK (ai_provider IS NULL OR ai_provider IN ('anthropic', 'openai'));
      END IF;
    END $$
  `)

  console.log('Migration 063: org-ai-provider — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up().then(() => process.exit(0)).catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
