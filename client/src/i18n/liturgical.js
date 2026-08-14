// Liturgical season & color display names (P3 + P4). The SERVER speaks
// canonical English ('Ordinary Time', 'Green') — those are data values
// and never change. These helpers translate them at the moment of
// display, so a Spanish parish reads «Tiempo Ordinario · Verde» while
// the database, the API, and the color-mapping utilities stay stable.
// Unknown values (parish-defined feasts, future seasons) pass through.

const SEASON_KEYS = {
  'Advent': 'lit.advent', 'Christmas': 'lit.christmas', 'Lent': 'lit.lent',
  'Holy Week': 'lit.holyweek', 'Easter': 'lit.easter', 'Pentecost': 'lit.pentecost',
  'Ordinary Time': 'lit.ordinary',
}
const COLOR_KEYS = {
  Purple: 'lit.purple', White: 'lit.white', Green: 'lit.green',
  Red: 'lit.red', Gold: 'lit.gold',
}

export function seasonLabel(t, season) {
  return SEASON_KEYS[season] ? t(SEASON_KEYS[season]) : season
}
export function colorLabel(t, color) {
  return COLOR_KEYS[color] ? t(COLOR_KEYS[color]) : color
}
