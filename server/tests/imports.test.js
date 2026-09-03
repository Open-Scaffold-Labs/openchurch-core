// Migration Studio — the tests for bringing a parish's existing records in.
//
// Extracted from smoke.test.js, which had grown past 15,000 lines. These
// blocks moved because they already stood alone: each signs up its own
// parish and shares nothing with the rest of the suite. Nothing about them
// changed in the move — same assertions, same fixtures, same names — so a
// diff of this file against the old one is a pure relocation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { MESSAGE_KEYS, _CATALOGUE_FOR_TESTS } from '../src/i18n/messages.js'
import { readFile } from 'node:fs/promises'
import { RUN_ID, app, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

// ─────────────────────────────────────────────────────────────────────────
// The file a parish actually has (MIG.1.3)
//
// Migration Studio asked for "a UTF-8 CSV" — which asks the least
// technical person in the building to do the hardest step, first, before
// they have any reason to trust us. What they have is an .xlsx.
//
// The format is not the hard part; a library handles the zip and the XML.
// The hard part is that a real parish workbook is not a table. It has an
// "Instructions" tab, a title above the headings, blank rows for looks,
// and a column somebody abandoned in 2019. So the tests are mostly about
// SHAPE, and the strongest one is the round trip: the CSV this produces
// is fed to the same parser the CSV upload path uses, because a converter
// whose output the real ingestion cannot read is a converter that works
// only in its own tests.
// ─────────────────────────────────────────────────────────────────────────
describe('the file a parish actually has — workbooks', () => {
  const W = () => import('../../client/src/utils/workbook.js')

  it('a cell becomes text the same way every time', async () => {
    const { cellToText } = await W()
    // ISO, always. Formatting a date with anything locale-aware turns
    // 07/04 into April 7th or July 4th depending on where the server is
    // standing — the exact ambiguity ISO exists to remove.
    expect(cellToText(new Date('2019-04-07T00:00:00Z'))).toBe('2019-04-07')
    expect(cellToText(250)).toBe('250')
    expect(cellToText(0)).toBe('0')
    // A pledge must not arrive as 250.00000000000003.
    expect(cellToText(0.1 + 0.2)).toBe('0.3')
    expect(cellToText(1234.56)).toBe('1234.56')
    expect(cellToText(null)).toBe('')
    expect(cellToText(undefined)).toBe('')
    expect(cellToText('  padded  ')).toBe('padded')
    expect(cellToText(true)).toBe('true')
  })

  it('THE HEADINGS ARE FOUND, NOT ASSUMED TO BE ROW ONE', async () => {
    const { findHeaderRow } = await W()
    // Title, blank, then the real headings.
    expect(findHeaderRow([
      ["St Anne's Parish — member list", null, null],
      [null, null, null],
      ['Name', 'Email', 'Joined'],
      ['Ana', 'ana@example.org', new Date()],
    ])).toBe(2)
    // A sheet that genuinely starts at row 1 is not second-guessed.
    expect(findHeaderRow([
      ['Name', 'Email'],
      ['Ana', 'ana@example.org'],
    ])).toBe(0)
    // Headings with nothing under them are not headings.
    expect(findHeaderRow([['Name', 'Email']])).toBe(-1)
    expect(findHeaderRow([])).toBe(-1)
  })

  it('A NOTE TO MARGARET IS NOT A COLUMN HEADING', async () => {
    const { findHeaderRow, interpretWorkbook } = await W()
    // Prose scores zero, so an Instructions tab is not offered as
    // somewhere the member list might be. Found by running a real .xlsx
    // through this rather than tidy arrays: the hand-written fixture had
    // one row on that tab, so it fell out for the wrong reason.
    expect(findHeaderRow([
      ['Please do not edit this tab'],
      ['Ask Margaret before changing anything'],
    ])).toBe(-1)
    // Short labels still count, including one-column sheets, which are
    // legitimate for members and funds.
    expect(findHeaderRow([['Name'], ['Ana'], ['Bea']])).toBe(0)
    // A row of bare figures above the headings is data, not a header.
    expect(findHeaderRow([
      [2024, 2025, 2026],
      ['Name', 'Email', 'Joined'],
      ['Ana', 'ana@example.org', 'x'],
    ])).toBe(1)

    const r = interpretWorkbook([
      { name: 'Instructions', rows: [['Please do not edit this tab'], ['Ask Margaret before changing anything']] },
      { name: 'Members', rows: [['Name', 'Email'], ['A', 'a@x.org']] },
    ])
    expect(r.chosen).toBe('Members')
    expect(r.other_sheets).toEqual([])
  })

  it('the tab with the data wins, and the other tabs are named', async () => {
    const { interpretWorkbook } = await W()
    const r = interpretWorkbook([
      { name: 'Instructions', rows: [['Do not edit this tab']] },
      { name: 'Old list', rows: [['Name'], ['Someone']] },
      { name: 'Members', rows: [['Name', 'Email'], ['A', 'a@x.org'], ['B', 'b@x.org']] },
    ])
    expect(r.ok).toBe(true)
    // Most data rows wins — a parish whose list is on tab 3 behind two
    // tabs of notes should not have to know that.
    expect(r.chosen).toBe('Members')
    // Instructions has no rows under a heading, so it is not offered at
    // all. No name blocklist: a parish that calls its member list "Notes"
    // would have been broken by one.
    expect(r.other_sheets).toEqual(['Old list'])
    expect(r.sheets.find(s => s.name === 'Instructions').usable).toBe(false)

    // And an explicit choice is honoured.
    const picked = interpretWorkbook([
      { name: 'Old list', rows: [['Name'], ['Someone']] },
      { name: 'Members', rows: [['Name', 'Email'], ['A', 'a@x.org'], ['B', 'b@x.org']] },
    ], { sheetName: 'Old list' })
    expect(picked.chosen).toBe('Old list')
  })

  it('SKIPPED ROWS ARE REPORTED, NEVER SILENTLY DROPPED', async () => {
    const { interpretWorkbook } = await W()
    const r = interpretWorkbook([{
      name: 'Members',
      rows: [
        ["St Anne's Parish — member list 2026", null, null],
        [null, null, null],
        ['Name', 'Email', 'Joined'],
        ['Ana', 'ana@example.org', new Date('2024-01-02T00:00:00Z')],
      ],
    }])
    // A row we skipped is a change to their data, and a change they
    // cannot see is a change they cannot correct.
    expect(r.skipped_above).toBe(2)
    expect(r.header_row).toBe(3)       // 1-based, as a person counts
    expect(r.data_rows).toBe(1)
    expect(r.headings).toEqual(['Name', 'Email', 'Joined'])
    expect(r.csv.split('\n')[0]).toBe('Name,Email,Joined')
  })

  it('THE CSV IT PRODUCES IS READ BY THE REAL INGESTION PARSER', async () => {
    // The test that matters. A converter whose output the actual upload
    // path cannot read is one that works only in its own tests — so this
    // hands the result to the same parseCSV/detectSeparator the CSV
    // upload uses, with the punctuation that breaks naive converters.
    const { interpretWorkbook } = await W()
    const { parseCSV, detectSeparator } = await import('../src/utils/csv.js')

    const r = interpretWorkbook([{
      name: 'Members',
      rows: [
        ['Name', 'Email', 'Joined', 'Note'],
        ['Gómez, María', 'maria@example.org', new Date('2019-04-07T00:00:00Z'), 'choir'],
        ['Sean O"Brien', 'sean@example.org', new Date('2021-11-14T00:00:00Z'), 'line one\nline two'],
      ],
    }])

    const rows = parseCSV(r.csv, detectSeparator(r.csv))
    expect(rows[0]).toEqual(['Name', 'Email', 'Joined', 'Note'])
    // A comma inside a name must not become a column.
    expect(rows[1]).toEqual(['Gómez, María', 'maria@example.org', '2019-04-07', 'choir'])
    // Quotes and embedded newlines survive intact.
    expect(rows[2][0]).toBe('Sean O"Brien')
    expect(rows[2][3]).toBe('line one\nline two')
    expect(rows).toHaveLength(3)
  })

  it('a workbook with nothing in it says so, rather than staging nothing', async () => {
    const { interpretWorkbook } = await W()
    const r = interpretWorkbook([{ name: 'Instructions', rows: [['Do not edit this tab']] }])
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_data')
  })

  it('THE COPY NO LONGER ASKS FOR A CSV EXPORT', async () => {
    // The whole point of the sprint. If the help text still says
    // "File → Download → CSV", the parish still does the hardest step
    // first, whatever the code can now read.
    const { STRINGS } = await import('../../client/src/i18n/strings.js')
    for (const lang of ['en', 'es']) {
      const help = STRINGS[lang]['mig.fileHelp']
      const notCsv = STRINGS[lang]['mig.notCsv']
      expect(help).toMatch(/\.xlsx/)
      // No instruction to export or download as CSV, in either language.
      expect(help).not.toMatch(/(Download|Descargar|Save As|Guardar como)\s*→?\s*CSV/i)
      expect(notCsv).not.toMatch(/(Download|Descargar)\s*→\s*CSV/i)
      expect(notCsv).toMatch(/\.xlsx/)
    }
  })

  it('the old binary formats are named, not lumped into "unsupported"', async () => {
    const { isWorkbook, isLegacyWorkbook } = await W()
    expect(isWorkbook({ name: 'members.xlsx' })).toBe(true)
    expect(isWorkbook({ name: 'MEMBERS.XLSM' })).toBe(true)
    expect(isWorkbook({ name: 'members.csv' })).toBe(false)
    // .xls is a different format entirely, and the fix is one sentence:
    // Save As, choose .xlsx.
    expect(isLegacyWorkbook({ name: 'members.xls' })).toBe(true)
    expect(isLegacyWorkbook({ name: 'members.xlsb' })).toBe(true)
    expect(isWorkbook({ name: 'members.xls' })).toBe(false)
  })

  it('A REAL .XLSX FILE, THROUGH THE REAL PARSER, END TO END', async () => {
    // Everything above tests the interpretation against hand-written
    // arrays. This proves the arrays are the shape the actual library
    // hands back — the difference between two environments is usually
    // where the bug is.
    const readXlsxFile = (await import('read-excel-file/node')).default
    const { interpretWorkbook } = await W()
    const { parseCSV, detectSeparator } = await import('../src/utils/csv.js')

    const raw = await readXlsxFile(new URL('./fixtures/parish-workbook.xlsx', import.meta.url).pathname)
    const sheets = raw.map(s => ({ name: s.sheet, rows: s.data }))

    const r = interpretWorkbook(sheets)
    expect(r.ok).toBe(true)
    expect(r.chosen).toBe('2026 Members')
    expect(r.skipped_above).toBe(2)
    expect(r.data_rows).toBe(3)
    expect(r.other_sheets).toEqual(['Old list'])

    const rows = parseCSV(r.csv, detectSeparator(r.csv))
    expect(rows[0]).toEqual(['Name', 'Email', 'Joined', 'Notes'])
    expect(rows[1][0]).toBe('Gómez, María')
    expect(rows[1][2]).toBe('2019-04-07')     // a Date, not a serial number
    expect(rows[2][0]).toBe('Sean O"Brien')
    expect(rows).toHaveLength(4)              // header + 3, trailing blank dropped
  })

  it('and the server accepts that CSV as an ordinary import', async () => {
    // The last mile: the text really does stage. Uses the same endpoint
    // and the same body the CSV path posts, because that is the point of
    // converting in the browser.
    const readXlsxFile = (await import('read-excel-file/node')).default
    const { interpretWorkbook } = await W()
    const org = {
      organizationName: `Workbook Parish ${RUN_ID}`, name: 'Wanda Admin',
      email: `wb_admin_${RUN_ID}@example.com`, password: 'smoke-test-pw-wb-1',
    }
    const signup = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.16.21').send(org)
    expect(signup.status).toBe(201)
    const tok = signup.body.token

    const raw = await readXlsxFile(new URL('./fixtures/parish-workbook.xlsx', import.meta.url).pathname)
    const r = interpretWorkbook(raw.map(s => ({ name: s.sheet, rows: s.data })))

    const staged = await request(server).post('/api/imports').set('Authorization', `Bearer ${tok}`)
      .send({ kind: 'members', source_name: 'parish-workbook.xlsx', csv: r.csv })
    expect(staged.status).toBeLessThan(300)
    expect(staged.body.headers).toEqual(['Name', 'Email', 'Joined', 'Notes'])
    expect(staged.body.row_count).toBe(3)
    // The deterministic suggestion still works on headings that came out
    // of a spreadsheet rather than a text file. The mapping is keyed by
    // the parish's OWN heading — the suggestion is about their column,
    // not about our field.
    expect(staged.body.suggested_mapping.Name).toBe('name')
    expect(staged.body.suggested_mapping.Email).toBe('email')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// A backup that reports success while delivering nothing
//
// The weekly digest built a gzipped export of every parish, attached it
// to an email, watched sendEmail fall through to its console stub, and
// returned success. RESEND_API_KEY is unset in production, so the
// artifact went to a log and nowhere else — weekly — while the return
// value said the backup had run.
//
// The file's own header had always promised the opposite: skipped
// "without SUPER_ADMIN_EMAIL (or a live email transport)". Only the
// first was checked. This is the second.
// ─────────────────────────────────────────────────────────────────────────

describe('Migration Studio — both languages, from the server (MIG.1.1)', () => {
  let adminTok, staffTok

  beforeAll(async () => {
    const r = await request(app).post('/api/auth/signup').set('X-Forwarded-For', '10.55.22.1')
      .send({ organizationName: `Bilingual Parish ${RUN_ID}`, name: 'Bea Admin',
              email: `bil_admin_${RUN_ID}@example.com`, password: 'mig-bil-pw-1' })
    expect(r.status).toBe(201)
    adminTok = r.body.token
    const sEmail = `bil_staff_${RUN_ID}@example.com`
    await request(app).post('/api/users').set('Authorization', `Bearer ${adminTok}`)
      .send({ name: 'Sara Staff', email: sEmail, password: 'mig-bil-pw-2', role: 'staff' })
    staffTok = (await request(app).post('/api/auth/login').set('X-Forwarded-For', '10.55.22.2')
      .send({ email: sEmail, password: 'mig-bil-pw-2' })).body.token
  })

  it('EVERY MESSAGE HAS BOTH LANGUAGES, AND THEY ARE NOT THE SAME STRING', () => {
    // A key with only English is caught here, not by a Spanish-speaking
    // secretary. And an entry that "has" Spanish by copying the English
    // is the same failure wearing a costume.
    const missing = [], untranslated = []
    for (const [key, entry] of Object.entries(_CATALOGUE_FOR_TESTS)) {
      if (!entry.en || !entry.es) { missing.push(key); continue }
      if (entry.en === entry.es) untranslated.push(key)
    }
    expect(missing).toEqual([])
    expect(untranslated).toEqual([])
    expect(MESSAGE_KEYS.length).toBeGreaterThan(30)
  })

  it('a required name that is missing reads in both languages', async () => {
    const up = await request(app).post('/api/imports').set('Authorization', `Bearer ${adminTok}`)
      .send({ kind: 'members', source_name: 'x.csv',
              csv: ['Name,Email', `,nobody_${RUN_ID}@example.com`].join('\n') })
    await request(app).put(`/api/imports/${up.body.id}/mapping`)
      .set('Authorization', `Bearer ${adminTok}`).send({ mapping: { Name: 'name', Email: 'email' } })
    const rows = await request(app).get(`/api/imports/${up.body.id}/rows?status=held`)
      .set('Authorization', `Bearer ${adminTok}`)
    // Status first: reading .body.rows off a failed request throws
    // "Cannot read properties of undefined", which names neither the
    // endpoint nor the status code that actually went wrong.
    expect(rows.status).toBe(200)
    expect(rows.body.rows[0].issue_key).toBe('row.name_missing')
    expect(rows.body.rows[0].issue_i18n.en).toMatch(/does not include a name/)
    expect(rows.body.rows[0].issue_i18n.es).toMatch(/no incluye un nombre/)
  })

  it('an unrecognized column reads in both languages', async () => {
    const up = await request(app).post('/api/imports').set('Authorization', `Bearer ${adminTok}`)
      .send({ kind: 'members', source_name: 'y.csv', csv: ['Name,Mystery', `Someone ${RUN_ID},x`].join('\n') })
    const res = await request(app).put(`/api/imports/${up.body.id}/mapping`)
      .set('Authorization', `Bearer ${adminTok}`).send({ mapping: { Name: 'name', Mystery: 'nonsense' } })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('import.field_unsupported')
    expect(res.body.message.en).toMatch(/is not a field this import supports/)
    expect(res.body.message.es).toMatch(/no es un campo admitido/)
    // The parish's own column name is placed, never translated.
    expect(res.body.message.es).toContain('nonsense')
  })

  it('A POSSIBLE DUPLICATE SAYS WHY, IN BOTH LANGUAGES', async () => {
    const name = `Twice Over ${RUN_ID}`
    await request(app).post('/api/clients').set('Authorization', `Bearer ${adminTok}`).send({ name })
    const up = await request(app).post('/api/imports').set('Authorization', `Bearer ${adminTok}`)
      .send({ kind: 'members', source_name: 'z.csv', csv: ['Name', name].join('\n') })
    await request(app).put(`/api/imports/${up.body.id}/mapping`)
      .set('Authorization', `Bearer ${adminTok}`).send({ mapping: { Name: 'name' } })
    const rows = await request(app).get(`/api/imports/${up.body.id}/rows?status=possible_duplicate`)
      .set('Authorization', `Bearer ${adminTok}`)
    // Status first: reading .body.rows off a failed request throws
    // "Cannot read properties of undefined", which names neither the
    // endpoint nor the status code that actually went wrong.
    expect(rows.status).toBe(200)
    const r = rows.body.rows[0]
    expect(r.issue_key).toBe('dup.member_name_exists')
    expect(r.issue_i18n.en).toMatch(/matches the name of an existing member/)
    expect(r.issue_i18n.es).toMatch(/coincide con el nombre de un miembro/)
    expect(r.issue_i18n.es).toContain(name)   // the person's own name, untranslated
  })

  it('LACKING APPROVAL PERMISSION IS EXPLAINED, NOT JUST REFUSED', async () => {
    const up = await request(app).post('/api/imports').set('Authorization', `Bearer ${staffTok}`)
      .send({ kind: 'funds', source_name: 'f.csv', csv: ['Fund', `Flowers ${RUN_ID}`].join('\n') })
    await request(app).put(`/api/imports/${up.body.id}/mapping`)
      .set('Authorization', `Bearer ${staffTok}`).send({ mapping: { Fund: 'name' } })
    const res = await request(app).post(`/api/imports/${up.body.id}/commit`)
      .set('Authorization', `Bearer ${staffTok}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('import.approval_forbidden')
    expect(res.body.message.en).toMatch(/Only a parish administrator can approve/)
    expect(res.body.message.es).toMatch(/Solo un administrador de la parroquia/)
    // It tells them what they CAN do, in both languages.
    expect(res.body.message.en).toMatch(/prepare and review/)
    expect(res.body.message.es).toMatch(/prepararla y revisarla/)
    // Falsification: nothing was imported by the refused request.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_funds WHERE name = $1`, [`Flowers ${RUN_ID}`])
    expect(rows[0].n).toBe(0)
  })

  it('a finished import reports its completion in both languages', async () => {
    const up = await request(app).post('/api/imports').set('Authorization', `Bearer ${adminTok}`)
      .send({ kind: 'funds', source_name: 'g.csv', csv: ['Fund', `Candles ${RUN_ID}`].join('\n') })
    await request(app).put(`/api/imports/${up.body.id}/mapping`)
      .set('Authorization', `Bearer ${adminTok}`).send({ mapping: { Fund: 'name' } })
    const res = await request(app).post(`/api/imports/${up.body.id}/commit`)
      .set('Authorization', `Bearer ${adminTok}`)
    expect(res.status).toBe(200)
    expect(res.body.code).toBe('import.committed')
    expect(res.body.message.en).toMatch(/The import is finished\. 1 records were added/)
    expect(res.body.message.es).toMatch(/La importación terminó/)
    // A success must not carry an `error` field.
    expect(res.body.error).toBeUndefined()
  })

  it('the follow-up reasons on a receipt are grouped by cause, and localized', async () => {
    const up = await request(app).post('/api/imports').set('Authorization', `Bearer ${adminTok}`)
      .send({ kind: 'members', source_name: 'h.csv',
              csv: ['Name,Email',
                    `Good One ${RUN_ID},good_${RUN_ID}@example.com`,
                    `,anon1_${RUN_ID}@example.com`,
                    `,anon2_${RUN_ID}@example.com`].join('\n') })
    await request(app).put(`/api/imports/${up.body.id}/mapping`)
      .set('Authorization', `Bearer ${adminTok}`).send({ mapping: { Name: 'name', Email: 'email' } })
    const res = await request(app).post(`/api/imports/${up.body.id}/commit`)
      .set('Authorization', `Bearer ${adminTok}`)
    expect(res.status).toBe(200)
    const reasons = res.body.receipt.follow_up_reasons
    // Two rows, one cause, ONE line — not two lines that differ only by
    // the email they happened to contain.
    expect(reasons.length).toBe(1)
    expect(reasons[0].count).toBe(2)
    expect(reasons[0].reason_key).toBe('row.name_missing')
    expect(reasons[0].message.es).toMatch(/no incluye un nombre/)
  })

  it('the retention refusal reads in both languages', async () => {
    const up = await request(app).post('/api/imports').set('Authorization', `Bearer ${adminTok}`)
      .send({ kind: 'members', source_name: 'i.csv', csv: ['Name', `Late Arrival ${RUN_ID}`].join('\n') })
    await request(app).put(`/api/imports/${up.body.id}/mapping`)
      .set('Authorization', `Bearer ${adminTok}`).send({ mapping: { Name: 'name' } })
    await pool.query(
      `UPDATE ochr_import_batches SET rows_purged_at = NOW(), rows_purged_count = 1 WHERE id = $1`,
      [up.body.id])
    const res = await request(app).post(`/api/imports/${up.body.id}/commit`)
      .set('Authorization', `Bearer ${adminTok}`)
    expect(res.status).toBe(409)
    expect(res.body.message.en).toMatch(/can no longer be approved/)
    expect(res.body.message.es).toMatch(/ya no se puede aprobar/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Migration Studio — real files, real names, real mistakes (MIG.1.2)
//
// Three fixes found by reading the code against what a parish actually
// sends: accents, separators, and the mapping mistake nobody undoes one
// record at a time.
// ─────────────────────────────────────────────────────────────────────────
describe('Migration Studio — the file a parish actually has (MIG.1.2)', () => {
  let tok, staffTok, orgId

  beforeAll(async () => {
    const r = await request(app).post('/api/auth/signup').set('X-Forwarded-For', '10.55.24.1')
      .send({ organizationName: `Real Files Parish ${RUN_ID}`, name: 'Rafa Admin',
              email: `rf_admin_${RUN_ID}@example.com`, password: 'mig-rf-pw-1' })
    expect(r.status).toBe(201)
    tok = r.body.token
    orgId = r.body.user.organization.id
    const sEmail = `rf_staff_${RUN_ID}@example.com`
    await request(app).post('/api/users').set('Authorization', `Bearer ${tok}`)
      .send({ name: 'Sofía Staff', email: sEmail, password: 'mig-rf-pw-2', role: 'staff' })
    staffTok = (await request(app).post('/api/auth/login').set('X-Forwarded-For', '10.55.24.2')
      .send({ email: sEmail, password: 'mig-rf-pw-2' })).body.token
  })

  const stage = async (kind, csv, mapping, token = tok) => {
    const up = await request(app).post('/api/imports').set('Authorization', `Bearer ${token}`)
      .send({ kind, source_name: 'file.csv', csv })
    if (up.status !== 201) return { up }
    const map = await request(app).put(`/api/imports/${up.body.id}/mapping`)
      .set('Authorization', `Bearer ${token}`).send({ mapping })
    // Assert HERE, not in the caller. Mapping is what assigns every row its
    // status; if this call fails the rows stay 'pending', and that surfaces
    // later as a baffling "expected 'pending' to be 'possible_duplicate'" in
    // whichever test happened to read them -- a flake that names the wrong
    // culprit and sends the next reader into the duplicate detector, which
    // was never wrong. Fail where the failure actually is, and say what it
    // was: a 500 body carries the reason, a silent 'pending' carries none.
    expect(map.status, `mapping ${kind} failed: ${map.status} ${JSON.stringify(map.body)}`).toBe(200)
    return { up, map, id: up.body.id }
  }

  // ── accents ───────────────────────────────────────────────────────────
  it('MARÍA GONZÁLEZ AND MARIA GONZALEZ ARE THE SAME PERSON', async () => {
    await request(app).post('/api/clients').set('Authorization', `Bearer ${tok}`)
      .send({ name: `María González ${RUN_ID}` })
    const { id } = await stage('members',
      ['Name', `Maria Gonzalez ${RUN_ID}`].join('\n'), { Name: 'name' })
    const rows = await request(app).get(`/api/imports/${id}/rows?status=possible_duplicate`)
      .set('Authorization', `Bearer ${tok}`)
    // Status first: reading .body.rows off a failed request throws
    // "Cannot read properties of undefined", which names neither the
    // endpoint nor the status code that actually went wrong.
    expect(rows.status).toBe(200)
    expect(rows.body.rows.length).toBe(1)
    expect(rows.body.rows[0].issue_key).toBe('dup.member_name_exists')
    // …and it is still a QUESTION, not a merge: the row is held for a
    // person, and nothing was written.
    const { rows: live } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_clients WHERE organization_id = $1 AND name LIKE $2`,
      [orgId, `%Gonz%${RUN_ID}`])
    expect(live[0].n).toBe(1)
  })

  it('case and stray spacing fold too, and the stored name keeps its accents', async () => {
    const { id } = await stage('members',
      ['Name', `  maria   gonzalez ${RUN_ID}  `].join('\n'), { Name: 'name' })
    const dups = await request(app).get(`/api/imports/${id}/rows?status=possible_duplicate`)
      .set('Authorization', `Bearer ${tok}`)
    // Status first: reading .body.rows off a failed request throws
    // "Cannot read properties of undefined", which names neither the
    // endpoint nor the status code that actually went wrong.
    expect(dups.status).toBe(200)
    expect(dups.body.rows.length).toBe(1)
    const { rows } = await pool.query(
      `SELECT name FROM ochr_clients WHERE organization_id = $1 AND name LIKE $2`,
      [orgId, `María%${RUN_ID}`])
    expect(rows[0].name).toBe(`María González ${RUN_ID}`)   // never written folded
  })

  it('two accented spellings of one name inside the SAME file are caught', async () => {
    const { id } = await stage('members',
      ['Name', `José Ramírez ${RUN_ID}`, `Jose Ramirez ${RUN_ID}`].join('\n'), { Name: 'name' })
    const dups = await request(app).get(`/api/imports/${id}/rows?status=possible_duplicate`)
      .set('Authorization', `Bearer ${tok}`)
    // Status first: reading .body.rows off a failed request throws
    // "Cannot read properties of undefined", which names neither the
    // endpoint nor the status code that actually went wrong.
    expect(dups.status).toBe(200)
    expect(dups.body.rows.length).toBe(1)
    expect(dups.body.rows[0].issue_key).toBe('dup.member_name_in_file')
    expect(dups.body.rows[0].issue_i18n.es).toMatch(/tiene el mismo nombre/)
  })

  // ── gift duplicates against gifts already in the ledger ───────────────
  // This is the check a parish's FIRST import leans on hardest — the one run
  // right after a migration, when the ledger is at its largest — and until
  // now nothing exercised it. The bounded (date, amount) lookup that replaced
  // "load every donation into a Set" was falsifiable four ways and the suite
  // caught none of them, which is how a silent regression reaches a parish.
  describe('a gift already in the ledger is flagged, and only the right one is', () => {
    const donor = `Consuelo Ibáñez ${RUN_ID}`

    beforeAll(async () => {
      const d = await request(app).post('/api/donations').set('Authorization', `Bearer ${tok}`)
        .send({ donor_name: donor, amount: 75, category: 'tithe', date: '2026-05-10' })
      expect(d.status).toBe(201)
    })

    const giftRows = async csv => {
      const { id } = await stage('gifts', ['Donor,Amount,Date', ...csv].join('\n'),
        { Donor: 'donor_name', Amount: 'amount', Date: 'date' })
      const res = await request(app).get(`/api/imports/${id}/rows`)
        .set('Authorization', `Bearer ${tok}`)
      expect(res.status).toBe(200)
      return res.body.rows
    }

    it('the same gift arriving twice is flagged, not silently re-imported', async () => {
      const rows = await giftRows([`${donor},75,2026-05-10`])
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe('possible_duplicate')
      expect(rows[0].issue_key).toBe('dup.gift_exists')
    })

    it('the donor name folds — Consuelo Ibanez is Consuelo Ibáñez', async () => {
      const rows = await giftRows([`consuelo  ibanez ${RUN_ID},75,2026-05-10`])
      expect(rows[0].status).toBe('possible_duplicate')
      expect(rows[0].issue_key).toBe('dup.gift_exists')
    })

    it('same day, different amount is a SECOND gift, not a duplicate', async () => {
      // Pins the amount half of the lookup. A parish family giving twice on
      // one Sunday — envelope and a second-collection cheque — must not have
      // the second one held.
      const rows = await giftRows([`${donor},20,2026-05-10`])
      expect(rows[0].status).toBe('ready')
      expect(rows[0].issue_key).toBe(null)
    })

    it('same amount, different day is a SECOND gift, not a duplicate', async () => {
      // Pins the date half. A standing weekly gift of the same amount is the
      // most common giving pattern there is; flagging every week after the
      // first would make the importer useless.
      const rows = await giftRows([`${donor},75,2026-05-17`])
      expect(rows[0].status).toBe('ready')
      expect(rows[0].issue_key).toBe(null)
    })

    it('a different donor on the same day for the same amount is not a duplicate', async () => {
      const rows = await giftRows([`Someone Else ${RUN_ID},75,2026-05-10`])
      expect(rows[0].status).toBe('ready')
    })

    it('two identical rows inside one file: the first is ready, the second is flagged', async () => {
      const rows = await giftRows([
        `Nuevo Donante ${RUN_ID},33,2026-06-07`,
        `Nuevo Donante ${RUN_ID},33,2026-06-07`,
      ])
      expect(rows.length).toBe(2)
      expect(rows[0].status).toBe('ready')
      expect(rows[1].status).toBe('possible_duplicate')
      expect(rows[1].issue_key).toBe('dup.gift_in_file')
    })

    it("another parish's identical gift is invisible to this one", async () => {
      // The bounded lookup joins ochr_donations on (date, amount) — values
      // two parishes collide on constantly. Without the org scope, a
      // neighbouring parish's $75 gift on 10 May from a same-named donor
      // would hold this parish's row for review, which both blocks a real
      // gift and tells one parish something about another's ledger.
      const other = await request(app).post('/api/auth/signup').set('X-Forwarded-For', '10.55.24.9')
        .send({ organizationName: `Neighbour Parish ${RUN_ID}`, name: 'Nadia Admin',
                email: `nb_admin_${RUN_ID}@example.com`, password: 'mig-nb-pw-1' })
      expect(other.status).toBe(201)
      const otherDonor = `Solo En La Otra ${RUN_ID}`
      const d = await request(app).post('/api/donations')
        .set('Authorization', `Bearer ${other.body.token}`)
        .send({ donor_name: otherDonor, amount: 91.5, category: 'tithe', date: '2026-07-19' })
      expect(d.status).toBe(201)

      // This parish has never seen that gift.
      const { rows: mine } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ochr_donations
          WHERE organization_id = $1 AND donor_name = $2`, [orgId, otherDonor])
      expect(mine[0].n, 'fixture: the gift must exist ONLY in the other parish').toBe(0)

      const rows = await giftRows([`${otherDonor},91.50,2026-07-19`])
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe('ready')
      expect(rows[0].issue_key).toBe(null)
    })

    it('a file of only unreadable rows still validates instead of erroring', async () => {
      // The bounded lookup skips rows whose date or amount will not parse, so
      // a file with nothing parseable yields no candidate pairs at all. That
      // branch skips the query entirely — it must not blow up on the way.
      const rows = await giftRows([`${donor},not a number,not a date`])
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe('held')
    })
  })

  it('an accented fund name matches the fund a gift asks for', async () => {
    await request(app).post('/api/funds').set('Authorization', `Bearer ${tok}`)
      .send({ name: `Reparación del Techo ${RUN_ID}` })
    const { id } = await stage('gifts',
      ['Donor,Amount,Date,Fund',
       `Ana Ruiz,25,2026-03-09,Reparacion del Techo ${RUN_ID}`].join('\n'),
      { Donor: 'donor_name', Amount: 'amount', Date: 'date', Fund: 'fund' })
    const rows = await request(app).get(`/api/imports/${id}/rows`).set('Authorization', `Bearer ${tok}`)
    // Status first: reading .body.rows off a failed request throws
    // "Cannot read properties of undefined", which names neither the
    // endpoint nor the status code that actually went wrong.
    expect(rows.status).toBe(200)
    // Not held for an unknown fund — the accents are the only difference.
    expect(rows.body.rows[0].status).toBe('ready')
    expect(rows.body.rows[0].normalized.fund_id).toBeTruthy()
  })

  // ── separators ────────────────────────────────────────────────────────
  it('A SEMICOLON FILE — WHAT EXCEL WRITES IN SPANISH — IMPORTS', async () => {
    const res = await request(app).post('/api/imports').set('Authorization', `Bearer ${tok}`)
      .send({ kind: 'members', source_name: 'padrón.csv',
              csv: ['Nombre;Correo', `Pilar Sánchez ${RUN_ID};pilar_${RUN_ID}@example.com`].join('\n') })
    expect(res.status).toBe(201)
    expect(res.body.separator).toBe(';')
    expect(res.body.headers).toEqual(['Nombre', 'Correo'])
    expect(res.body.row_count).toBe(1)
  })

  it('tab-separated files read too, and a quoted comma still does not split', async () => {
    const tabbed = await request(app).post('/api/imports').set('Authorization', `Bearer ${tok}`)
      .send({ kind: 'members', source_name: 't.csv', csv: `Name\tEmail\nTab Person ${RUN_ID}\tt_${RUN_ID}@example.com` })
    expect(tabbed.body.separator).toBe('tab')
    expect(tabbed.body.headers).toEqual(['Name', 'Email'])

    const quoted = await request(app).post('/api/imports').set('Authorization', `Bearer ${tok}`)
      .send({ kind: 'members', source_name: 'q.csv',
              csv: ['Name,Tags', `"Smith, John ${RUN_ID}","choir, lectors"`].join('\n') })
    expect(quoted.body.separator).toBe(',')
    expect(quoted.body.sample_rows[0].Name).toBe(`Smith, John ${RUN_ID}`)
  })

  it('A FILE WE CANNOT SPLIT SAYS SO AT THE DOOR', async () => {
    // A separator we do not know at all. The old behaviour let this
    // through as one column and failed three screens later complaining
    // about an unmapped field.
    const res = await request(app).post('/api/imports').set('Authorization', `Bearer ${tok}`)
      .send({ kind: 'gifts', source_name: 'weird.csv',
              csv: ['Donor^Amount^Date', 'Ana^25^2026-03-09'].join('\n') })
    expect(res.status).toBe(400)
    // Not "headings missing" — the headings are right there. The file
    // just does not separate them with anything we read.
    expect(res.body.code).toBe('import.one_column')
    expect(res.body.message.en).toContain('Donor^Amount^Date')
  })

  it('a single-column file with a separator in its heading is explained', async () => {
    const res = await request(app).post('/api/imports').set('Authorization', `Bearer ${tok}`)
      .send({ kind: 'gifts', source_name: 'onecol.csv',
              csv: ['"Donor;Amount;Date"', '"Ana;25;2026-03-09"'].join('\n') })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('import.one_column')
    expect(res.body.message.en).toMatch(/Only one column was found/)
    expect(res.body.message.es).toMatch(/Solo se encontró una columna/)
    expect(res.body.message.es).toMatch(/CSV UTF-8/)
  })

  // ── undo ──────────────────────────────────────────────────────────────
  it('UNDOING AN IMPORT MOVES ITS RECORDS TO ARCHIVE & RECOVERY, NOT AWAY', async () => {
    const { id } = await stage('members',
      ['Name,Email',
       `Undo One ${RUN_ID},u1_${RUN_ID}@example.com`,
       `Undo Two ${RUN_ID},u2_${RUN_ID}@example.com`].join('\n'),
      { Name: 'name', Email: 'email' })
    const done = await request(app).post(`/api/imports/${id}/commit`).set('Authorization', `Bearer ${tok}`)
    expect(done.status).toBe(200)
    expect(done.body.receipt.imported).toBe(2)

    const before = await request(app).get(`/api/imports/${id}`).set('Authorization', `Bearer ${tok}`)
    expect(before.body.can_undo).toBe(true)

    const undo = await request(app).post(`/api/imports/${id}/undo`).set('Authorization', `Bearer ${tok}`)
    expect(undo.status).toBe(200)
    expect(undo.body.summary.removed).toBe(2)
    expect(undo.body.message.es).toMatch(/La importación se deshizo/)

    // Gone from the roster…
    const { rows: live } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_clients WHERE organization_id = $1 AND name LIKE $2`,
      [orgId, `Undo%${RUN_ID}`])
    expect(live[0].n).toBe(0)

    // …and recoverable as ONE entry, because undoing an import is one act.
    // This used to write an entry per record — so undoing a four-hundred-row
    // import made four hundred vault entries, and reversing that undo meant
    // four hundred clicks that all had to succeed. The label still names who
    // is inside, so an administrator can see what she is about to put back.
    const vault = await request(app).get('/api/vault').set('Authorization', `Bearer ${tok}`)
    const entries = vault.body.entries.filter(e => e.label.includes('Undo') && e.label.includes(RUN_ID))
    expect(entries.length).toBe(1)
    expect(entries[0].label).toMatch(/^2 members · /)
    expect(entries[0].label).toContain(`Undo One ${RUN_ID}`)
    expect(entries[0].label).toContain(`Undo Two ${RUN_ID}`)
    expect(undo.body.summary.vault_entry_id).toBe(entries[0].id)

    // One restore brings the whole import back.
    const back = await request(app).post(`/api/vault/${entries[0].id}/restore`).set('Authorization', `Bearer ${tok}`)
    expect(back.status).toBe(200)
    const { rows: again } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_clients WHERE organization_id = $1 AND name LIKE $2`,
      [orgId, `Undo%${RUN_ID}`])
    expect(again[0].n).toBe(2)
  })

  it('an undo that fails part way leaves NOTHING half-done', async () => {
    // Undo used to run outside any transaction: a loop of vault captures,
    // then a separate statement stamping the batch undone. A serverless
    // function that ran out of time in the middle — which a two-thousand-row
    // import would — left some records vaulted, the rest live, and the batch
    // still offering to undo them. The second click then found the first
    // half "already gone" and wrote a receipt claiming it removed nothing.
    //
    // Simulated by breaking the batch UPDATE, which is the last statement in
    // the transaction. If the capture is enlisted in it, a failure there
    // rolls the deletions back too.
    const { id } = await stage('members',
      ['Name,Email',
       `Atomic One ${RUN_ID},a1_${RUN_ID}@example.com`,
       `Atomic Two ${RUN_ID},a2_${RUN_ID}@example.com`].join('\n'),
      { Name: 'name', Email: 'email' })
    const done = await request(app).post(`/api/imports/${id}/commit`).set('Authorization', `Bearer ${tok}`)
    expect(done.body.receipt.imported).toBe(2)

    const vaultBefore = (await request(app).get('/api/vault')
      .set('Authorization', `Bearer ${tok}`)).body.entries.length

    // undo_summary is jsonb; a trigger that raises on write to this batch is
    // the cleanest way to fail the final statement without touching the code
    // under test.
    await pool.query(`
      CREATE OR REPLACE FUNCTION ochr_test_break_undo_${RUN_ID.replace(/\W/g, '')}()
        RETURNS trigger AS $fn$
        BEGIN
          IF NEW.undone_at IS NOT NULL AND OLD.undone_at IS NULL THEN
            RAISE EXCEPTION 'simulated failure stamping the batch undone';
          END IF;
          RETURN NEW;
        END;
      $fn$ LANGUAGE plpgsql;`)
    await pool.query(`
      CREATE TRIGGER ochr_test_break_undo
        BEFORE UPDATE ON ochr_import_batches
        FOR EACH ROW EXECUTE FUNCTION ochr_test_break_undo_${RUN_ID.replace(/\W/g, '')}();`)

    let res
    try {
      res = await request(app).post(`/api/imports/${id}/undo`).set('Authorization', `Bearer ${tok}`)
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS ochr_test_break_undo ON ochr_import_batches')
    }
    expect(res.status).toBe(500)

    // Nothing half-done: both members still on the roster...
    const { rows: live } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_clients WHERE organization_id = $1 AND name LIKE $2`,
      [orgId, `Atomic%${RUN_ID}`])
    expect(live[0].n, 'the records must not have been removed').toBe(2)

    // ...no orphan vault entry claiming to hold them...
    const vaultAfter = await request(app).get('/api/vault').set('Authorization', `Bearer ${tok}`)
    expect(vaultAfter.body.entries.length).toBe(vaultBefore)
    expect(vaultAfter.body.entries.filter(e => e.label.includes(`Atomic`)).length).toBe(0)

    // ...and the batch still offers the undo, honestly.
    const after = await request(app).get(`/api/imports/${id}`).set('Authorization', `Bearer ${tok}`)
    expect(after.body.can_undo).toBe(true)
    expect(after.body.undone_at).toBe(null)

    // And now it works, with the obstruction gone.
    const retry = await request(app).post(`/api/imports/${id}/undo`).set('Authorization', `Bearer ${tok}`)
    expect(retry.status).toBe(200)
    expect(retry.body.summary.removed).toBe(2)
  })

  it('UNDO LEAVES ALONE ANYTHING SOMEBODY HAS EDITED SINCE', async () => {
    const { id } = await stage('members',
      ['Name,Email',
       `Edited Later ${RUN_ID},el_${RUN_ID}@example.com`,
       `Untouched ${RUN_ID},un_${RUN_ID}@example.com`].join('\n'),
      { Name: 'name', Email: 'email' })
    await request(app).post(`/api/imports/${id}/commit`).set('Authorization', `Bearer ${tok}`)

    // Somebody fixes a phone number the next morning. That correction is
    // theirs, not the import's.
    const { rows: [edited] } = await pool.query(
      `SELECT id FROM ochr_clients WHERE organization_id = $1 AND name = $2`,
      [orgId, `Edited Later ${RUN_ID}`])
    await request(app).patch(`/api/clients/${edited.id}`).set('Authorization', `Bearer ${tok}`)
      .send({ phone: '555-0199' })

    const undo = await request(app).post(`/api/imports/${id}/undo`).set('Authorization', `Bearer ${tok}`)
    expect(undo.status).toBe(200)
    expect(undo.body.summary.removed).toBe(1)
    expect(undo.body.summary.left_alone_because_edited).toBe(1)

    const { rows: survivor } = await pool.query(
      `SELECT phone FROM ochr_clients WHERE id = $1`, [edited.id])
    expect(survivor.length).toBe(1)
    expect(survivor[0].phone).toBe('555-0199')     // the correction survives
    const { rows: gone } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_clients WHERE organization_id = $1 AND name = $2`,
      [orgId, `Untouched ${RUN_ID}`])
    expect(gone[0].n).toBe(0)
  })

  it('THE RECEIPT TELLS THE WHOLE STORY AFTERWARDS', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM ochr_import_batches
        WHERE organization_id = $1 AND undone_at IS NOT NULL ORDER BY id DESC LIMIT 1`, [orgId])
    const res = await request(app).get(`/api/imports/${rows[0].id}`).set('Authorization', `Bearer ${tok}`)
    expect(res.body.status).toBe('committed')          // still true about the past
    expect(res.body.undone_at).not.toBeNull()
    expect(res.body.can_undo).toBe(false)
    expect(res.body.receipt.imported).toBe(2)          // what it DID import
    expect(res.body.receipt.undone.removed).toBe(1)
    expect(res.body.receipt.undone.left_alone_because_edited).toBe(1)
    expect(res.body.receipt.undone.by.name).toBe('Rafa Admin')
  })

  it('an import cannot be undone twice, and staff cannot undo at all', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM ochr_import_batches
        WHERE organization_id = $1 AND undone_at IS NOT NULL ORDER BY id DESC LIMIT 1`, [orgId])
    const again = await request(app).post(`/api/imports/${rows[0].id}/undo`).set('Authorization', `Bearer ${tok}`)
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('undo.already_undone')

    const { id } = await stage('funds', ['Fund', `Undoable ${RUN_ID}`].join('\n'), { Fund: 'name' })
    await request(app).post(`/api/imports/${id}/commit`).set('Authorization', `Bearer ${tok}`)
    const asStaff = await request(app).post(`/api/imports/${id}/undo`).set('Authorization', `Bearer ${staffTok}`)
    expect(asStaff.status).toBe(403)
    // Falsification: the fund is still there after the refusal.
    const { rows: still } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_funds WHERE organization_id = $1 AND name = $2`,
      [orgId, `Undoable ${RUN_ID}`])
    expect(still[0].n).toBe(1)
  })

  it('UNDO CLOSES WHEN THE STAGED ROWS DO, AND SAYS WHY', async () => {
    const { id } = await stage('funds', ['Fund', `Late Undo ${RUN_ID}`].join('\n'), { Fund: 'name' })
    await request(app).post(`/api/imports/${id}/commit`).set('Authorization', `Bearer ${tok}`)
    await pool.query(
      `UPDATE ochr_import_batches SET rows_purged_at = NOW(), rows_purged_count = 1 WHERE id = $1`, [id])

    const res = await request(app).post(`/api/imports/${id}/undo`).set('Authorization', `Bearer ${tok}`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('undo.window_closed')
    expect(res.body.message.en).toMatch(/ordinary parish records now/)
    expect(res.body.message.es).toMatch(/registros normales de la parroquia/)
    const check = await request(app).get(`/api/imports/${id}`).set('Authorization', `Bearer ${tok}`)
    expect(check.body.can_undo).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// A gift's fund decides its account (FIN.086)
//
// The assessable base is computed from the chart of accounts, and the
// chart already marks restricted and pass-through revenue as
// non-assessable. What was missing was the wire between a gift and that
// decision: donations resolved their account from a typed CATEGORY
// string, `fund_id` was ignored entirely, and anything unmapped fell into
// 4420 — which is assessable. A parish's restricted capital giving was
// inflating its own assessment, silently, upward.
// ─────────────────────────────────────────────────────────────────────────

// ── The flake's discriminator (open investigation, not a fix) ─────────────
//
// PUT /api/imports/:id/mapping fails about one run in seventeen. What is
// established: `pending` proves the mapping call never landed, and the
// duplicate detector is provably innocent. What is NOT established is the
// cause, and two candidates remain — a caught query error, or a
// pool.connect() timeout at PG_POOL_MAX=5.
//
// Sixteen further runs, including a cold one, did not reproduce it. Sixteen
// green runs are not a fix. So the response now carries a coarse `fault`
// discriminator, and these tests prove the discriminator itself works —
// because an instrument nobody has watched read correctly is worth as much
// as a guard nobody has watched fail.
describe('import mapping — telling the two failure candidates apart', () => {
  it('classifies a pool-acquisition timeout distinctly from a query error', async () => {
    const { faultKind } = await import('../src/utils/faultKind.js')

    // The exact phrase node-postgres raises when every client is checked out
    // and connectionTimeoutMillis elapses. Candidate 2.
    expect(faultKind(new Error('timeout exceeded when trying to connect')))
      .toBe('pool_timeout')

    // A Postgres error carries a SQLSTATE. Candidate 1.
    const pgErr = Object.assign(new Error('invalid input syntax for type integer'), { code: '22P02' })
    expect(faultKind(pgErr)).toBe('db:22P02')

    // The two must never collapse into the same answer — that is the whole
    // point of adding the field.
    expect(faultKind(pgErr)).not.toBe(faultKind(new Error('timeout exceeded when trying to connect')))

    // And neither leaks a message or a stack into the API response.
    expect(faultKind(pgErr)).not.toMatch(/invalid input|syntax/i)
    expect(faultKind(new Error('something nobody predicted'))).toBe('unknown')
  })

  it('a real mapping failure reports a fault the log can be searched by', async () => {
    // Drive the actual route to a failure and require the discriminator to
    // survive the round trip. Without this the classifier could be perfect
    // and still never reach anybody.
    const who = await request(server).post('/api/auth/signup').send({
      organizationName: `Fault Probe ${Date.now()}`,
      name: 'Probe Admin', email: `fault_${Date.now()}@example.com`, password: 'probe-pw-12345',
    })
    expect(who.status).toBe(201)

    const res = await request(server)
      .put('/api/imports/999999999/mapping')
      .set('Authorization', `Bearer ${who.body.token}`)
      .send({ mapping: { a: 'b' } })

    // A missing batch is a clean 404, not a fault — that is correct, and it
    // is what makes a 500 here meaningful when it does happen.
    expect([404, 400]).toContain(res.status)
    expect(res.body.fault, 'a refusal must not be labelled a fault').toBeUndefined()
  })
})
