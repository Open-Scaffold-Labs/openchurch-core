// Liturgical season & color display names (P3 + P4). The SERVER speaks
// canonical English ('Ordinary Time', 'Green') — those are data values
// and never change. These helpers translate them at the moment of
// display, so a Spanish parish reads «Tiempo Ordinario · Verde» while
// the database, the API, and the color-mapping utilities stay stable.
// Unknown values (parish-defined feasts, future seasons) pass through.

import { TRADITION_SEASONS } from './traditions'

const SEASON_KEYS = {
  'Advent': 'lit.advent', 'Christmas': 'lit.christmas', 'Lent': 'lit.lent',
  'Holy Week': 'lit.holyweek', 'Easter': 'lit.easter', 'Pentecost': 'lit.pentecost',
  'Ordinary Time': 'lit.ordinary',
}
const COLOR_KEYS = {
  Purple: 'lit.purple', White: 'lit.white', Green: 'lit.green',
  Red: 'lit.red', Gold: 'lit.gold',
}

// seasonLabel(t, season, { tradition, block })
//
// The server sends a canonical season token plus, for counted time, which
// block of it a date falls in. Roman and Lutheran practice call both
// blocks "Ordinary Time"; Episcopal and Anglican practice call them
// "Season after the Epiphany" and "Season after Pentecost". Same season,
// same green, different word — which is exactly why the token stays in the
// database and the word is resolved here at display time.
//
// Callers that pass no options keep the pre-TRAD.1 behaviour.
export function seasonLabel(t, season, { tradition, block } = {}) {
  if (season === 'Ordinary Time' && block) {
    const key = TRADITION_SEASONS[tradition]?.[block]
    if (key) return t(key)
  }
  return SEASON_KEYS[season] ? t(SEASON_KEYS[season]) : season
}
export function colorLabel(t, color) {
  return COLOR_KEYS[color] ? t(COLOR_KEYS[color]) : color
}
