// St. Brigid's Episcopal Church — the demo parish (Phase 0 asset base).
//
// WHY THIS IS NOT sampleSeed.js. The signup sample seed is deliberately
// denomination-neutral: "Sunday Service" rather than "Mass", generic
// categories, widely-applicable roles. That is correct for a stranger's
// first login — we don't know what they are yet. It is exactly wrong for a
// demo to a liturgical parish, where the whole pitch is "this was built for
// you and not for a generic church." The two fixtures have opposite jobs,
// so they are separate files and the demo one is never auto-run.
//
// WHAT A RECTOR ACTUALLY CHECKS. Not the row count. They scan the register
// for the things that are wrong in every fake register:
//
//   1. Clergy who sign records outside their tenure. Every entry here is
//      signed by whoever was rector on that date, computed from CLERGY, not
//      chosen at random. A 1961 baptism cannot be signed by the priest who
//      arrived in 1994.
//   2. Names from the wrong decade. The 1940s cohort is Agnes, Cornelius,
//      Eileen; the 1980s cohort is Jennifer, Jason, Heather; the 2010s
//      cohort is Liam, Sophia, Nora. Reading down the date column should
//      feel like reading down a century.
//   3. Lives that don't join up. Margaret Kelleher is baptised in 1952,
//      confirmed in 1965, married in 1974, and her children and grandchild
//      are in the book underneath her. Four generations of one family are
//      traceable — which is the actual reason a parish keeps this book.
//   4. A register with no damage. Real books have gaps: a year-only date
//      from the 1943 volume, a hospital emergency baptism, an unknown
//      minister, a marriage celebrated at another parish. Those entries are
//      here on purpose. A perfect register is a fake register, and the
//      imperfect ones are also what make the digitisation story land.
//
// The parish is fictional. Martinez is a real town near Lafayette (where
// Open Scaffold Labs is), which puts the demo inside the "first ten within
// driving distance" ring in the go-to-market plan.

export const PARISH = {
  name: "St. Brigid's Episcopal Church",
  city: 'Martinez',
  state: 'California',
  founded: 1887,
}

// ── Clergy ───────────────────────────────────────────────────────────
// Tenures are contiguous and non-overlapping, and ministerFor(date) is the
// ONLY way a record gets a signature. The 1994 arrival of a woman rector is
// deliberate and dateable: TEC has ordained women to the priesthood since
// 1976, so a female rector in the mid-90s reads as a real parish history,
// while one in 1955 would read as a fabricated one.
export const CLERGY = [
  { name: 'The Rev. Ambrose Hale',        from: 1936, to: 1971 },
  { name: 'The Rev. Daniel Ruiz',         from: 1971, to: 1994 },
  { name: 'The Rev. Margaret Ellery',     from: 1994, to: 2016 },
  { name: 'The Rev. Canon Peter Osei',    from: 2016, to: 2100 },
]

export function ministerFor(dateStr) {
  const y = Number(String(dateStr).slice(0, 4))
  const c = CLERGY.find(c => y >= c.from && y < c.to)
  return c ? c.name : 'The Rev. Ambrose Hale'
}

const CHURCH = "St. Brigid's Episcopal Church"

// ── The families ─────────────────────────────────────────────────────
// Four generations, so the register can be read as a genealogy rather than
// a list. Ages at each sacrament are canonically plausible: infant baptism
// within a few months of birth, confirmation in the early teens, marriage
// in the twenties.
//
// `people` are register subjects (mostly historical, many now dead).
// `members` further down are the LIVING roster the app manages today.

