// Server AI refusals carry a machine-readable code (server/src/ai/gate.js);
// the copy is ours, in the user's language, never the server's sentence.
const CODES = new Set(['ai_disabled', 'ai_forbidden', 'ai_unsupported_provider', 'ai_input_too_large', 'ai_unavailable', 'org_type_forbidden', 'ai_failed'])

export function aiRefusalMessage(t, data, fallbackKey) {
  const code = data?.code
  return CODES.has(code) ? t(`ai.refusal.${code}`) : t(fallbackKey)
}
