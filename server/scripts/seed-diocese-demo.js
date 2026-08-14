// Two-parish diocese demo seed (DIO.3) — the chancery demo in one command.
//
//   node scripts/seed-diocese-demo.js [base-url]
//
// Against a RUNNING dev server (default http://localhost:3034), builds the
// full OpenDiocese story end-to-end THROUGH THE PUBLIC API — no direct DB
// writes, so the demo exercises exactly what a real chancery would:
//
//   1. Diocese of Santa Clara (Demo)   — the chancery account
//   2. St. Anne Parish (Demo)          — "ledger-native": donations + manual
//                                        entries + category mappings
//   3. Holy Cross Parish (Demo)        — "QuickBooks parish": everything
//                                        arrives via trial-balance CSV import
//   4. Both parishes affiliate (St. Anne grants DETAIL, Holy Cross SUMMARY —
//      so the grant-level difference shows in the drill-down)
//   5. Both submit last month + the month before; the chancery approves all
//      four periods → the roll-up dashboard is fully lit
//
// Idempotent-enough for demos: if an account already exists, we log in
// instead of signing up; duplicate submissions 409 and are skipped.
// NEVER run against production — guarded by refusing non-local hosts
// unless SEED_DEMO_ALLOW_REMOTE=1.
//
// Demo credentials (password for all three): demo-diocese-1234
//   chancery@opendiocese.demo  /  stanne@opendiocese.demo  /  holycross@opendiocese.demo

const BASE = process.argv[2] || 'http://localhost:3034'
if (!/localhost|127\.0\.0\.1/.test(BASE) && process.env.SEED_DEMO_ALLOW_REMOTE !== '1') {
  console.error(`Refusing to seed non-local host ${BASE} (set SEED_DEMO_ALLOW_REMOTE=1 to override).`)
  process.exit(1)
}

const PASSWORD = 'demo-diocese-1234'
const DIOCESE  = { organizationName: 'Diocese of Santa Clara (Demo)', name: 'Bishop Demo',  email: 'chancery@opendiocese.demo',  organizationType: 'diocese' }
const ST_ANNE  = { organizationName: 'St. Anne Parish (Demo)',        name: 'Anne Admin',   email: 'stanne@opendiocese.demo' }
const HOLYCROSS = { organizationName: 'Holy Cross Parish (Demo)',     name: 'Cruz Admin',   email: 'holycross@opendiocese.demo' }

// ── helpers ──────────────────────────────────────────────────
// Random per-run source block: reruns never share an IP with a previous
// run, so the 3-per-hour signup limiter can't accumulate across runs.
const XFF_BLOCK = 100 + Math.floor(Math.random() * 150)
let xffCounter = 1
async function api(path, { method = 'GET', token, body, xff } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // Distinct per-signup source IPs so the 3-per-hour signup limiter
      // never trips a rerun of this script (trust proxy honors XFF).
      ...(xff ? { 'X-Forwarded-For': xff } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function signupOrLogin(org) {
  const xff = `10.77.${XFF_BLOCK}.${xffCounter++}`
  const su = await api('/api/auth/signup', { method: 'POST', xff, body: { ...org, password: PASSWORD } })
  if (su.status === 201) { console.log(`  ✓ created ${org.organizationName}`); return su.data.token }
  // 409 = account exists; 429 = limiter tripped but the account may well
  // exist from a previous run — in both cases, try logging in.
  if (su.status !== 409 && su.status !== 429) throw new Error(`signup ${org.email}: ${su.status} ${su.data.error ?? ''}`)
  const li = await api('/api/auth/login', { method: 'POST', xff, body: { email: org.email, password: PASSWORD } })
  if (li.status !== 200) throw new Error(`login ${org.email}: ${li.status} ${li.data.error ?? ''}`)
  console.log(`  ↺ reusing ${org.organizationName}`)
  return li.data.token
}

const pad = n => String(n).padStart(2, '0')
function monthWindow(offset) { // offset=1 → last month
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - offset, 1)
  const last  = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0)
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return { start: iso(first), end: iso(last), mid: `${first.getFullYear()}-${pad(first.getMonth() + 1)}-15` }
}

async function must(promise, label) {
  const r = await promise
  if (r.status >= 400 && r.status !== 409) throw new Error(`${label}: ${r.status} ${r.data.error ?? ''}`)
  if (r.status === 409) console.log(`  ↺ ${label} already done`)
  return r
}

