/**
 * Restaurant pacing helpers for @openscaffold/schedule.
 * Typical marketplace per-cover fee is an illustrative estimate only; hosts
 * report $0 per cover. No third-party reservation product is named.
 */

const { evaluateModeCFacilityOrTeeBooking } = require('./modes');
const { matchWaitlistForCanceledSlot } = require('./waitlist');

// Typical per-cover fee charged by third-party reservation marketplaces, used
// only as an illustrative estimate ($1.25, 125 cents). Hosts charge $0 per cover.
const TYPICAL_MARKETPLACE_COVER_FEE_CENTS = 125;

function asIso(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeCoverStatus(status) {
  const value = String(status || 'confirmed').toLowerCase();
  if (value === 'cancelled' || value === 'canceled') return 'canceled';
  if (value === 'no-show' || value === 'no_show') return 'no_show';
  return value;
}

/**
 * 15-minute kitchen cover pacing for a restaurant table.
 * Wraps evaluateModeCFacilityOrTeeBooking with bookingSubtype restaurant_table.
 * The cover fee is $0; typical_marketplace_savings_cents is party size times 125.
 */
function evaluateRestaurantPacingWindow(input = {}) {
  const partySize = Number(input.candidatePartySize ?? input.partySize ?? input.party_size);
  const covers = Number.isFinite(partySize) && partySize > 0 ? partySize : 1;
  const requestedMax = input.maxCoversPer15Min ?? input.max_covers_per_15_min;
  const maxCoversPer15Min = requestedMax == null || requestedMax === '' ? 24 : Number(requestedMax);
  const existing = input.existingReservations || input.existingBookings || [];
  const existingReservations = existing.map((row) => ({
    ...row,
    party_size: Number(row.party_size ?? row.partySize ?? 1) || 1,
    starts_at: asIso(row.starts_at),
    status: normalizeCoverStatus(row.status),
  }));

  const mode = evaluateModeCFacilityOrTeeBooking({
    orgId: input.orgId || input.org_id || 'open-restaurant',
    verticalKey: input.verticalKey || input.vertical_key || 'open-restaurant',
    bookingSubtype: 'restaurant_table',
    candidateStartIso: asIso(input.candidateStartIso || input.starts_at),
    candidateEndIso: asIso(input.candidateEndIso || input.ends_at),
    partySize: covers,
    existingBookings: existingReservations,
    maxCoversPer15Min,
  });
  const pacing = mode.pacing || {};

  return {
    allowed: mode.allowed,
    windowCovers: pacing.windowCovers,
    maxCoversPer15Min: pacing.maxCoversPer15Min,
    remainingCoversInWindow: pacing.remainingCoversInWindow,
    per_cover_fee_cents: 0,
    typical_marketplace_savings_cents: covers * TYPICAL_MARKETPLACE_COVER_FEE_CENTS,
    booking_subtype: 'restaurant_table',
    calendar_mode: 'MODE_C_EVENT_FACILITY_TEE',
    vertical_key: mode.vertical_key,
    org_id: mode.org_id,
    pacing,
  };
}

/**
 * Alias of matchWaitlistForCanceledSlot.
 * Accepts slot.capacity or slot.slot_party_capacity and ranks by priority, then arrival.
 */
function matchWaitlistToCancelledSlot(waitlistEntries = [], canceledSlot = {}) {
  const capacity = Number(
    canceledSlot.capacity ?? canceledSlot.slot_party_capacity ?? canceledSlot.party_size ?? 4,
  );
  const normalized = (waitlistEntries || []).map((entry) => ({
    ...entry,
    status: entry.status === 'cancelled' ? 'canceled' : entry.status,
    party_size: Number(entry.party_size ?? entry.partySize ?? 1) || 1,
    priority_score: Number(entry.priority_score ?? entry.priorityScore ?? 100) || 0,
    created_at: entry.created_at || entry.check_in_time || entry.arrival_time || 0,
    customer_name: entry.customer_name || entry.guest_name,
  }));
  return matchWaitlistForCanceledSlot(normalized, { ...canceledSlot, capacity });
}

/** Private dining / banquet room hold. Defaults to MODE_C banquet_hold. */
function evaluateFacilityEventBooking(input = {}) {
  return evaluateModeCFacilityOrTeeBooking({
    verticalKey: 'open-restaurant',
    ...input,
    bookingSubtype: input.bookingSubtype || input.booking_subtype || 'banquet_hold',
  });
}

module.exports = {
  TYPICAL_MARKETPLACE_COVER_FEE_CENTS,
  evaluateRestaurantPacingWindow,
  matchWaitlistToCancelledSlot,
  evaluateFacilityEventBooking,
};
