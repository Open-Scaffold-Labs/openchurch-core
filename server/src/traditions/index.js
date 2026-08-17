// The tradition registry (TRAD.1).
//
// One object per tradition. Data, not classes — no inheritance, no
// plugin loader, no feature-flag service. Adding a tradition is adding an
// entry here and a vocabulary block in client/src/i18n/traditions.js.
//
// WHAT BELONGS IN HERE
//
// Only things that are already wired. A registry full of declared-but-
// unread fields is a lie that reads like architecture, so this file
// carries exactly four concerns today:
//
//   lectionary  — which Sunday-designation resolver to use, or null
//   seasons     — what this tradition CALLS the counted-time seasons
//   bodyLabel   — Diocese / Synod, for the organizational layer
//   leadership  — which ochr_clients.role values are parish leadership
//
// ON leadership
//
// Read by the care brief (CARE.2) to decide who may be printed as "clergy
// and key contacts" on a page that leaves the building. It exists here
// because the answer is a vocabulary question and nothing else: the
// founder's three categories are a clergy leader, an ordained assistant,
// and a lay officer, and every tradition has all three under its own
// titles. A Catholic parish's Pastor is an Episcopal parish's Rector; a
// Trustee is a Warden is a Council President.
//
// This is emphatically NOT a claim about orders, authority or who may do
// what — that would be doctrine, which the rule below forbids. It is a
// list of words a parish secretary might type into a role field.
//
// Lowercase, because role is free text and 'Deacon' and 'deacon' are the
// same person. Matching is exact-after-lowercasing rather than substring:
// 'warden' must not quietly match 'Warden's Assistant'.
//
// WHAT MUST NEVER BELONG IN HERE
//
// Doctrine. A profile may say what the software calls things. It must
// never say what a tradition teaches. The AI guardrails depend on that
// line holding: tradition-aware, never doctrine-making.
//
// ON THE SEASON NAMES
//
// The liturgical engine emits a CANONICAL season token ('Ordinary Time')
// that is stored on ochr_calendar_events rows and must not change — those
// rows are already stamped, and re-stamping history to rename a season
// would be a data migration in service of a word. The token is the
// identity of the season (counted time, green); the tradition supplies
// the word. Roman and Lutheran practice both say "Ordinary Time";
// Episcopal and Anglican practice split the same stretch into "Season
// after the Epiphany" and "Season after Pentecost", which is why the
// engine also reports which block a date falls in.

import { resolveLectionary, resolveRomanLectionary } from '../services/lectionary.js'

// Canonical season tokens the engine can emit. Kept here so a tradition
// that renames one cannot silently invent a season that never occurs.
export const CANONICAL_SEASONS = [
  'Advent', 'Christmas', 'Lent', 'Holy Week', 'Easter', 'Pentecost', 'Ordinary Time',
]

export const TRADITIONS = {
  catholic: {
    key: 'catholic',
    label: 'Catholic',
    lectionary: resolveRomanLectionary,
    // Roman practice: one Ordinary Time, in two blocks, both called that.
    seasons: { ordinary_after_epiphany: 'Ordinary Time', ordinary_after_pentecost: 'Ordinary Time' },
    // Founder's baseline (2026-08-17). 'Trustee' is a real lay officer of a
    // Catholic parish corporation, not a borrowed word.
    leadership: ['pastor', 'parochial vicar', 'deacon', 'trustee'],
    bodyLabel: 'Diocese',
  },

  episcopal: {
    key: 'episcopal',
    label: 'Episcopal',
    lectionary: resolveLectionary,          // RCL — Propers after Pentecost
    seasons: { ordinary_after_epiphany: 'Season after the Epiphany', ordinary_after_pentecost: 'Season after Pentecost' },
    // A Rector holds the cure; a Priest-in-Charge or Vicar holds it where
    // the parish is not self-supporting. Wardens and Treasurer are the lay
    // officers — the Trustee slot under Episcopal names.
    leadership: ['rector', 'priest-in-charge', 'vicar', 'deacon',
                 'senior warden', 'junior warden', 'warden', 'treasurer'],
    bodyLabel: 'Diocese',
  },

  anglican: {
    key: 'anglican',
    label: 'Anglican',
    lectionary: resolveLectionary,
    seasons: { ordinary_after_epiphany: 'Season after the Epiphany', ordinary_after_pentecost: 'Season after Pentecost' },
    // Same offices as Episcopal practice, plus the English 'churchwarden'.
    leadership: ['rector', 'priest-in-charge', 'vicar', 'curate', 'deacon',
                 'churchwarden', 'senior warden', 'junior warden', 'warden', 'treasurer'],
    bodyLabel: 'Diocese',
  },

  lutheran: {
    key: 'lutheran',
    label: 'Lutheran',
    // ELCA uses the RCL, and Lutheran practice says "Ordinary Time" — so
    // Lutheran sits ACROSS the two engines we already had. That is itself
    // the evidence that this had to be per-tradition configuration rather
    // than one global answer.
    lectionary: resolveLectionary,
    seasons: { ordinary_after_epiphany: 'Ordinary Time', ordinary_after_pentecost: 'Ordinary Time' },
    // ELCA congregations say Pastor, and the lay officer is the Council
    // President rather than a Warden or Trustee.
    leadership: ['pastor', 'associate pastor', 'deacon',
                 'council president', 'congregation president', 'treasurer'],
    bodyLabel: 'Synod',
  },

  general: {
    key: 'general',
    label: 'General',
    // No lectionary. A congregation whose tradition we have not modelled
    // gets NO Sunday designation rather than another tradition's. This is
    // the whole reason 'general' is a real tier and not a fallback hole.
    lectionary: null,
    seasons: { ordinary_after_epiphany: 'Ordinary Time', ordinary_after_pentecost: 'Ordinary Time' },
    // No tradition named, so the neutral set: the founder's baseline plus
    // the words a non-denominational congregation is likeliest to use. It
    // must stay a real answer, not a fallback hole.
    leadership: ['pastor', 'senior pastor', 'associate pastor', 'minister',
                 'deacon', 'elder', 'trustee', 'treasurer', 'board chair'],
    bodyLabel: 'Denomination',
  },
}

export const DEFAULT_TRADITION = 'general'

export function traditionProfile(key) {
  return TRADITIONS[key] ?? TRADITIONS[DEFAULT_TRADITION]
}

// The role values that count as parish leadership in this tradition, for
// deciding who may appear on a printed care brief. Always a non-empty list:
// an unknown tradition falls back to 'general', whose set is deliberately a
// real answer rather than a hole, because the alternative — an empty list —
// would silently print nobody and read as "this parish has no leadership".
export function leadershipFor(traditionKey) {
  return traditionProfile(traditionKey).leadership
}

// The Sunday designation for a date, in this tradition's vocabulary.
// Returns null where the tradition has no lectionary — callers must render
// nothing rather than fall back to another tradition's resolver.
export function lectionaryFor(traditionKey, dateStr) {
  const resolve = traditionProfile(traditionKey).lectionary
  return resolve ? resolve(dateStr) : null
}
