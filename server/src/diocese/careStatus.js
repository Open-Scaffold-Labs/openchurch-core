// Care status (CARE.1) — derived, explained, never stored.
//
// THE RULE THIS FILE EXISTS TO KEEP
//
// "Status is an invitation to human judgment, never an automated verdict."
//
// So a parish's care status is computed at read time from things a human
// actually did — a report was prepared, a parish asked for help, a
// follow-up was agreed — and every status arrives WITH the sentence that
// produced it. There is no score, no ranking, no hidden weighting, and
// nothing is written to a parish's record as a conclusion about them.
//
// If this file ever grows a number that is not a count of real things, or
// a comparison between parishes, it has become the thing the brief forbids.
//
// THE FOUR STATES, AND WHY THESE WORDS
//
//   ready           Required work is current or intentionally scheduled.
//   review_together A report or record deserves a shared check-in.
//   offer_support   A parish asked for help, or an exception needs context.
//   awaiting_update A gentle cue for a kind check-in.
//
// None of them is a judgement about the parish. "Awaiting update" is a
// statement about what the DIOCESE is waiting for, not about what the
// parish failed to do — which is why it is not "late", "overdue",
// "delinquent", "non-compliant", "at risk" or "failing". A parish whose
// secretary is in hospital and a parish that forgot are in the same state
// here on purpose, because the software cannot tell them apart and should
// not pretend to.

export const CARE_STATES = {
  ready: {
    key: 'ready',
    label: 'Ready',
    meaning: 'Required work is current or intentionally scheduled.',
    tone: 'muted-green',
  },
  review_together: {
    key: 'review_together',
    label: 'Review together',
    meaning: 'A report or record deserves a shared check-in.',
    tone: 'brass',
  },
  offer_support: {
    key: 'offer_support',
    label: 'Offer support',
    meaning: 'A parish has asked for help, or an exception needs human context.',
    tone: 'burgundy',
  },
  awaiting_update: {
    key: 'awaiting_update',
    label: 'Awaiting update',
    meaning: 'A gentle cue for a kind check-in.',
    tone: 'stone',
  },
}

// Ordered by which human next step is most concrete, NOT by severity.
// A parish that asked for help comes first because somebody is waiting on
// an answer — not because it is "worse off" than the others.
const PRECEDENCE = ['offer_support', 'review_together', 'awaiting_update', 'ready']

// How long before "we have not heard from them lately" becomes worth a
// kind check-in. Deliberately generous, and deliberately one number in one
// place a diocese can later set for itself. It is not a deadline: nothing
// happens when it passes except that a person is invited to make contact.
export const QUIET_PERIOD_DAYS = 100

// signals: {
//   openSupportRequests: int,     — the parish asked
//   submissionsAwaitingReview: int,
//   daysSinceLastContact: int|null,
//   openFollowUps: int,
//   activeTransitions: int,
// }
//
// Returns { state, label, meaning, because } — `because` is the sentence a
// diocesan staff member would say out loud, and it is required. A status
// without its reason is a verdict, and this file does not produce verdicts.
export function careStatusFor(signals) {
  const s = {
    openSupportRequests: 0,
    submissionsAwaitingReview: 0,
    daysSinceLastContact: null,
    openFollowUps: 0,
    activeTransitions: 0,
    ...signals,
  }

  const candidates = []

  // These are tickets the parish opened with OPENCHURCH, not requests it made
  // of its diocese. The old wording — "The parish has asked for help" — told a
  // chancery it had been approached when it had not been, which is a false
  // statement about a relationship, and the likeliest response to it is a call
  // the parish never asked for. Say what is actually known: they are having
  // trouble with the software, which is still a reason to check in.
  if (s.openSupportRequests > 0) {
    candidates.push({
      state: 'offer_support',
      because: s.openSupportRequests === 1
        ? 'The parish has an open support request with OpenChurch — they may be having trouble with the software.'
        : `The parish has ${s.openSupportRequests} open support requests with OpenChurch — they may be having trouble with the software.`,
    })
  }

  // A transition is a moment to accompany a parish, not a risk to flag.
  if (s.activeTransitions > 0) {
    candidates.push({
      state: 'offer_support',
      because: 'The parish is in a transition — this is usually a good moment to offer help rather than wait to be asked.',
    })
  }

  if (s.submissionsAwaitingReview > 0) {
    candidates.push({
      state: 'review_together',
      because: s.submissionsAwaitingReview === 1
        ? 'A report is prepared and waiting for a shared review.'
        : `${s.submissionsAwaitingReview} reports are prepared and waiting for a shared review.`,
    })
  }

  if (s.daysSinceLastContact != null && s.daysSinceLastContact >= QUIET_PERIOD_DAYS) {
    candidates.push({
      state: 'awaiting_update',
      because: `It has been about ${Math.round(s.daysSinceLastContact / 30)} months since anything was recorded with this parish. That may be entirely fine — it is only a cue to check in.`,
    })
  }

  if (s.daysSinceLastContact == null) {
    candidates.push({
      state: 'awaiting_update',
      because: 'Nothing has been recorded with this parish yet. A first conversation is the next step.',
    })
  }

  if (!candidates.length) {
    candidates.push({
      state: 'ready',
      because: s.openFollowUps > 0
        ? 'Nothing is outstanding from the parish; the office has its own follow-up in hand.'
        : 'Nothing is outstanding on either side.',
    })
  }

  const winner = PRECEDENCE
    .map(state => candidates.find(c => c.state === state))
    .find(Boolean)

  return {
    ...CARE_STATES[winner.state],
    because: winner.because,
    // Every reason the parish appeared, not only the winning one — so a
    // staff member sees the whole picture rather than the headline.
    also: candidates.filter(c => c !== winner).map(c => c.because),
  }
}