export const FAMILIES = [
  {
    surname: 'Kelleher',
    people: [
      { key: 'margaret',  name: 'Margaret Anne Kelleher',   born: '1952-03-14' },
      { key: 'cornelius', name: 'Cornelius J. Kelleher',    born: '1921-11-02' },
      { key: 'agnes',     name: 'Agnes Mary Kelleher',      born: '1925-06-30' },
    ],
  },
  {
    surname: 'Doyle',
    people: [
      { key: 'thomas',    name: 'Thomas Edward Doyle',      born: '1949-08-21' },
      { key: 'brendan',   name: 'Brendan Thomas Doyle',     born: '1976-05-09' },
      { key: 'kathleen',  name: 'Kathleen Anne Doyle',      born: '1979-02-17' },
      { key: 'nora',      name: 'Nora Margaret Doyle',      born: '2011-09-04' },
      { key: 'liam',      name: 'Liam Thomas Doyle',        born: '2014-01-22' },
    ],
  },
  {
    surname: 'Okonkwo',
    people: [
      { key: 'chidi',     name: 'Chidi Emmanuel Okonkwo',   born: '1981-07-11' },
      { key: 'adaeze',    name: 'Adaeze Grace Okonkwo',     born: '1984-12-03' },
      { key: 'sophia',    name: 'Sophia Adaeze Okonkwo',    born: '2013-04-18' },
    ],
  },
  {
    surname: 'Whitfield',
    people: [
      { key: 'eileen',    name: 'Eileen Frances Whitfield', born: '1943-01-08' },
      { key: 'robert',    name: 'Robert Alan Whitfield',    born: '1941-09-27' },
      { key: 'jennifer',  name: 'Jennifer Lynn Whitfield',  born: '1968-06-12' },
      { key: 'jason',     name: 'Jason Robert Whitfield',   born: '1971-03-30' },
    ],
  },
  {
    surname: 'Vargas',
    people: [
      { key: 'rosa',      name: 'Rosa María Vargas',        born: '1958-10-05' },
      { key: 'miguel',    name: 'Miguel Ángel Vargas',      born: '1955-04-19' },
      { key: 'elena',     name: 'Elena Vargas Ruiz',        born: '1986-11-26' },
    ],
  },
]

// ── The register ─────────────────────────────────────────────────────
// One row per sacrament celebrated, oldest first, so certificate numbers
// come out in book order. `minister` is omitted deliberately — it is filled
// from ministerFor(date) at build time, which is what keeps tenures honest.
//
// `place` defaults to the church. The exceptions are the interesting ones:
// a hospital emergency baptism, a wedding at the bride's home parish, a
// burial-adjacent anointing at a care home.
//
// `approx: true` marks a record transcribed from a damaged or year-only
// entry in the older books. Those carry a note saying so, which is both
// truthful register practice and the hook for the digitisation feature.

