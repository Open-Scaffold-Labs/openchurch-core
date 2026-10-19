// The approved AI policy: which capabilities exist, and which exact endpoint
// and model each one is allowed to reach.
//
// This is the `routes` and `capabilities` half of OSL AI's factory config
// (osl-ai docs/BUILD-CONTRACT.md). It is deliberately plain data with no
// import of @openscaffold/ai: the package is not distributable yet, and the
// policy is reviewable and testable without it. When the pinned version
// exists, this object is passed to createAIClient — nothing here changes.
//
// SERVER POLICY DECIDES, NOT THE REQUEST. The contract is explicit that the
// approved model and endpoint come from here and that request overrides are
// rejected. routes/ai.js today reads `body.model` in one place; that stops.
//
// NO FALLBACK. Today a failed Anthropic call silently retries on OpenAI, on
// the platform's bill. The contract forbids cross-provider fallback and Dale
// confirmed on 2026-09-08 that it goes away. Each capability names exactly
// one route. A failed call fails.
//
// NO DEFAULT MODEL PINS IN CODE. DEFAULT_ANTHROPIC_MODEL and
// DEFAULT_OPENAI_MODEL in routes/ai.js become route entries here, where a
// model change is a reviewed policy change rather than an edit to a handler.

export const POLICY_VERSION = 'openchurch-ai-policy-1'

// Microdollars, matching ochr_ai_ledger (migration 100). Reservations round
// up; the contract requires it, and an under-reservation is a budget that
// does not hold.
const USD = 1_000_000

// ---------------------------------------------------------------- routes ----
//
// A route is an approved destination: exact provider, protocol, endpoint and
// model. `deployment: 'commercial'` means a third party is processing the
// text, which is why no route below accepts `restricted`.
//
// Two credential modes, mirroring what OpenChurch already does. `managed` is
// the platform's own key and bill. `byok` is a parish's own key, stored
// encrypted per organization (migration 063) — their provider, their bill,
// their rate limits, and no silent fall back onto ours.
export const ROUTES = {
  'anthropic-managed': {
    provider: 'anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5-20251001',
    deployment: 'commercial',
    allowedDataClasses: ['public', 'internal'],
    credentialMode: 'managed',
    credentialRef: 'platform-anthropic',
  },

  // A parish that plugged in its own Anthropic key.
  'anthropic-byok': {
    provider: 'anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5-20251001',
    deployment: 'commercial',
    allowedDataClasses: ['public', 'internal'],
    credentialMode: 'byok',
  },

  // ...or its own OpenAI key. Reachable only by an organization that chose
  // it; the platform never routes here on its own account, which is what
  // removing the fallback means in practice.
  'openai-byok': {
    provider: 'openai',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    deployment: 'commercial',
    allowedDataClasses: ['public', 'internal'],
    credentialMode: 'byok',
  },
}

// ---------------------------------------------------------- capabilities ----
//
// Every capability here is CREATIVE DRAFTING. None extracts a fact, none
// cites a source, and none writes anything. That is why each is `output:
// text` with no `validateResult` — and the contract is explicit that no
// validator means no claim of semantic accuracy, which is exactly the claim
// these prompts already refuse to make ("You draft; a person decides").
//
// It also keeps the line ADOPTION.md draws: creative suggestion stays
// separate from factual extraction. Sacramental records, donations and
// diocesan assessments are the factual side. Nothing below can reach them,
// and a capability that could would need its own schema, its own semantic
// validator, and a human commit at the end of it (CONSTITUTION.md).
//
// allowedDataClasses is `internal` throughout: a parish's own draft text.
// Nothing is `restricted`, and no capability sets allowAnonymous — every
// call here belongs to a signed-in actor in a known tenant.

const DRAFTING_DEFAULTS = {
  allowedDataClasses: ['internal'],
  // Stage 7: a parish's own key, when configured, is THE provider for this
  // capability (ai/gate.js). Managed routing only with no override.
  byokProviders: ['anthropic', 'openai'],
  managed: true,
  output: { type: 'text' },
  timeoutMs: 30_000,
}

