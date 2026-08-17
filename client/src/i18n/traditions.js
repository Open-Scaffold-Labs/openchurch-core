// Tradition vocabulary overlay (TRAD.1).
//
// The i18n spine was already the seam for this. t() resolves
// `dict[key] ?? STRINGS.en[key] ?? key`; a tradition tier goes on the
// front of that chain and needs no new mechanism at all.
//
// THE OVERLAY IS SPARSE ON PURPOSE.
//
// Of the ~655 keys in strings.js, only the ones below differ by tradition.
// "Save", "Members", "Tasks", every empty state and every error message is
// genuinely universal, and copying 655 keys per tradition would guarantee
// they drift. If a key is not here, every tradition sees the shared string.
//
// A tradition block may be partial in either language — a missing key just
// falls through to the shared table, so adding one Spanish override does
// not oblige anyone to translate the whole set at once.
//
// WHAT DOES NOT GO HERE
//
// Anything doctrinal. This file decides what the software CALLS things.
// It has no opinion on what any tradition teaches, and the AI guardrails
// depend on that separation holding.
//
// 'catholic' is intentionally absent: the shared table in strings.js is
// already Catholic-default ("Mass Intentions", "Sacramental Register",
// "Holy Orders"), which is a historical accident rather than a decision,
// but re-basing 655 keys to neutral wording and then overlaying Catholic
// back on top would be a large diff with no behavioural gain. Catholic
// inherits; the other traditions override. If the base is ever neutralised
// this file is where the Catholic block lands.

export const TRADITION_STRINGS = {
  episcopal: {
    en: {
      // The register and its contents
      'register.title':        'Parish Register',
      'register.sub':          'The parish record of sacraments and rites celebrated.',
      'sac.reconciliation':    'Reconciliation',
      'sac.first_communion':   'First Communion',
      'sac.anointing':         'Unction',
      'sac.holy_orders':       'Ordination',
      // Mass → the Eucharist
      'mi.title':              'Eucharistic Intentions',
      'mi.massDate':           'Service date',
      'mi.assign':             'Assign to a service (optional)',
      'mi.emptyTitle':         'No intentions yet',
      'sheet.title':           'Intentions for the Week',
      'pkt.intentions':        'Intentions for the Week',
      // Clergy
      'mem.role.Pastor':       'Rector',
      // The claim on the login screen
      'login.traditions':      'Serving Episcopal and Anglican parishes',
    },
    es: {
      'register.title':        'Registro Parroquial',
      'register.sub':          'El registro parroquial de los sacramentos y ritos celebrados.',
      'sac.anointing':         'Unción',
      'sac.holy_orders':       'Ordenación',
      'mi.title':              'Intenciones Eucarísticas',
      'mi.massDate':           'Fecha del servicio',
      'mi.emptyTitle':         'Aún no hay intenciones',
      'sheet.title':           'Intenciones de la Semana',
      'pkt.intentions':        'Intenciones de la Semana',
      'mem.role.Pastor':       'Rector',
      'login.traditions':      'Al servicio de parroquias episcopales y anglicanas',
    },
  },

  anglican: {
    en: {
      'register.title':        'Parish Register',
      'register.sub':          'The parish record of sacraments and rites celebrated.',
      'sac.anointing':         'Unction',
      'sac.holy_orders':       'Ordination',
      'mi.title':              'Eucharistic Intentions',
      'mi.massDate':           'Service date',
      'mi.assign':             'Assign to a service (optional)',
      'mi.emptyTitle':         'No intentions yet',
      'sheet.title':           'Intentions for the Week',
      'pkt.intentions':        'Intentions for the Week',
      'mem.role.Pastor':       'Rector',
      'login.traditions':      'Serving Anglican and Episcopal parishes',
    },
    es: {
      'register.title':        'Registro Parroquial',
      'mi.title':              'Intenciones Eucarísticas',
      'mem.role.Pastor':       'Rector',
      'login.traditions':      'Al servicio de parroquias anglicanas y episcopales',
    },
  },

  lutheran: {
    en: {
      // A Lutheran body is a congregation, and the word matters to them
      // in a way "parish" does not.
      'register.title':        'Congregational Register',
      'register.sub':          'The congregation’s record of sacraments and rites celebrated.',
      'sac.reconciliation':    'Confession and Forgiveness',
      'sac.first_communion':   'First Communion',
      'sac.anointing':         'Anointing of the Sick',
      'sac.holy_orders':       'Ordination',
      'mi.title':              'Worship Intentions',
      'mi.massDate':           'Service date',
      'mi.assign':             'Assign to a service (optional)',
      'mi.emptyTitle':         'No intentions yet',
      'sheet.title':           'Intentions for the Week',
      'pkt.intentions':        'Intentions for the Week',
      'login.traditions':      'Serving Lutheran congregations',
    },
    es: {
      'register.title':        'Registro Congregacional',
      'mi.title':              'Intenciones del Culto',
      'login.traditions':      'Al servicio de congregaciones luteranas',
    },
  },

  general: {
    en: {
      // Neutral, not Catholic-by-default. An org that has not told us its
      // tradition should not be shown another one's vocabulary.
      'register.title':        'Church Register',
      'register.sub':          'The church’s record of sacraments and rites celebrated.',
      'sac.reconciliation':    'Reconciliation',
      'sac.anointing':         'Anointing',
      'sac.holy_orders':       'Ordination',
      'mi.title':              'Service Intentions',
      'mi.massDate':           'Service date',
      'mi.assign':             'Assign to a service (optional)',
      'mi.emptyTitle':         'No intentions yet',
      'sheet.title':           'Intentions for the Week',
      'pkt.intentions':        'Intentions for the Week',
      'login.traditions':      'Church operations, kept well',
    },
    es: {
      'register.title':        'Registro de la Iglesia',
      'mi.title':              'Intenciones del Servicio',
      'login.traditions':      'Las operaciones de la iglesia, bien llevadas',
    },
  },
}

// Season display names. The server emits a canonical token ('Ordinary
// Time') plus which block of counted time a date falls in; the tradition
// supplies the word. Roman and Lutheran practice call both blocks Ordinary
// Time; Episcopal and Anglican practice name them separately.
// Values are i18n KEYS, not literals, so an Episcopal parish working in
// Spanish still reads «Tiempo después de Pentecostés».
export const TRADITION_SEASONS = {
  episcopal: { after_epiphany: 'lit.afterEpiphany', after_pentecost: 'lit.afterPentecost' },
  anglican:  { after_epiphany: 'lit.afterEpiphany', after_pentecost: 'lit.afterPentecost' },
}