export const REGISTER = [
  // ── The 1940s book: fragile, incomplete, transcribed ──
  { t: 'baptism',        who: 'eileen',   date: '1943-02-14', approx: true,
    note: 'Transcribed from the 1943 volume; day uncertain, entry water-damaged.' },
  { t: 'baptism',        who: 'robert',   date: '1941-10-19',
    godparents: ['Cornelius J. Kelleher', 'Agnes Mary Kelleher'] },
  { t: 'marriage',       who: 'cornelius', spouse: 'agnes', date: '1948-06-05',
    cert: 'M-0031' },

  // ── The 1950s–60s: the parish's post-war generation ──
  { t: 'baptism',        who: 'margaret', date: '1952-05-25',
    godparents: ['Eileen Frances Whitfield', 'Robert Alan Whitfield'] },
  { t: 'baptism',        who: 'miguel',   date: '1955-07-10',
    place: 'Contra Costa County Hospital, Martinez',
    note: 'Emergency baptism at the hospital; conditionally received into the parish 1955-09-11.' },
  { t: 'baptism',        who: 'rosa',     date: '1958-11-30' },
  { t: 'confirmation',   who: 'eileen',   date: '1956-04-22', sponsors: ['Agnes Mary Kelleher'] },
  { t: 'confirmation',   who: 'robert',   date: '1956-04-22', sponsors: ['Cornelius J. Kelleher'] },
  { t: 'first_communion', who: 'margaret', date: '1961-04-02' },
  { t: 'marriage',       who: 'robert',   spouse: 'eileen',  date: '1964-08-15' },
  { t: 'confirmation',   who: 'margaret', date: '1965-05-16', sponsors: ['Eileen Frances Whitfield'] },

  // ── The 1970s: Fr. Ruiz arrives in 1971 ──
  { t: 'baptism',        who: 'jennifer', date: '1968-09-08',
    godparents: ['Margaret Anne Kelleher'] },
  { t: 'baptism',        who: 'jason',    date: '1971-06-13',
    note: 'First baptism celebrated by Fr. Ruiz.' },
  { t: 'marriage',       who: 'thomas',   spouse: 'margaret', date: '1974-09-21' },
  { t: 'baptism',        who: 'brendan',  date: '1976-08-01',
    godparents: ['Robert Alan Whitfield', 'Eileen Frances Whitfield'] },
  { t: 'marriage',       who: 'miguel',   spouse: 'rosa',    date: '1977-05-14',
    place: 'St. Catherine of Siena, Martinez',
    note: "Celebrated at the bride's home parish; recorded here by transfer." },
  { t: 'baptism',        who: 'kathleen', date: '1979-04-29',
    godparents: ['Jennifer Lynn Whitfield'] },

  // ── The 1980s ──
  { t: 'baptism',        who: 'chidi',    date: '1981-10-25' },
  { t: 'confirmation',   who: 'jennifer', date: '1982-05-09', sponsors: ['Margaret Anne Kelleher'] },
  { t: 'baptism',        who: 'adaeze',   date: '1985-03-17' },
  { t: 'confirmation',   who: 'jason',    date: '1985-05-19', sponsors: ['Thomas Edward Doyle'] },
  { t: 'baptism',        who: 'elena',    date: '1987-01-11',
    godparents: ['Rosa María Vargas', 'Miguel Ángel Vargas'] },

  // ── The 1990s: The Rev. Margaret Ellery arrives 1994 ──
  { t: 'confirmation',   who: 'brendan',  date: '1990-04-22', sponsors: ['Robert Alan Whitfield'] },
  { t: 'confirmation',   who: 'kathleen', date: '1993-05-02', sponsors: ['Margaret Anne Kelleher'] },
  { t: 'marriage',       who: 'jennifer', spouse: null, spouseName: 'David Paul Ferreira', date: '1995-06-24' },
  { t: 'confirmation',   who: 'chidi',    date: '1996-04-14', sponsors: ['Thomas Edward Doyle'] },
  { t: 'confirmation',   who: 'adaeze',   date: '1999-05-16' },
  { t: 'anointing',      who: 'cornelius', date: '1999-11-08',
    place: 'Alhambra Care Home, Martinez',
    note: 'Last rites. Died 1999-11-10; buried from this parish 1999-11-15.' },

  // ── The 2000s ──
  { t: 'marriage',       who: 'chidi',    spouse: 'adaeze',  date: '2004-07-17' },
  { t: 'confirmation',   who: 'elena',    date: '2001-05-06', sponsors: ['Rosa María Vargas'] },
  { t: 'marriage',       who: 'brendan',  spouse: null, spouseName: 'Priya Anne Raghavan', date: '2006-09-09' },
  { t: 'anointing',      who: 'agnes',    date: '2008-02-19',
    place: 'Alhambra Care Home, Martinez',
    note: 'Died 2008-02-24; buried from this parish 2008-03-01.' },

  // ── The 2010s: the current generation ──
  { t: 'baptism',        who: 'nora',     date: '2011-11-06',
    godparents: ['Kathleen Anne Doyle', 'Jason Robert Whitfield'] },
  { t: 'baptism',        who: 'sophia',   date: '2013-06-30',
    godparents: ['Elena Vargas Ruiz'] },
  { t: 'baptism',        who: 'liam',     date: '2014-04-20',
    note: 'Baptised at the Great Vigil of Easter.',
    godparents: ['Brendan Thomas Doyle', 'Rosa María Vargas'] },
  { t: 'first_communion', who: 'nora',    date: '2019-05-12' },

  // ── The 2020s: The Rev. Canon Peter Osei ──
  { t: 'first_communion', who: 'sophia',  date: '2021-05-09' },
  { t: 'confirmation',   who: 'nora',     date: '2024-04-14', sponsors: ['Kathleen Anne Doyle'] },
  { t: 'first_communion', who: 'liam',    date: '2022-05-15' },
  { t: 'anointing',      who: 'eileen',   date: '2025-01-19',
    place: 'John Muir Medical Center, Walnut Creek',
    note: 'Anointing before surgery. Recovered; returned to the altar guild in March.' },
]