export const CAPABILITIES = {
  // POST /api/ai/enhance — polish text the user already wrote.
  parish_text_enhance_v1: {
    ...DRAFTING_DEFAULTS,
    routeId: 'anthropic-managed',
    promptVersion: 'enhance-1',
    systemPrompt:
      'You are a helpful assistant for a church management system. Improve the text provided by the user to be clearer and more professional while preserving all original meaning. Return only the improved text, no explanations.',
    maxInputBytes: 8_000,
    maxOutputTokens: 1024,
    reservationUsd: 0.02 * USD,
  },

  // POST /api/ai/generate, type: 'sermon' — the largest ceiling of the five,
  // and the only one that reads liturgical context.
  parish_sermon_draft_v1: {
    ...DRAFTING_DEFAULTS,
    routeId: 'anthropic-managed',
    promptVersion: 'sermon-1',
    systemPrompt:
      'You are a sermon-preparation assistant for a liturgical parish. You DRAFT; the preacher decides. When liturgical context is provided (season, feast, date), root the sermon in it and suggest fitting lectionary readings. Return: a title, the liturgical day, suggested readings, a one-paragraph theme, a 3-5 point outline (each point with scripture and a one-sentence application), one pastoral illustration idea, and a short closing prayer. Mark anything doctrinally weighty as "for the preacher to discern".',
    maxInputBytes: 8_000,
    maxOutputTokens: 1500,
    reservationUsd: 0.05 * USD,
  },

  parish_message_draft_v1: {
    ...DRAFTING_DEFAULTS,
    routeId: 'anthropic-managed',
    promptVersion: 'message-1',
    systemPrompt:
      'You write warm, friendly, and clear church communication messages. Keep tone pastoral and inclusive. Output only the message body — no subject line unless asked. You draft; a person decides — never present doctrine, canon law, or the discipline of any tradition as settled, and leave anything doctrinally weighty for the parish to discern.',
    maxInputBytes: 8_000,
    maxOutputTokens: 1024,
    reservationUsd: 0.02 * USD,
  },

  parish_devotional_draft_v1: {
    ...DRAFTING_DEFAULTS,
    routeId: 'anthropic-managed',
    promptVersion: 'devotional-1',
    systemPrompt:
      'You write short, encouraging Christian devotionals (150–250 words). Include a scripture reference, a reflection, and a one-line prayer. Output only the devotional. You draft; a person decides — cite scripture only where you are confident of the reference, and never present doctrine or the discipline of any tradition as settled.',
    maxInputBytes: 8_000,
    maxOutputTokens: 1024,
    reservationUsd: 0.02 * USD,
  },

  parish_announcement_draft_v1: {
    ...DRAFTING_DEFAULTS,
    routeId: 'anthropic-managed',
    promptVersion: 'announcement-1',
    systemPrompt:
      'You write short, upbeat church announcements suitable for bulletins or social posts. Keep it under 80 words, warm in tone, and end with a clear call to action. You draft; a person decides — never present doctrine, canon law, or the discipline of any tradition as settled.',
    maxInputBytes: 4_000,
    maxOutputTokens: 512,
    reservationUsd: 0.01 * USD,
  },

  // In-app help assistant (routes/assistant.js; its SYSTEM_PROMPT is the one
  // sent). Anthropic-shaped chat only: a parish whose own key is OpenAI gets
  // a visible refusal, not the platform key (TARS, #280 ba12d348).
  parish_assistant_v1: {
    ...DRAFTING_DEFAULTS,
    byokProviders: ['anthropic'],
    routeId: 'anthropic-managed',
    promptVersion: 'assistant-1',
    systemPrompt: 'routes/assistant.js SYSTEM_PROMPT (in-app help; not a canonist)',
    maxInputBytes: 24_000,
    maxOutputTokens: 700,
    reservationUsd: 0.01 * USD,
  },

  // Support-ticket triage (routes/supportTickets.js). Vendor-side, managed
  // only: a parish with its own key configured is not triaged on the
  // platform key with its text; the ticket itself is always kept.
  support_triage_v1: {
    ...DRAFTING_DEFAULTS,
    byokProviders: [],
    routeId: 'anthropic-managed',
    promptVersion: 'support-triage-1',
    systemPrompt: 'routes/supportTickets.js loadSupportContext() (triage)',
    maxInputBytes: 12_000,
    maxOutputTokens: 1000,
    reservationUsd: 0.01 * USD,
  },

  // ---------------------------------------------------------- chancery ----
  //
  // NOT YET APPROVED AS A PRODUCT DECISION. Dale put the chancery in scope on
  // 2026-09-08; what a chancery may ask for is a separate question, and this
  // is the narrowest defensible answer rather than a decided one.
  //
  // It drafts a message FROM a chancery TO its parishes. It is deliberately
  // the same shape as parish_message_draft_v1, because that is a capability
  // whose risk is already understood.
  //
  // WHAT IT MUST NOT BECOME. A diocese's reason to exist in this product is
  // the assessable base — periods, submissions, adjustments, the bill. That
  // data is `restricted`, it is what a parish is invoiced from, and 099 and
  // 100 exist because two locally-correct subsystems once composed into a
  // false figure there. A capability that reads or drafts any of it needs a
  // JSON schema, a semantic validator, a manual fallback, and a human commit
  // — none of which a drafting capability supplies. This one cannot see it:
  // `internal` only, and the chancery route carries no access to those rows.
  chancery_message_draft_v1: {
    ...DRAFTING_DEFAULTS,
    routeId: 'anthropic-managed',
    promptVersion: 'chancery-message-1',
    systemPrompt:
      'You write clear, respectful communication from a diocesan chancery to its parishes. Keep the tone collegial and plain. Output only the message body — no subject line unless asked. You draft; a person decides. Never present canon law, doctrine, or diocesan policy as settled, never state or imply an assessment figure, a balance owed, or a submission status, and leave anything a parish would act on financially for the chancery to state itself.',
    maxInputBytes: 8_000,
    maxOutputTokens: 1024,
    reservationUsd: 0.02 * USD,
  },
}

