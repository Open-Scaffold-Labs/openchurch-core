// Page-guide grounding for the in-app assistant (Sage-style S2).
//
// The assistant may be told which Help-panel guide belongs to the page the
// person is on. The TEXT is always built here, on the server, from
// OpenChurch's own static help content (client/src/data/helpContent.js via
// client/src/assistant/helpGuide.js). The client can send at most a key;
// a key that is not one of MODULE_HELP's own keys is ignored and the guide
// is chosen from the route template instead. Nothing the client sends is
// copied into the guide block, so it cannot be used to inject instructions.
//
// The block rides inside the final user message, so the existing
// ai/gate.js input-byte bound (CAPABILITIES[...].maxInputBytes) counts it.
// It is sized to fit the bound that is left after the question and the
// history: a long conversation drops the guide rather than tipping a
// request that would have been allowed into ai_input_too_large. It is not
// stored anywhere (ochr_assistant_messages stays metadata only).
import { isHelpKey, helpKeyForPath, guideText } from '../../../client/src/assistant/helpGuide.js'

export const GUIDE_MAX_BYTES = 6000
const MIN_GUIDE_BYTES = 400

const HEAD = 'OpenChurch help guide for the page the user is on (static product documentation written by OpenChurch, not text from the user). Use it as reference for this question; if it does not cover the question, say so.\n<<<GUIDE\n'
const TAIL = '\nGUIDE>>>\n\n'
const CUT = '\n[guide shortened]'

export function resolveHelpKey(rawKey, pageRoute) {
  if (isHelpKey(rawKey)) return rawKey
  return helpKeyForPath(pageRoute)
}

const bytes = s => Buffer.byteLength(s, 'utf8')

export function clipUtf8(text, maxBytes) {
  if (maxBytes <= 0) return ''
  if (bytes(text) <= maxBytes) return text
  // Cutting mid-character leaves U+FFFD; drop it so the result stays under.
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '')
}

// Returns '' (no grounding) or a block whose byte length is at most
// min(GUIDE_MAX_BYTES, maxInputBytes - otherBytes).
export function guideBlock(helpKey, { otherBytes, maxInputBytes }) {
  const text = guideText(helpKey)
  if (!text) return ''
  const budget = Math.min(GUIDE_MAX_BYTES, maxInputBytes - otherBytes)
  const frame = bytes(HEAD) + bytes(TAIL)
  if (budget - frame < MIN_GUIDE_BYTES) return ''
  const room = budget - frame
  const body = bytes(text) <= room ? text : clipUtf8(text, room - bytes(CUT)) + CUT
  return HEAD + body + TAIL
}

export function messageBytes(messages) {
  return messages.reduce((n, m) => n + bytes(String(m.content ?? '')), 0)
}