// ── The living roster ────────────────────────────────────────────────
// Episcopal vocabulary on purpose: Rector, Deacon, Senior/Junior Warden,
// Vestry, Verger, Altar Guild, Organist & Choirmaster, Lay Eucharistic
// Minister. A generic ChMS calls all of these "Member", and a parish
// administrator notices that in the first thirty seconds.
export const MEMBERS = [
  { name: 'The Rev. Canon Peter Osei', role: 'Rector',                      tags: 'clergy, vestry',            joined: '2016-09-01', born: '1972-02-11' },
  { name: 'The Rev. Deacon Ana Solís', role: 'Deacon',                      tags: 'clergy',                    joined: '2019-01-13', born: '1968-07-25' },
  { name: 'Margaret Anne Doyle',       role: 'Senior Warden',               tags: 'vestry, altar guild',       joined: '1952-05-25', born: '1952-03-14' },
  { name: 'Thomas Edward Doyle',       role: 'Junior Warden',               tags: 'vestry',                    joined: '1974-09-21', born: '1949-08-21' },
  { name: 'Kathleen Anne Doyle',       role: 'Altar Guild Director',        tags: 'altar guild, vestry',       joined: '1979-04-29', born: '1979-02-17' },
  { name: 'Brendan Thomas Doyle',      role: 'Treasurer',                   tags: 'vestry, finance',           joined: '1976-08-01', born: '1976-05-09' },
  { name: 'Eileen Frances Whitfield',  role: 'Altar Guild',                 tags: 'altar guild',               joined: '1943-02-14', born: '1943-01-08' },
  { name: 'Robert Alan Whitfield',     role: 'Verger',                      tags: 'liturgy',                   joined: '1941-10-19', born: '1941-09-27' },
  { name: 'Jennifer Lynn Ferreira',    role: 'Organist & Choirmaster',      tags: 'music',                     joined: '1968-09-08', born: '1968-06-12' },
  { name: 'Jason Robert Whitfield',    role: 'Lay Eucharistic Minister',    tags: 'liturgy',                   joined: '1971-06-13', born: '1971-03-30' },
  { name: 'Chidi Emmanuel Okonkwo',    role: 'Vestry',                      tags: 'vestry, outreach',          joined: '1981-10-25', born: '1981-07-11' },
  { name: 'Adaeze Grace Okonkwo',      role: 'Church School Director',      tags: 'formation',                 joined: '1985-03-17', born: '1984-12-03' },
  { name: 'Rosa María Vargas',         role: 'Altar Guild',                 tags: 'altar guild, hospitality',  joined: '1958-11-30', born: '1958-10-05' },
  { name: 'Miguel Ángel Vargas',       role: 'Usher',                       tags: 'hospitality',               joined: '1955-07-10', born: '1955-04-19' },
  { name: 'Elena Vargas Ruiz',         role: 'Lector',                      tags: 'liturgy',                   joined: '1987-01-11', born: '1986-11-26' },
  { name: 'Priya Raghavan Doyle',      role: 'Vestry',                      tags: 'vestry, formation',         joined: '2006-09-09', born: '1980-05-02' },
  { name: 'David Paul Ferreira',       role: 'Choir',                       tags: 'music',                     joined: '1995-06-24', born: '1966-12-14' },
  { name: 'Nora Margaret Doyle',       role: 'Acolyte',                     tags: 'youth, liturgy',            joined: '2011-11-06', born: '2011-09-04' },
  { name: 'Liam Thomas Doyle',         role: 'Acolyte',                     tags: 'youth, liturgy',            joined: '2014-04-20', born: '2014-01-22' },
  { name: 'Sophia Adaeze Okonkwo',     role: 'Church School',               tags: 'youth, formation',          joined: '2013-06-30', born: '2013-04-18' },
  { name: 'Harold M. Beckwith',        role: 'Parish Administrator',        tags: 'staff, office',             joined: '2018-03-05', born: '1961-08-08' },
  { name: 'Constance Achebe',          role: 'Sexton',                      tags: 'staff',                     joined: '2021-06-14', born: '1975-11-19' },
  { name: 'Dorothy Nakamura',          role: 'Flower Guild',                tags: 'altar guild',               joined: '1996-04-21', born: '1948-03-27' },
  { name: 'Samuel Ortega',             role: 'Bell Ringer',                 tags: 'liturgy, youth',            joined: '2022-10-02', born: '2006-01-30' },
]

