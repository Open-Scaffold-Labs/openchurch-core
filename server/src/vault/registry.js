// What the Continuity Vault protects, and what it deliberately does not.
//
// The list is explicit rather than "every table", because a promise that
// covers everything covers nothing you can test. Each entry here is a
// deletion a parish administrator can perform in one click today, whose
// loss is institutional memory rather than a preference.
//
// Not here, on purpose:
//
//   ochr_sacramental_records — the register is never deleted at all. It
//     is voided by dated amendment (migration 073, sacraments.js). A
//     recycle bin for the register would be a worse promise than the one
//     already kept.
//
//   ochr_push_subscriptions, ochr_scheduled_notifications — devices and
//     queues. Re-subscribable, transient; recovering them is noise.
//
//   ochr_audit_log — history, not content. It is pruned by an explicit
//     policy (services/retention.js), which is the opposite of this file.
//
//   anything OpenDiocese owns — assessments, care timelines, follow-ups.
//     The chancery's records are not the parish's to recover, and the
//     vault is tenant-scoped precisely so the two never meet.

// Long enough that a parish's annual audit or a once-a-year volunteer
// handover still finds the mistake; short enough to be a real, stated
// window rather than "forever", which nothing has proved.
export const RETENTION_DAYS = 400

// Refuse rather than under-capture. If a single delete would drag more
// rows than this into the snapshot, the honest answer is that this is not
// a delete, it is a migration, and it belongs in the runbook with a human
// watching — not in a recycle bin that quietly truncated itself.
export const MAX_CAPTURED_ROWS = 5000

// A DATE column arrives from node-pg as a JS Date, and String(new Date())
// is "Tue Sep 01 2026 …" — so the .slice(0, 10) these labels have always
// done was cutting a weekday out of an English date string, not a day out
// of an ISO one. Every gift and bulletin already in the vault is labelled
// "Tue Sep 01". Nobody noticed because nobody reads a recycle bin until
// the day they need it.
const day = v => {
  if (v == null) return null
  return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10)
}

// "3 members · Ana Ruiz, Consuelo Ibáñez, José Ramírez" for a small set;
// "412 members · Ana Ruiz, Consuelo Ibáñez, José Ramírez and 409 more" for a
// real import. Names first because an administrator deciding whether to
// restore is looking for a name she recognises, and a bare count tells her
// nothing.
const groupOf = (rows, noun, name) => {
  const shown = rows.slice(0, 3).map(name).filter(Boolean)
  const rest  = rows.length - shown.length
  const tail  = rest > 0 ? ` and ${rest} more` : ''
  return `${rows.length} ${noun}${shown.length ? ` · ${shown.join(', ')}${tail}` : ''}`
}

export const PROTECTED = {
  // groupLabel arrived here with import undo. Undoing an import is ONE act
  // — a person clicks it once, about a file, not about a person — so it
  // writes one entry holding every record the import created, and putting it
  // back is one click. The alternative shipped first and was wrong: an entry
  // per record meant undoing a four-hundred-row import created four hundred
  // vault entries, and reversing that undo meant four hundred clicks, every
  // one of which had to succeed. The names are in the label so an
  // administrator can still see what is inside before restoring it.
  member: {
    table: 'ochr_clients',
    noun:  'member',
    label: r => r.name || `Member #${r.id}`,
    groupLabel: rows => groupOf(rows, 'members', r => r.name || `Member #${r.id}`),
  },
  donation: {
    table: 'ochr_donations',
    noun:  'gift',
    label: r => [r.donor_name, r.amount != null ? `$${r.amount}` : null, day(r.date)]
      .filter(Boolean).join(' · ') || `Gift #${r.id}`,
    groupLabel: rows => {
      const days = rows.map(r => day(r.date)).filter(Boolean).sort()
      const span = days.length ? ` · ${days[0]} to ${days[days.length - 1]}` : ''
      return `${rows.length} gifts${span}`
    },
  },
  fund: {
    table: 'ochr_funds',
    noun:  'fund',
    label: r => r.name || `Fund #${r.id}`,
    groupLabel: rows => groupOf(rows, 'funds', r => r.name || `Fund #${r.id}`),
  },
  group: {
    table: 'ochr_groups',
    noun:  'group',
    label: r => r.name || `Group #${r.id}`,
  },
  bulletin: {
    table: 'ochr_bulletins',
    noun:  'bulletin',
    label: r => [r.title, day(r.date)].filter(Boolean).join(' · ') || `Bulletin #${r.id}`,
  },
  form: {
    table: 'ochr_forms',
    noun:  'form',
    label: r => r.title || r.slug || `Form #${r.id}`,
  },
  // Calendar events waited for multi-root capture, and this is why.
  // The calendar's DELETE takes ?scope=series and removes a whole
  // recurring series in one statement — twenty-six sibling rows, none of
  // them the parent of the others. Protecting only the single-occurrence
  // path would have meant "your event is recoverable, unless you deleted
  // the series", which is worse than no promise. So the entry holds
  // every occurrence, and `groupLabel` says how many, because "Choir
  // practice" alone does not tell an administrator whether she is about
  // to get one Tuesday back or the whole autumn.
  event: {
    table: 'ochr_calendar_events',
    noun:  'event',
    label: r => [r.title, day(r.date)].filter(Boolean).join(' · ') || `Event #${r.id}`,
    groupLabel: rows => {
      const days = rows.map(r => day(r.date)).filter(Boolean).sort()
      const span = days.length ? ` · ${days[0]} to ${days[days.length - 1]}` : ''
      return `${rows[0].title || 'Event'} · ${rows.length} occurrences${span}`
    },
    // Said out loud on the entry, because it is the one thing a restore
    // does not put back. Reminders live in the notification queue, which
    // the vault deliberately does not hold (see above) — a queue row
    // restored days later would fire an alert about a meeting that
    // already happened.
    caveat: 'Reminders are not restored with an event. Anyone who was notified before will need notifying again.',
  },
}

export const KIND_FOR_TABLE = Object.fromEntries(
  Object.entries(PROTECTED).map(([kind, spec]) => [spec.table, kind])
)
