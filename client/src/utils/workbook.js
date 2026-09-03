// Reading the file a parish actually has.
//
// Migration Studio asked for "a UTF-8 CSV". That sentence asks the least
// technical person in the building to do the hardest step, and it is the
// FIRST thing we ask of them — before they have any reason to trust us.
// The file they have is an .xlsx, because that is what the last person
// left them and what Excel saves by default.
//
// THE PARSING HAPPENS IN THE BROWSER, AND THAT IS A PROMISE, NOT A
// PREFERENCE. The import receipt says "the original file was not stored",
// and the cleanest way to keep a promise about not storing a file is for
// the file never to reach the server at all. The workbook is read here,
// converted to exactly the CSV text the existing path already accepts,
// and only that text is sent. The server, the staged-row retention, the
// receipt and the undo are all untouched — this is a new door into an
// unchanged room.
//
// WHAT IS ACTUALLY HARD is not the format. read-excel-file handles the
// zip and the XML. The hard part is that a real parish workbook is not a
// table: it has a tab called "Instructions", a merged title cell above
// the headings, two blank rows for looks, and a "Notes" column somebody
// abandoned in 2019. Every one of those is handled below, and every one
// of them is REPORTED rather than silently fixed — a row we skipped is a
// change to their data, and important changes are understandable.

// ── which files ──────────────────────────────────────────────────────────
// .xlsm is the same format with macros; we read the sheet and never run
// anything. .xls (the pre-2007 binary) is NOT supported, and saying so by
// name is kinder than a generic "unsupported file".
export const WORKBOOK_RE = /\.(xlsx|xlsm)$/i
export const LEGACY_RE = /\.(xls|xlsb)$/i

export function isWorkbook(file) {
  return WORKBOOK_RE.test(file?.name || '')
}
export function isLegacyWorkbook(file) {
  return LEGACY_RE.test(file?.name || '')
}

// ── values ───────────────────────────────────────────────────────────────
// Everything downstream is a CSV string, so every cell has to become one.
// The two that matter:
//
//   Dates. The parser hands back a JS Date at UTC midnight. Formatting it
//   with anything locale-aware would turn 07/04 into April 7th or July
//   4th depending on where the server is standing, which is precisely the
//   ambiguity ISO exists to remove.
//
//   Numbers. A pledge of 250 must not arrive as "250.00000000000003", and
//   a member id of 00123 must not become 123 — but the second is already
//   lost by the time it reaches us, because Excel stored it as a number.
//   Nothing here can recover it, and pretending otherwise would be worse
//   than the honest limitation.
export function cellToText(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)))
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v).trim()
}

const isBlankRow = row => row.every(c => cellToText(c) === '')

// ── the header row ───────────────────────────────────────────────────────
// Not "row 1". A parish sheet routinely opens with a merged title and a
// blank line, and taking row 1 as the headings produces one column called
// "St Anne's Parish — member list 2026" and a very confusing screen.
//
// The rule: among the first HEADER_SEARCH_DEPTH non-blank rows, the
// header is the one with the most non-empty TEXT cells that is followed
// by at least one more non-blank row. Text cells specifically — a title
// row has one, and a data row that happens to sit above the headings has
// dates and numbers in it.
//
// Ties go to the EARLIER row, so a sheet that genuinely starts at row 1
// is never second-guessed.
const HEADER_SEARCH_DEPTH = 12

// A heading is a LABEL, not a sentence. Without this, an "Instructions"
// tab reading "Please do not edit this tab" / "Ask Margaret before
// changing anything" scores as a one-column table with one row, gets
// offered as somewhere the member list might be, and the parish is asked
// to choose between their real tab and a note to Margaret.
//
// Found by running a real .xlsx through this rather than the tidy arrays
// the earlier tests used — the hand-written Instructions sheet had one
// row, so nothing followed it and it fell out for the wrong reason.
//
// Bare numbers are excluded too: a row of figures sitting above the
// headings is data, not a header.
const MAX_HEADING_CHARS = 40
const MAX_HEADING_WORDS = 5

function looksLikeHeading(c) {
  if (typeof c !== 'string') return false
  const v = c.trim()
  if (!v || v.length > MAX_HEADING_CHARS) return false
  if (v.split(/\s+/).length > MAX_HEADING_WORDS) return false
  if (/^\d+([.,]\d+)?$/.test(v)) return false
  return true
}

export function findHeaderRow(rows) {
  let best = -1, bestScore = 0
  const depth = Math.min(rows.length, HEADER_SEARCH_DEPTH)
  for (let i = 0; i < depth; i++) {
    if (isBlankRow(rows[i])) continue
    // Must be followed by something, or it is the last line of a sheet
    // with no data rather than a heading.
    if (!rows.slice(i + 1).some(r => !isBlankRow(r))) continue
    const score = rows[i].filter(c => looksLikeHeading(c)).length
    if (score > bestScore) { bestScore = score; best = i }
  }
  return bestScore > 0 ? best : -1
}