// ── the story ────────────────────────────────────────────────
const run = async () => {
  console.log(`Seeding the OpenDiocese demo against ${BASE}\n`)

  console.log('Accounts:')
  const dio = await signupOrLogin(DIOCESE)
  const anne = await signupOrLogin(ST_ANNE)
  const cruz = await signupOrLogin(HOLYCROSS)

  console.log('\nAffiliations:')
  // Rerun-safe: an already-active parish needs neither invite nor accept.
  async function affiliate(parishToken, email, grant, who) {
    const cur = await api('/api/affiliation', { token: parishToken })
    if (cur.data.affiliation?.status === 'active') { console.log(`  ↺ ${who} already affiliated`); return }
    await must(api('/api/diocese/parishes/invite', { method: 'POST', token: dio, body: { email } }), `invite ${who}`)
    await must(api('/api/affiliation/accept', { method: 'POST', token: parishToken, body: { grant_level: grant } }), `${who} accepts (${grant})`)
  }
  await affiliate(anne, ST_ANNE.email, 'detail', 'St. Anne')
  await affiliate(cruz, HOLYCROSS.email, 'summary', 'Holy Cross')
  console.log('  ✓ both parishes affiliated')

  const m1 = monthWindow(2) // two months ago
  const m2 = monthWindow(1) // last month

  // St. Anne — ledger-native: mapped donations + manual expenses.
  console.log('\nSt. Anne (ledger-native):')
  await must(api('/api/finance/mappings', { method: 'PUT', token: anne, body: { mappings: [
    { source_type: 'donation_category', source_key: 'tithe',   account_code: '4110' },
    { source_type: 'donation_category', source_key: 'Building Fund', account_code: '4420' },
  ] } }), 'mappings')
  // Rerun-safe: skip any month whose ledger already has entries — posting
  // twice would silently double St. Anne's book.
  for (const [m, sundays, building] of [[m1, 8420.5, 1200], [m2, 9130.25, 950]]) {
    const led = await api(`/api/finance/ledger?start=${m.start}&end=${m.end}&limit=1`, { token: anne })
    if ((led.data.entries ?? []).length > 0) { console.log(`  ↺ ${m.start} already recorded`); continue }
    await must(api('/api/donations', { method: 'POST', token: anne, body: { donor_name: 'Sunday Offertory', amount: sundays, category: 'tithe', date: m.mid } }), `offertory ${m.start}`)
    await must(api('/api/donations', { method: 'POST', token: anne, body: { donor_name: 'Building Drive', amount: building, category: 'Building Fund', date: m.mid } }), `building ${m.start}`)
    await must(api('/api/finance/ledger', { method: 'POST', token: anne, body: { entry_date: m.mid, account_code: '5420', amount: 780.4, memo: 'PG&E + water' } }), `utilities ${m.start}`)
    await must(api('/api/finance/ledger', { method: 'POST', token: anne, body: { entry_date: m.mid, account_code: '5310', amount: 214.75, memo: 'Candles + hosts' } }), `liturgy ${m.start}`)
    // Non-assessable revenue so the demo shows assessable base < revenue.
    await must(api('/api/finance/ledger', { method: 'POST', token: anne, body: { entry_date: m.mid, account_code: '4710', amount: 600, memo: 'Parish hall rental' } }), `rental ${m.start}`)
  }
  console.log('  ✓ two months of donations + expenses recorded')

  // Holy Cross — the QuickBooks parish: one trial-balance upload per month.
  console.log('\nHoly Cross (trial-balance import):')
  for (const [m, offertory, relEd, wages, maint] of [[m1, 6210.0, 800, 2400, 655.2], [m2, 6875.4, 800, 2400, 310]]) {
    const cled = await api(`/api/finance/ledger?start=${m.start}&end=${m.end}&limit=1`, { token: cruz })
    if ((cled.data.entries ?? []).length > 0) { console.log(`  ↺ ${m.end} already imported`); continue }
    const csv = ['account_code,amount,memo',
      `4110,${offertory},Offertory per QuickBooks`,
      `4310,${relEd},Religious ed fees`,
      `5120,${wages},Parish staff wages`,
      `5410,${maint},Building maintenance`].join('\n')
    await must(api('/api/finance/ledger/import', { method: 'POST', token: cruz, body: { csv, as_of: m.end } }), `import ${m.end}`)
  }
  console.log('  ✓ two trial balances imported')

  console.log('\nSubmissions:')
  for (const [token, who] of [[anne, 'St. Anne'], [cruz, 'Holy Cross']]) {
    for (const m of [m1, m2]) {
      await must(api('/api/finance/submissions', { method: 'POST', token, body: { period_start: m.start, period_end: m.end } }), `${who} submits ${m.start}`)
    }
  }
  const queue = await api('/api/diocese/submissions?status=submitted', { token: dio })
  for (const s of queue.data.submissions ?? []) {
    await must(api(`/api/diocese/submissions/${s.id}`, { method: 'PATCH', token: dio, body: { status: 'approved' } }), `approve ${s.parish_name} ${s.period_start}`)
  }
  console.log(`  ✓ ${queue.data.submissions?.length ?? 0} period(s) approved`)

  const { start } = m1, { end } = m2
  const rollup = await api(`/api/diocese/financials?start=${start}&end=${end}`, { token: dio })
  console.log(`\nRoll-up check: ${rollup.data.parishes?.length ?? 0} parishes, revenue $${rollup.data.totals?.revenue}, assessable $${rollup.data.totals?.assessable_base}`)

  // ═══ Phase Zero: parish life ═══════════════════════════════════
  // Everything below stages ST. ANNE as the laptop-across-the-table
  // demo parish — the one a secretary sees. The goal is "lived-in":
  // a week of Mass intentions ready to print as the Sacristy Weekly
  // Manifest (the physical wedge), a half-digitized paper register
  // (drafts pending, custody intact), this morning's checklist mid-
  // tick, and Sunday's order of worship already drafted.
  const parishMembers = await seedParishLife(anne)

  // Depth pass: schedule, groups, tasks, pledges, a year of giving, and
  // (when DATABASE_URL is provided) backdated history so Insights has a
  // past to chart and the pastoral-care list has someone to care about.
  await seedParishDepth(anne, parishMembers)

  console.log(`\nDone. Sign in to the chancery app (client-diocese, port 5204):`)
  console.log(`  ${DIOCESE.email} / ${PASSWORD}`)
  console.log(`Parish logins (parish app, port 5202):`)
  console.log(`  ${ST_ANNE.email} / ${PASSWORD}   (grant: detail)`)
  console.log(`  ${HOLYCROSS.email} / ${PASSWORD} (grant: summary)`)
}