// ------------------------------------------------------------ validation ----
//
// The contract validates its own config at client construction, but that is
// only reachable once the package is installable. Until then this is what
// stands between a typo and a capability pointing at a route that does not
// exist — cheap enough to run in a test on every push.
export function validatePolicy({ routes = ROUTES, capabilities = CAPABILITIES } = {}) {
  const problems = []

  const PROVIDERS = new Set(['anthropic', 'groq', 'openrouter', 'openai', 'local'])
  const PROTOCOLS = new Set(['anthropic-messages', 'openai-chat-completions'])
  const MODES = new Set(['managed', 'byok', 'none'])
  const CLASSES = new Set(['public', 'internal', 'restricted'])

  for (const [id, r] of Object.entries(routes)) {
    if (!PROVIDERS.has(r.provider)) problems.push(`route ${id}: unknown provider ${r.provider}`)
    if (!PROTOCOLS.has(r.protocol)) problems.push(`route ${id}: unknown protocol ${r.protocol}`)
    if (!MODES.has(r.credentialMode)) problems.push(`route ${id}: unknown credentialMode ${r.credentialMode}`)
    // HTTPS is required except for an explicitly opted-in loopback local route.
    if (!r.baseUrl?.startsWith('https://') && !r.allowInsecureLocal) {
      problems.push(`route ${id}: ${r.baseUrl} is not https and has not opted into insecure local`)
    }
    // Credential-free routes must be local or private, never commercial.
    if (r.credentialMode === 'none' && r.deployment === 'commercial') {
      problems.push(`route ${id}: credential-free commercial route`)
    }
    // A third party must never be an approved destination for restricted data.
    if (r.deployment === 'commercial' && r.allowedDataClasses?.includes('restricted')) {
      problems.push(`route ${id}: commercial deployment accepts restricted data`)
    }
    for (const c of r.allowedDataClasses ?? []) {
      if (!CLASSES.has(c)) problems.push(`route ${id}: unknown data class ${c}`)
    }
  }

  for (const [id, c] of Object.entries(capabilities)) {
    const route = routes[c.routeId]
    if (!route) {
      problems.push(`capability ${id}: routeId ${c.routeId} does not exist`)
      continue
    }
    // A capability cannot permit data its own route refuses.
    for (const cls of c.allowedDataClasses ?? []) {
      if (!route.allowedDataClasses?.includes(cls)) {
        problems.push(`capability ${id}: allows ${cls} but route ${c.routeId} does not`)
      }
    }
    if (!c.promptVersion) problems.push(`capability ${id}: no promptVersion`)
    if (!c.systemPrompt) problems.push(`capability ${id}: no systemPrompt`)
    if (!(c.maxInputBytes > 0)) problems.push(`capability ${id}: maxInputBytes must be positive`)
    if (!(c.maxOutputTokens > 0)) problems.push(`capability ${id}: maxOutputTokens must be positive`)
    if (!(c.timeoutMs > 0)) problems.push(`capability ${id}: timeoutMs must be positive`)
    // Reservations are whole microdollars and cannot be zero: a call with no
    // claim against it is a call no budget can stop.
    if (!Number.isInteger(c.reservationUsd) || c.reservationUsd <= 0) {
      problems.push(`capability ${id}: reservationUsd must be a positive whole number of microdollars`)
    }
    if (c.output?.type === 'json' && !c.output.schema) {
      problems.push(`capability ${id}: json output with no schema`)
    }
    // An anonymous caller cannot spend the platform's money.
    if (c.allowAnonymous && route.credentialMode === 'managed') {
      problems.push(`capability ${id}: anonymous access to a managed-credential route`)
    }
  }

  return problems
}