// ── which sheet ──────────────────────────────────────────────────────────
// A sheet is a candidate if it has a header row and at least one row
// under it. "Instructions", "Sheet3" and the tab somebody used as
// scratch paper all fall out naturally without a name blocklist, because
// they have no data — and a blocklist would have been wrong the first
// time a parish named its member list "Notes".
export function describeSheets(sheets) {
  return sheets.map(s => {
    const rows = s.rows.filter(r => Array.isArray(r))
    const headerAt = findHeaderRow(rows)
    const dataRows = headerAt < 0 ? 0 : rows.slice(headerAt + 1).filter(r => !isBlankRow(r)).length
    return {
      name: s.name,
      header_row: headerAt,          // 0-based; -1 when there is none
      skipped_above: headerAt < 0 ? 0 : headerAt,
      headings: headerAt < 0 ? [] : rows[headerAt].map(cellToText).filter(Boolean),
      data_rows: dataRows,
      usable: headerAt >= 0 && dataRows > 0,
    }
  })
}

// ── to CSV ───────────────────────────────────────────────────────────────
// Always a comma, always quoted where it matters. This text is handed to
// the same parser the CSV path uses, so it must be unambiguous rather
// than pretty — and going through that parser rather than around it is
// what keeps one code path for separators, quoting and BOMs.
export function rowsToCsv(rows) {
  const esc = v => {
    const s = cellToText(v)
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  return rows.map(r => r.map(esc).join(',')).join('\n')
}

// Trailing empty columns are what a stray formatted cell in column Z
// leaves behind. They arrive as headings called "" and become a column
// nobody can map.
function trimColumns(rows) {
  let width = 0
  for (const r of rows) {
    for (let i = r.length - 1; i >= 0; i--) {
      if (cellToText(r[i]) !== '') { width = Math.max(width, i + 1); break }
    }
  }
  return rows.map(r => r.slice(0, width))
}

// The whole interpretation, as one pure function over already-parsed
// sheets. Everything above is testable because none of it opens a file.
export function interpretWorkbook(sheets, { sheetName = null } = {}) {
  const described = describeSheets(sheets)
  const usable = described.filter(s => s.usable)

  if (!usable.length) return { ok: false, reason: 'no_data', sheets: described }

  const chosen = sheetName
    ? usable.find(s => s.name === sheetName)
    // Most data rows wins. A parish whose member list is on tab 3 behind
    // two tabs of notes should not have to know that.
    : usable.slice().sort((a, b) => b.data_rows - a.data_rows)[0]

  if (!chosen) return { ok: false, reason: 'no_such_sheet', sheets: described }

  const raw = sheets.find(s => s.name === chosen.name).rows.filter(r => Array.isArray(r))
  const body = raw.slice(chosen.header_row).filter(r => !isBlankRow(r))
  const csv = rowsToCsv(trimColumns(body))

  return {
    ok: true,
    csv,
    sheets: described,
    chosen: chosen.name,
    // Everything the screen needs to SAY what it did, rather than
    // silently doing it.
    header_row: chosen.header_row + 1,        // 1-based, as a person counts
    skipped_above: chosen.skipped_above,
    data_rows: chosen.data_rows,
    headings: chosen.headings,
    other_sheets: usable.filter(s => s.name !== chosen.name).map(s => s.name),
  }
}

// ── the thin part ────────────────────────────────────────────────────────
// The only piece that touches the parser, and therefore the only piece
// the suite cannot drive in node. Kept to four lines on purpose: the
// logic worth testing is all above this line.
//
// Lazily imported so the parser is not in the main bundle — Migration
// Studio is admin-only and most sessions never open it.
export async function readWorkbook(file) {
  // The subpath, not the package root: read-excel-file publishes no root
  // export, only ./browser, ./node, ./universal and ./web-worker.
  // Importing the root builds fine in dev and fails the production bundle
  // — the kind of break that only appears at deploy time.
  const { default: readXlsxFile } = await import('read-excel-file/browser')
  const out = await readXlsxFile(file, { getSheets: true })
  // This build returns [{sheet, data}] whatever the options say; older
  // and newer ones return bare rows for a single sheet. Accept both
  // rather than depending on which is installed.
  const sheets = Array.isArray(out) && out.length && out[0]?.sheet !== undefined
    ? out.map(s => ({ name: s.sheet, rows: s.data }))
    : [{ name: 'Sheet1', rows: out }]
  return sheets
}