// ── The week's intentions ────────────────────────────────────────────
// The `†` convention: the app renders a leading `+` as `†`, so entries are
// written the way a parish secretary types them. Mixed statuses on purpose
// — an intention book with everything "fulfilled" demos nothing.
export const INTENTIONS = [
  { offset: 0,  intention: '+ Cornelius J. Kelleher',         by: 'Margaret Anne Doyle',      stipend: 20, status: 'scheduled',
    note: 'Anniversary of death (1999).' },
  { offset: 0,  intention: 'For the people of this parish',   by: 'The Rector',               stipend: null, status: 'scheduled' },
  { offset: 1,  intention: '+ Agnes Mary Kelleher',           by: 'Kathleen Anne Doyle',      stipend: 20, status: 'scheduled' },
  { offset: 2,  intention: 'For the health of Eileen Whitfield', by: 'Robert Alan Whitfield', stipend: 15, status: 'scheduled' },
  { offset: 3,  intention: 'In thanksgiving for 50 years of marriage', by: 'Miguel Ángel Vargas', stipend: 25, status: 'scheduled',
    note: 'Miguel and Rosa, married 1977 at St. Catherine of Siena.' },
  { offset: 4,  intention: 'For the Altar Guild',             by: 'Kathleen Anne Doyle',      stipend: null, status: 'open' },
  { offset: 5,  intention: '+ Fr. Daniel Ruiz',               by: 'Jennifer Lynn Ferreira',   stipend: 20, status: 'open',
    note: 'Rector 1971–1994.' },
  { offset: 6,  intention: 'For those preparing for confirmation', by: 'Adaeze Grace Okonkwo', stipend: null, status: 'open' },
  { offset: -7, intention: '+ Dolores Ortega',                by: 'Samuel Ortega',            stipend: 20, status: 'fulfilled' },
  { offset: -5, intention: 'For rain',                        by: 'The Rector',               stipend: null, status: 'fulfilled',
    note: 'Added at the vestry’s request during the drought advisory.' },
]

// ── The liturgical week ──────────────────────────────────────────────
// A parish's actual rhythm, not "Sunday Service" repeated. Two Sunday
// liturgies with different rites is the detail that tells an Episcopalian
// the tool understands them.
// `serving` is the rota. It matters more than it looks: the Sunday Packet's
// first section is "Serving this day", and a packet that reads "not yet
// assigned" three times is a demo that has just told the parish
// administrator this tool doesn't know who does what. The names are also
// role-correct — the verger and the organist are not interchangeable, and
// the person who notices that is exactly the person we are selling to.
export const WEEKLY = [
  { dow: 0, start: '08:00', end: '09:00', title: 'Holy Eucharist, Rite I',        division: 'Worship', location: 'Church',
    serving: ['Robert Alan Whitfield', 'Elena Vargas Ruiz'] },
  { dow: 0, start: '10:30', end: '11:45', title: 'Choral Eucharist, Rite II',     division: 'Worship', location: 'Church',
    serving: ['Robert Alan Whitfield', 'Jennifer Lynn Ferreira', 'Jason Robert Whitfield', 'Nora Margaret Doyle', 'Liam Thomas Doyle'] },
  { dow: 0, start: '12:00', end: '13:00', title: 'Coffee Hour',                   division: 'Hospitality', location: 'Parish Hall',
    serving: ['Rosa María Vargas', 'Miguel Ángel Vargas'] },
  { dow: 3, start: '12:10', end: '12:50', title: 'Healing Eucharist',             division: 'Worship', location: 'Lady Chapel',
    serving: ['The Rev. Deacon Ana Solís', 'Dorothy Nakamura'] },
  { dow: 3, start: '19:00', end: '20:30', title: 'Choir Rehearsal',               division: 'Music',   location: 'Choir Room',
    serving: ['Jennifer Lynn Ferreira', 'David Paul Ferreira'] },
  { dow: 4, start: '08:30', end: '09:00', title: 'Morning Prayer',                division: 'Worship', location: 'Lady Chapel',
    serving: ['The Rev. Canon Peter Osei'] },
  { dow: 2, start: '19:00', end: '20:30', title: 'Vestry Meeting',                division: 'Governance', location: 'Guild Room',
    serving: ['Margaret Anne Doyle', 'Thomas Edward Doyle', 'Brendan Thomas Doyle'] },
  { dow: 6, start: '09:00', end: '11:00', title: 'Altar Guild — Sunday Setup',    division: 'Altar Guild', location: 'Sacristy',
    serving: ['Kathleen Anne Doyle', 'Eileen Frances Whitfield', 'Dorothy Nakamura'] },
]