// ── Phase Zero parish-life staging ───────────────────────────
// All dates are computed relative to "today" so the demo always looks
// current no matter when the script runs. Idempotent: every section
// checks what exists before writing, so reruns refresh nothing and
// break nothing.

const isoOffset = days => {
  const d = new Date(); d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
// Next Sunday, today included — always inside the manifest's
// today→+6 window.
const nextSundayOffset = () => (7 - new Date().getDay()) % 7

async function seedParishLife(anne) {
  console.log('\nSt. Anne — parish life (Phase Zero demo staging):')

  // ── Month three, not day one. Clear the [Sample] signup data, finish
  //    every onboarding item (letterhead, teammate, published page), so
  //    the "Get started" card and sample banner never photobomb a demo.
  const ob = await api('/api/onboarding/status', { token: anne })
  if (ob.data.hasSamples) {
    await must(api('/api/onboarding/clear-samples', { method: 'POST', token: anne }), 'clear samples')
    console.log('  ✓ [Sample] signup data cleared')
  }
  await must(api('/api/organization', { method: 'PATCH', token: anne, body: {
    address: '1200 Contra Costa Blvd, Pleasant Hill, CA 94523',
    tax_id: '94-1156342',
    signatory_name: 'Rev. Thomas Rojas',
    signatory_title: 'Pastor',
    tagline: 'A parish family since 1902',
    about: 'St. Anne has served the families of Pleasant Hill for over a century. All are welcome at our table.',
    service_times: 'Sunday 9:00 AM & 11:00 AM · Saturday Vigil 5:00 PM · Daily Mass Tue–Fri 8:00 AM',
    page_published: true,
  } }), 'letterhead + public page')
  const invite = await api('/api/users', { method: 'POST', token: anne, body: {
    name: 'Grace Whitfield', email: 'grace@stanne.demo', password: PASSWORD, role: 'staff',
  } })
  if (invite.status !== 201 && invite.status !== 409) throw new Error(`teammate: ${invite.status} ${invite.data.error ?? ''}`)
  console.log('  ✓ letterhead set, page published, secretary on the team')

  // Calendar events so the week ahead isn't empty.
  const evs = await api('/api/events?limit=100', { token: anne })
  const evTitles = new Set((Array.isArray(evs.data) ? evs.data : evs.data.events ?? []).map(e => e.title))
  for (const [title, off] of [['Parish Council — 7:00 PM', 2], ['Confessions — 3:30 PM', 5], ['Rosary Guild — parish hall', 8]]) {
    if (evTitles.has(title)) continue
    await must(api('/api/events', { method: 'POST', token: anne, body: { title, date: isoOffset(off) } }), `event ${title}`)
  }
  console.log('  ✓ the week ahead has events')

  // Members. Find-or-create by exact name so reruns don't duplicate.
  const memberIds = {}
  async function member(name, extras = {}) {
    const found = await api(`/api/clients?search=${encodeURIComponent(name)}`, { token: anne })
    const hit = (found.data.clients ?? found.data ?? []).find?.(c => c.name === name)
    if (hit) { memberIds[name] = hit.id; return hit.id }
    const r = await must(api('/api/clients', { method: 'POST', token: anne, body: { name, ...extras } }), `member ${name}`)
    memberIds[name] = r.data.id
    return r.data.id
  }
  await member('Carmen Alvarez',  { email: 'carmen.alvz@example.com', phone: '(925) 555-0163' })
  await member('Sofia Alvarez Keller', { email: 'sofia.ak@example.com' })
  await member('Robert Keller',   { phone: '(925) 555-0117' })
  await member('Susan Keller',    { email: 'skeller@example.com', phone: '(925) 555-0117' })
  await member('Kim Nguyen',      { email: 'kim.nguyen@example.com' })
  await member("Danny O'Rourke",  { phone: '(925) 555-0198' })
  await member('Rosemary Piper',  { email: 'r.piper@example.com', phone: '(925) 555-0142' })
  await member('Hank Piper',      { phone: '(925) 555-0142' })
  console.log('  ✓ members present')

  // ── Mass intentions: the printed manifest is the wedge. A full
  //    week, mixed the way a real book is mixed — the deceased, the
  //    sick, an anniversary, the Holy Father — plus one already
  //    fulfilled and one still open so the workflow states show.
  const existing = await api('/api/mass-intentions?limit=100', { token: anne })
  const have = new Set((existing.data.intentions ?? []).map(i => i.intention))
  async function intention(body) {
    if (have.has(body.intention)) { console.log(`  ↺ intention exists: ${body.intention.slice(0, 40)}`); return }
    await must(api('/api/mass-intentions', { method: 'POST', token: anne, body }), `intention ${body.intention.slice(0, 30)}`)
  }
  const sun = nextSundayOffset()
  await intention({
    intention: '† Miguel Alvarez — first anniversary',
    requested_by: 'Carmen Alvarez', requested_by_client_id: memberIds['Carmen Alvarez'],
    mass_date: isoOffset(sun), status: 'scheduled', stipend: 10,
    note: 'First anniversary of death. Announce at the 9:00 AM Mass — Carmen and the family will be in the front pews.',
  })
  await intention({ intention: '† Alma Reyes', requested_by: 'The Reyes family',
    mass_date: isoOffset(0), status: 'fulfilled', stipend: 10 })
  await intention({ intention: '† Souls in Purgatory', requested_by: 'The Rosary Guild',
    mass_date: isoOffset(1), status: 'scheduled' })
  await intention({ intention: 'Healing of Robert Keller',
    requested_by: 'Susan Keller', requested_by_client_id: memberIds['Susan Keller'],
    mass_date: isoOffset(2), status: 'scheduled', stipend: 10,
    note: 'He asks for prayers, not visits.' })
  await intention({ intention: 'In thanksgiving — 50th wedding anniversary of Hank & Rosemary Piper',
    requested_by: 'The Piper family', mass_date: isoOffset(3), status: 'scheduled', stipend: 20 })
  await intention({ intention: '† Fr. Lawrence Boyle, former pastor',
    requested_by: 'The parish', mass_date: isoOffset(4), status: 'scheduled' })
  await intention({ intention: 'Intentions of the Holy Father',
    mass_date: isoOffset(5), status: 'scheduled' })
  await intention({ intention: '† Deceased members of the Nguyen family',
    requested_by: 'Kim Nguyen', requested_by_client_id: memberIds['Kim Nguyen'],
    mass_date: isoOffset(6), status: 'scheduled', stipend: 10 })
  await intention({ intention: 'For a private intention', requested_by: 'M. T.', status: 'open' })
  console.log('  ✓ a week of Mass intentions in the book')

  // ── Register digitization drafts (SAC.6): the "canonical custody"
  //    demo beat. Three mapped and ready, one — Miguel's 1961 baptism
  //    from the water-damaged page — deliberately left unmapped, so
  //    the demo shows a human deciding, not software presuming.
  const pend = await api('/api/sacraments/drafts?status=pending', { token: anne })
  if ((pend.data.drafts ?? []).length > 0) {
    console.log(`  ↺ ${pend.data.drafts.length} pending draft(s) already staged`)
  } else {
    await must(api('/api/sacraments/drafts', { method: 'POST', token: anne, body: { drafts: [
      {
        source: 'csv',
        raw_payload: { name: 'Sofia Alvarez', type: 'baptism', date: '1998-05-17', minister: 'Rev. Lawrence Boyle', register: 'Vol. IV, p. 112' },
        draft: { client_id: memberIds['Sofia Alvarez Keller'], type: 'baptism', date: '1998-05-17',
                 minister: 'Rev. Lawrence Boyle', place: 'St. Anne Parish', certificate_no: 'B-1998-042',
                 meta_attributes: { godparents: ['Teresa Marquez', 'Juan Marquez'] } },
      },
      {
        source: 'csv',
        raw_payload: { name: 'Robert Keller & Susan Grady', type: 'marriage', date: '2004-06-19', minister: 'Rev. Lawrence Boyle', register: 'Vol. IV, p. 203' },
        draft: { client_id: memberIds['Robert Keller'], type: 'marriage', date: '2004-06-19',
                 minister: 'Rev. Lawrence Boyle', place: 'St. Anne Parish', certificate_no: 'M-2004-011',
                 meta_attributes: { witnesses: ['Daniel Grady', 'Maureen Keller'] } },
      },
      {
        source: 'csv',
        raw_payload: { name: 'Kim Nguyen', type: 'confirmation', date: '2012-04-29', minister: 'Most Rev. James Byrne', register: 'Vol. V, p. 34' },
        draft: { client_id: memberIds['Kim Nguyen'], type: 'confirmation', date: '2012-04-29',
                 minister: 'Most Rev. James Byrne', place: 'Cathedral of St. Joseph', certificate_no: 'C-2012-078',
                 meta_attributes: { sponsors: ['Anh Nguyen'] } },
      },
      {
        source: 'ocr',
        raw_payload: { name: 'Miguel Alvarez', type: 'baptism', date: '1961-03-05', register: 'Vol. II, p. 41', condition: 'water-damaged entry — minister illegible' },
        draft: { type: 'baptism', date: '1961-03-05', place: 'St. Anne Parish',
                 notes: 'From Register Vol. II, p. 41 — water-damaged; minister line illegible. Not yet linked to a member record.' },
      },
    ] } }), 'stage register drafts')
    console.log('  ✓ 4 register drafts staged (3 mapped, Miguel’s 1961 baptism left for review)')
  }

  // ── Two committed register records so the permanent register
  //    isn't an empty book behind the drafts.
  async function sacrament(clientName, body) {
    const cid = memberIds[clientName]
    const timeline = await api(`/api/sacraments?client_id=${cid}`, { token: anne })
    const rows = timeline.data.records ?? []
    if (rows.some?.(s => s.type === body.type)) { console.log(`  ↺ ${clientName} ${body.type} recorded`); return }
    await must(api('/api/sacraments', { method: 'POST', token: anne, body: { client_id: cid, ...body } }), `${clientName} ${body.type}`)
  }
  await sacrament('Kim Nguyen', { type: 'first_communion', date: '2004-05-02',
    minister: 'Rev. Lawrence Boyle', place: 'St. Anne Parish', certificate_no: 'FC-2004-019' })
  await sacrament("Danny O'Rourke", { type: 'baptism', date: '1987-09-13',
    minister: 'Rev. Edward Hastings', place: 'St. Anne Parish', certificate_no: 'B-1987-105' })
  console.log('  ✓ permanent register has committed records')

  // ── Daily checklists: templates + this morning's run mid-tick.
  const tpls = await api('/api/checklists/templates', { token: anne })
  if ((tpls.data.templates ?? []).length === 0) {
    await must(api('/api/checklists/templates', { method: 'POST', token: anne, body: {
      title: 'Sunday opening',
      items: ['Unlock front doors and side ramp', 'Lights: nave, sanctuary, narthex', 'Start coffee for hospitality', 'Test lectern microphone', 'Set out bulletins and hymn boards'],
    } }), 'checklist: Sunday opening')
    await must(api('/api/checklists/templates', { method: 'POST', token: anne, body: {
      title: 'Sacristy prep',
      items: ['Lay out vestments (check the color!)', 'Fill cruets, check hosts', 'Charcoal + incense for 11:00', 'Print the weekly manifest'],
    } }), 'checklist: Sacristy prep')
    await must(api('/api/checklists/templates', { method: 'POST', token: anne, body: {
      title: 'Lock-up',
      items: ['Candles out, sanctuary lamp checked', 'Lock sacristy and side doors', 'Set the alarm'],
    } }), 'checklist: Lock-up')
  } else {
    console.log(`  ↺ ${tpls.data.templates.length} checklist template(s) exist`)
  }
  const today = await api('/api/checklists/today', { token: anne })
  const opening = (today.data.runs ?? []).find(r => r.title === 'Sunday opening')
  if (opening && !opening.items.some(i => i.done)) {
    for (const idx of [0, 1, 2]) {
      await must(api(`/api/checklists/runs/${opening.id}`, { method: 'PATCH', token: anne, body: { index: idx, done: true } }), `tick ${idx}`)
    }
    console.log('  ✓ this morning’s opening checklist is 3/5 done')
  } else {
    console.log('  ↺ today’s runs already materialized')
  }

  // ── Sunday's order of worship + the parish's own feast day.
  const sunday = isoOffset(sun === 0 ? 7 : sun)
  const plans = await api('/api/service-plans', { token: anne })
  if (!(plans.data.plans ?? []).some(p => p.date === sunday)) {
    const plan = await must(api('/api/service-plans', { method: 'POST', token: anne, body: {
      date: sunday, title: 'Sunday Mass — 9:00 AM',
    } }), 'service plan')
    const els = [
      { kind: 'hymn',    title: 'Processional: Holy God, We Praise Thy Name', reference: 'Hymnal 424' },
      { kind: 'rite',    title: 'Greeting & Penitential Act' },
      { kind: 'reading', title: 'First Reading', reference: 'Lectionary — Sunday cycle' },
      { kind: 'psalm',   title: 'Responsorial Psalm', reference: 'Cantor: K. Nguyen' },
      { kind: 'reading', title: 'Gospel' },
      { kind: 'sermon',  title: 'Homily', notes: 'Fr. — draft in AI Studio, review Thursday' },
      { kind: 'hymn',    title: 'Offertory: Be Thou My Vision', reference: 'Hymnal 450' },
      { kind: 'rite',    title: 'Communion' },
      { kind: 'hymn',    title: 'Recessional: Now Thank We All Our God', reference: 'Hymnal 430' },
    ]
    for (const el of els) {
      await must(api(`/api/service-plans/${plan.data.id}/elements`, { method: 'POST', token: anne, body: el }), `element ${el.title.slice(0, 20)}`)
    }
    console.log(`  ✓ order of worship drafted for ${sunday}`)
  } else {
    console.log(`  ↺ Sunday plan for ${sunday} exists`)
  }

  // ── The Sunday Packet's remaining sections (SPK.1): a Sunday Mass on
  //    the calendar with servers assigned, and the bulletin's
  //    announcements — so the printed packet demo has every section lit.
  const cal = await api(`/api/calendar?start=${sunday}&end=${sunday}`, { token: anne })
  const calRows = Array.isArray(cal.data) ? cal.data : cal.data.events ?? []
  if (!calRows.some(e => /^Sunday Mass/.test(e.title))) {
    await must(api('/api/calendar', { method: 'POST', token: anne, body: {
      title: 'Sunday Mass', date: sunday, start_time: '09:00', end_time: '10:15',
      type: 'service', assigned_to: [memberIds['Kim Nguyen'], memberIds["Danny O'Rourke"]],
    } }), 'Sunday Mass on the calendar')
  }
  await must(api('/api/bulletins', { method: 'POST', token: anne, body: {
    date: sunday, title: 'Parish Announcements', published: true,
    announcements: [
      'The Rosary Guild meets Thursday at 10:00 AM in the parish hall — newcomers always welcome.',
      'Registration for autumn faith formation opens this week; forms are in the narthex.',
      `Please keep Carmen Alvarez and her family in your prayers as we mark the first anniversary of Miguel's passing at the 9:00 AM Mass.`,
    ].join('\n\n'),
    pastor_note: 'A parish is not a schedule — it is a family that keeps time together. Thank you for keeping it so well. — Fr. Rojas',
  } }), 'bulletin')
  console.log('  ✓ Sunday Mass staffed + bulletin drafted (packet fully lit)')

  // Patronal feast — ON CONFLICT(org,date) upserts, so always safe.
  await must(api('/api/parish-feasts', { method: 'POST', token: anne, body: {
    date: isoOffset(12), feast_name: 'Dedication of St. Anne Parish Church', liturgical_color: 'White',
  } }), 'parish feast')
  console.log('  ✓ parish feast on the calendar')

  console.log('\n  Demo beats ready:')
  console.log('  · Intentions → Print — the Sacristy Weekly Manifest (the physical wedge)')
  console.log('  · Register → Drafts — 3 mapped + Miguel Alvarez 1961, unmapped on purpose (custody beat)')
  console.log('  · Dashboard — opening checklist mid-tick, Sunday plan one click from Service Mode')
  return memberIds
}

// ── Phase Zero depth pass ────────────────────────────────────
// Everything a lived-in parish accumulates: the recurring service
// schedule, ministries and their people, the office task list, pledges
// with a real fulfillment story, and a year of giving for the charts.
// Giving figures are grounded in published US parish-giving surveys
// (roughly $10–15/household/week at the offertory; pledge commitments
// in the $50–$300/month band) so the numbers read true to anyone who
// has actually counted a Sunday collection.
//
// Everything here goes through the public API except the TIME MACHINE
// at the end. A real parish gets its history by living it; a demo has
// to inherit one. Backdating is the single thing the API rightly
// refuses to do, so — only when DATABASE_URL is provided — we reach
// into the database to age member join dates and attendance history.
// Nothing else is ever written directly.

async function seedParishDepth(anne, memberIds) {
  console.log('\nSt. Anne — depth pass (schedule, groups, tasks, pledges, giving history):')

  // ── A. The recurring service schedule.
  const sched = await api('/api/schedule', { token: anne })
  const schedRows = Array.isArray(sched.data) ? sched.data : []
  const services = [
    { title: 'Sunday Mass',        day_of_week: 'Sunday',   start_time: '09:00', end_time: '10:15', service_type: 'Mass',       location: 'Main church' },
    { title: 'Sunday Mass (late)', day_of_week: 'Sunday',   start_time: '11:00', end_time: '12:15', service_type: 'Mass',       location: 'Main church' },
    { title: 'Saturday Vigil',     day_of_week: 'Saturday', start_time: '17:00', end_time: '18:00', service_type: 'Mass',       location: 'Main church' },
    { title: 'Daily Mass',         day_of_week: 'Tuesday',  start_time: '08:00', end_time: '08:30', service_type: 'Mass',       location: 'Chapel' },
    { title: 'Confessions',        day_of_week: 'Saturday', start_time: '15:30', end_time: '16:30', service_type: 'Sacrament',  location: 'Confessional' },
  ]
  for (const s of services) {
    if (schedRows.some(r => r.title === s.title)) continue
    await must(api('/api/schedule', { method: 'POST', token: anne, body: { ...s, recurrence: 'weekly' } }), `schedule ${s.title}`)
  }
  console.log('  ✓ recurring services on the schedule')

  // ── B. Ministries & groups, with their people.
  const grp = await api('/api/groups', { token: anne })
  const haveGroups = new Set((grp.data.groups ?? []).map(g => g.name))
  const groups = [
    { name: 'Rosary Guild',   category: 'ministry',   description: 'Thursday mornings, parish hall. Keeps the candle rack and the prayer chain.', leader: 'Carmen Alvarez', members: ['Carmen Alvarez', 'Rosemary Piper'] },
    { name: 'Altar Guild',    category: 'ministry',   description: 'Vestments, linens, and the sacristy — the quiet work behind every Mass.', leader: 'Susan Keller', members: ['Susan Keller', "Danny O'Rourke"] },
    { name: 'Parish Council', category: 'committee',  description: 'Advises the pastor. Meets the first Tuesday of the month.', leader: 'Robert Keller', members: ['Robert Keller', 'Kim Nguyen', 'Hank Piper'] },
    { name: 'Young Families', category: 'life_group', description: 'Play dates, meal trains, and second-Sunday brunches.', leader: 'Sofia Alvarez Keller', members: ['Sofia Alvarez Keller', 'Kim Nguyen'] },
  ]
  for (const g of groups) {
    if (haveGroups.has(g.name)) continue
    await must(api('/api/groups', { method: 'POST', token: anne, body: {
      name: g.name, category: g.category, description: g.description,
      leader_client_id: memberIds[g.leader],
      member_ids: g.members.map(m => memberIds[m]).filter(Boolean),
    } }), `group ${g.name}`)
  }
  console.log('  ✓ ministries staffed')

  // ── C. The office task list — what a Tuesday actually looks like.
  const tk = await api('/api/tasks?limit=200', { token: anne })
  const haveTasks = new Set((Array.isArray(tk.data) ? tk.data : []).map(t => t.title))
  const tasks = [
    { title: 'Submit bulletin to printer',            category: 'Office',     priority: 'high',   due: 0, description: 'Deadline is 3 PM for Sunday delivery.' },
    { title: 'Order altar candles before Sunday',     category: 'Liturgy',    priority: 'high',   due: 1 },
    { title: 'Count and deposit Sunday collection',   category: 'Finance',    priority: 'medium', due: 3, description: 'Two counters required — Danny confirmed.' },
    { title: 'Call organ tuner about the swell reed', category: 'Facilities', priority: 'medium', due: 8 },
    { title: 'Renew liability insurance paperwork',   category: 'Office',     priority: 'low',    due: 20 },
  ]
  for (const t of tasks) {
    if (haveTasks.has(t.title)) continue
    await must(api('/api/tasks', { method: 'POST', token: anne, body: {
      title: t.title, category: t.category, priority: t.priority, status: 'pending',
      due_date: isoOffset(t.due), ...(t.description ? { description: t.description } : {}),
    } }), `task ${t.title.slice(0, 24)}`)
  }
  console.log('  ✓ office tasks on the board')

  // ── D. Pledges — commitments in the realistic $50–$300/month band.
  const pl = await api('/api/pledges', { token: anne })
  const havePledges = new Set((pl.data.pledges ?? []).map(p => `${p.member_id ?? p.donor_email}`))
  const pledges = [
    { member: 'Carmen Alvarez', amount: 150, frequency: 'monthly', startMonths: 8, notes: 'Memorial pledge in memory of Miguel.' },
    { member: 'Susan Keller',   amount: 200, frequency: 'monthly', startMonths: 6 },
    { member: 'Kim Nguyen',     amount: 100, frequency: 'monthly', startMonths: 5 },
    { donor_email: 'piper.family@example.com', donor_name: 'Hank & Rosemary Piper', amount: 1000, frequency: 'one_time', startMonths: 2, notes: '50th-anniversary thanksgiving gift.' },
  ]
  for (const p of pledges) {
    const key = p.member ? `${memberIds[p.member]}` : p.donor_email
    if (havePledges.has(key)) continue
    await must(api('/api/pledges', { method: 'POST', token: anne, body: {
      ...(p.member ? { member_id: memberIds[p.member] } : { donor_email: p.donor_email }),
      amount: p.amount, frequency: p.frequency,
      start_date: isoOffset(-30 * p.startMonths),
      end_date: isoOffset(365 - 30 * p.startMonths),
      ...(p.notes ? { notes: p.notes } : {}),
    } }), `pledge ${p.member ?? p.donor_email}`)
  }
  console.log('  ✓ pledges recorded')

  // ── E. A year of giving — fills the Insights charts and partially
  //    fulfills the pledges (matching runs on donor email).
  const dn = await api('/api/donations?limit=500', { token: anne })
  const haveDon = new Set((Array.isArray(dn.data) ? dn.data : []).map(d => `${d.date?.slice(0, 10)}|${d.donor_name}`))
  const donation = async (body) => {
    if (haveDon.has(`${body.date}|${body.donor_name}`)) return
    await must(api('/api/donations', { method: 'POST', token: anne, body }), `gift ${body.donor_name} ${body.date}`)
  }
  for (let m = 3; m <= 11; m++) {
    // Older offertory months (the recent two come from the ledger seed
    // above). Small parish: ~$1.8–2.3k/week → monthly lump here.
    const wobble = [7840.25, 8110.0, 7625.5, 8480.75, 8955.0, 7710.25, 8320.5, 9040.0, 8215.75][m - 3]
    await donation({ donor_name: 'Sunday Offertory', amount: wobble, category: 'tithe', date: isoOffset(-30 * m + 14) })
  }
  for (let m = 0; m <= 5; m++) {
    const d = isoOffset(-30 * m - 3)
    await donation({ donor_name: 'Carmen Alvarez', donor_email: 'carmen.alvz@example.com', amount: 150, category: 'tithe', date: d })
    await donation({ donor_name: 'Susan Keller', donor_email: 'skeller@example.com', amount: 200, category: 'tithe', date: d })
    if (m <= 3) await donation({ donor_name: 'Kim Nguyen', donor_email: 'kim.nguyen@example.com', amount: 100, category: 'tithe', date: d })
  }
  await donation({ donor_name: 'Hank & Rosemary Piper', donor_email: 'piper.family@example.com', amount: 1000, category: 'tithe', date: isoOffset(-40) })
  await donation({ donor_name: 'The Reyes family', amount: 250, category: 'Memorials', date: isoOffset(-12), notes: 'In memory of Alma Reyes' })
  await donation({ donor_name: 'Anonymous', amount: 85, category: 'Flowers', date: isoOffset(-9) })
  await donation({ donor_name: 'Nguyen family', donor_email: 'kim.nguyen@example.com', amount: 120, category: 'Religious Education', date: isoOffset(-20) })
  console.log('  ✓ a year of giving on the books')

  // ── F. THE TIME MACHINE (optional; direct SQL, clearly fenced).
  if (!process.env.DATABASE_URL) {
    console.log('  ○ history backfill skipped — run with DATABASE_URL set to age member joins')
    console.log('    and attendance (feeds the members-joined chart, attendance trend, and the')
    console.log('    "haven’t shown up recently" pastoral-care list).')
    return
  }
  const { default: pg } = await import('pg')
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows: orgRows } = await db.query(
      `SELECT organization_id AS id FROM ochr_users WHERE email = $1`, [ST_ANNE.email])
    const orgId = orgRows[0]?.id
    if (!orgId) throw new Error('St. Anne org not found for backfill')

    // Age the join dates → the members-joined chart gets a story.
    const joins = [
      ['Carmen Alvarez', 420], ['Robert Keller', 300], ['Susan Keller', 300],
      ['Kim Nguyen', 210], ["Danny O'Rourke", 150], ['Sofia Alvarez Keller', 95],
      ['Rosemary Piper', 60], ['Hank Piper', 45],
    ]
    for (const [name, days] of joins) {
      await db.query(
        `UPDATE ochr_clients SET created_at = NOW() - ($1 || ' days')::interval
          WHERE organization_id = $2 AND name = $3`, [days, orgId, name])
    }

    // Past Sunday Masses with marked attendance → the attendance trend
    // gets a line, and the Pipers quietly lapse (last seen ~5 weeks ago)
    // so the pastoral-care list has a reason to exist.
    const regulars = ['Carmen Alvarez', 'Sofia Alvarez Keller', 'Robert Keller', 'Susan Keller', 'Kim Nguyen', "Danny O'Rourke"]
    for (const weeksAgo of [1, 5, 9, 13, 17, 21]) {
      const evDate = isoOffset(-7 * weeksAgo)
      const { rows: evRows } = await db.query(
        `INSERT INTO ochr_events (organization_id, title, date)
         SELECT $1, $2, $3::date
          WHERE NOT EXISTS (SELECT 1 FROM ochr_events WHERE organization_id = $1 AND title = $2)
         RETURNING id`, [orgId, `Sunday Mass — ${evDate}`, evDate])
      const evId = evRows[0]?.id ?? (await db.query(
        `SELECT id FROM ochr_events WHERE organization_id = $1 AND title = $2`,
        [orgId, `Sunday Mass — ${evDate}`])).rows[0].id
      const attendees = [...regulars]
      if (weeksAgo >= 5) attendees.push('Rosemary Piper', 'Hank Piper') // present then, absent since
      for (const name of attendees) {
        const mid = memberIds[name]
        if (!mid) continue
        // One regular sits out each old Mass so the trend isn't a flat 100%.
        const status = (weeksAgo > 1 && name === regulars[weeksAgo % regulars.length]) ? 'absent' : 'present'
        await db.query(
          `INSERT INTO ochr_attendance (organization_id, event_id, member_id, status, marked_at)
           VALUES ($1, $2, $3, $4, $5::date + interval '10 hours')
           ON CONFLICT (event_id, member_id) DO NOTHING`,
          [orgId, evId, mid, status, evDate])
      }
    }
    console.log('  ✓ time machine: joins aged, six Sundays of attendance, the Pipers quietly lapsed')
  } finally {
    await db.end()
  }
}

run().catch(err => { console.error(`\nSeed failed: ${err.message}`); process.exit(1) })
