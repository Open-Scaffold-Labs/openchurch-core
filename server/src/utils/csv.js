// Minimal RFC-4180-ish CSV parser. Handles the cases that matter for
// our strict-schema member import:
//   - comma-separated values
//   - CR, LF, or CRLF line endings
//   - double-quoted fields containing commas or newlines
//   - "" escape inside a quoted field → single "
// Anything fancier (custom delimiters, BOM-stripping beyond the leading
// one, UTF-16) is out of scope — users export as UTF-8 CSV from Excel,
// Google Sheets, or Numbers and this handles those fine.
//
// Returns rows as an array of string arrays. `parseCSVToObjects` on top
// keys each row by its header row so routes can read `row.email` etc.

export function parseCSV(text) {
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
    if (ch === ',') { pushField(); i++; continue }
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
