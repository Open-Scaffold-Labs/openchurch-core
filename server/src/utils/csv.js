// Minimal RFC-4180-ish CSV parser. Handles the cases that matter for
// our strict-schema member import:
//   - CR, LF, or CRLF line endings
//   - double-quoted fields containing separators or newlines
//   - "" escape inside a quoted field → single "
//   - a leading BOM, which Excel writes
//   - comma, SEMICOLON, tab or pipe separators
//
// The separator used to be assumed to be a comma, and "users export as
// UTF-8 CSV from Excel" was doing a lot of work in that sentence. Excel
// on a Spanish or most European system writes SEMICOLONS — because in
// those locales the comma is the decimal point — and it does it silently,
// from a menu item that still says CSV. A semicolon file parsed as one
// single column called "Nombre;Correo", imported "successfully", and
// eventually failed several screens later complaining about an unmapped
// field. The person who exported it did nothing wrong.
//
// Returns rows as an array of string arrays. `parseCSVToObjects` on top
// keys each row by its header row so routes can read `row.email` etc.

const SEPARATORS = [',', ';', '\t', '|']

// Which separator is this file using? Counted on the header line only,
// outside quotes, because a header line is the one row guaranteed not to
// contain free text full of commas.
//
// The rule is "most occurrences wins, comma breaks ties". A file with no
// separator at all comes back as a comma, which yields one column — and
// one column is a case the caller has to handle anyway, since a
// single-column file is legitimate for some imports.
export function detectSeparator(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  let line = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') { inQuotes = !inQuotes; line += ch; continue }
    if (!inQuotes && (ch === '\n' || ch === '\r')) break
    line += ch
  }
  // Count outside quotes only: "Smith, John" must not vote for a comma.
  const count = (sep) => {
    let n = 0, q = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { q = !q; continue }
      if (!q && ch === sep) n++
    }
    return n
  }
  let best = ',', bestN = count(',')
  for (const sep of SEPARATORS) {
    if (sep === ',') continue
    const n = count(sep)
    if (n > bestN) { best = sep; bestN = n }
  }
  return best
}

export function parseCSV(text, separator) {
  const sep = separator || detectSeparator(text)
  // Strip a leading BOM if Excel wrote one.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

  const rows = []
  let current  = []
  let field    = ''
  let inQuotes = false
  let i        = 0
  const N      = text.length

  const pushField = () => { current.push(field); field = '' }
  const pushRow   = () => {
    // Skip fully-blank rows (a common trailing-newline artifact).
    if (current.length === 1 && current[0] === '') { current = []; return }
    rows.push(current)
    current = []
  }

  while (i < N) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false
        i++
      } else {
        field += ch
        i++
      }
      continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === sep) { pushField(); i++; continue }
    if (ch === '\n' || ch === '\r') {
      pushField()
      pushRow()
      // consume CRLF as one row boundary
      if (ch === '\r' && text[i + 1] === '\n') i += 2
      else i++
      continue
    }
    field += ch
    i++
  }

  // Final cell / row
  if (field !== '' || current.length > 0) { pushField(); pushRow() }

  return rows
}

// Parses a CSV and returns { headers, rows } where rows is an array of
// plain objects keyed by header name. Header names are lower-cased and
// trimmed so users can write "Name" or " name " and still have it match.
export function parseCSVToObjects(text) {
  const matrix = parseCSV(text)
  if (matrix.length === 0) return { headers: [], rows: [] }
  const [headerRow, ...dataRows] = matrix
  const headers = headerRow.map(h => h.trim().toLowerCase())
  const rows = dataRows.map(row => {
    const obj = {}
    headers.forEach((h, idx) => { obj[h] = (row[idx] ?? '').trim() })
    return obj
  })
  return { headers, rows }
}

// ── Writing ─────────────────────────────────────────────────────────
// Formula-injection guard (shared by the audit-log CSV and the report
// CSV, ARG-LEAK-7). A cell starting with =, +, -, @, tab or CR is
// prefixed with a single quote so a crafted value (e.g. a member named
// "=cmd|'/c calc'!A1") can't execute as a formula when an admin opens the
// export in Excel/Sheets. With { allowNumbers: true } a plain numeric value
// such as -12.50 is left alone so negative figures stay numbers.
const FORMULA_LEAD = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/
export function guardFormula(v, { allowNumbers = false } = {}) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (allowNumbers && (typeof v === 'number' || PLAIN_NUMBER.test(s))) return s
  return FORMULA_LEAD.test(s) ? `'${s}` : s
}

// One always-quoted CSV cell (audit-log export).
export function csvCell(v) {
  if (v === null || v === undefined) return ''
  return `"${guardFormula(v).replace(/"/g, '""')}"`
}
