/**
 * @openscaffold/scheduling — Conflict-Free Multi-Resource Slot Engine,
 * Golf Tee Sheet Foursome Auto-Pairing, Dental/Salon Split-Segment Allocator,
 * and Restaurant Pacing Cap Evaluator.
 */

function rangesOverlap(startA, endA, startB, endB) {
  const a0 = new Date(startA).getTime();
  const a1 = new Date(endA).getTime();
  const b0 = new Date(startB).getTime();
  const b1 = new Date(endB).getTime();
  // Half-open interval [start, end)
  return a0 < b1 && b0 < a1;
}

/**
 * Checks whether a candidate set of resource segment allocations conflicts with existing allocations.
 * Supports:
 *  - Exclusive resources (capacity = 1, e.g., dental chair, massage room, restaurant table)
 *  - Shared capacity resources (capacity = 4 for golf tee times, capacity = N for fitness classes)
 *  - Split segments with processing gaps (e.g., Salon color: 0-30m stylists, 30-75m gap free, 75-120m finish)
 */
function detectAllocationConflicts(existingAllocations = [], candidateAllocations = [], resourceCapacityMap = {}) {
  const conflicts = [];

  for (const cand of candidateAllocations) {
    const cap = resourceCapacityMap[cand.resource_id] || 1;
    let overlappingUsed = cand.slots_used || 1;

    for (const ex of existingAllocations) {
      if (ex.resource_id !== cand.resource_id) continue;
      if (rangesOverlap(cand.starts_at, cand.ends_at, ex.starts_at, ex.ends_at)) {
        overlappingUsed += ex.slots_used || 1;
        if (overlappingUsed > cap) {
          conflicts.push({
            resource_id: cand.resource_id,
            candidate_segment: cand.segment_label || 'primary',
            conflicting_booking_id: ex.booking_id,
            capacity: cap,
            requested_total: overlappingUsed,
          });
        }
      }
    }
  }

  return {
    hasConflict: conflicts.length > 0,
    conflicts,
  };
}

/**
 * Builds multi-segment allocations for Dental (Chair + Hygienist + Doctor exam split)
 * or Salon (Stylist apply + processing gap + Stylist finish).
 */
function buildSplitAppointmentAllocations({
  orgId,
  bookingId,
  baseStartIso,
  segments = [],
}) {
  const baseMs = new Date(baseStartIso).getTime();
  const minMs = 60 * 1000;

  return segments.map(seg => {
    const startIso = new Date(baseMs + (seg.offset_minutes || 0) * minMs).toISOString();
    const endIso = new Date(baseMs + ((seg.offset_minutes || 0) + seg.duration_minutes) * minMs).toISOString();
    return {
      org_id: orgId,
      booking_id: bookingId,
      resource_id: seg.resource_id,
      segment_label: seg.label || 'primary',
      starts_at: startIso,
      ends_at: endIso,
      slot_range: `[${startIso},${endIso})`,
      slots_used: seg.slots_used || 1,
      active_exclusive: seg.active_exclusive !== false,
    };
  });
}

/**
 * Golf Tee Sheet Generator & Foursome Auto-Pairer (`7–10 min` intervals, capacity = 4 players per tee slot)
 */
function generateTeeSheet({
  courseResourceId,
  dateStr,
  firstTeeTimeMinutes = 6 * 60 + 30, // 06:30 AM
  lastTeeTimeMinutes = 17 * 60 + 30,  // 05:30 PM
  intervalMinutes = 8,                // 8-minute intervals
  maxPlayersPerSlot = 4,
  existingBookings = [],
}) {
  const slots = [];
  for (let m = firstTeeTimeMinutes; m <= lastTeeTimeMinutes; m += intervalMinutes) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const slotKey = `${dateStr}T${hh}:${mm}:00Z`;
    const matched = existingBookings.filter(b => b.slot_key === slotKey);
    const bookedPlayers = matched.reduce((sum, b) => sum + (b.party_size || 1), 0);

    slots.push({
      resource_id: courseResourceId,
      slot_key: slotKey,
      time_label: `${hh}:${mm}`,
      capacity: maxPlayersPerSlot,
      booked_players: bookedPlayers,
      open_spots: Math.max(0, maxPlayersPerSlot - bookedPlayers),
      pairings: matched.map(b => ({ booking_id: b.id, customer_name: b.customer_name, party_size: b.party_size })),
    });
  }
  return slots;
}

function pairGolferIntoTeeSheet(teeSheetSlots, partySize) {
  if (partySize < 1 || partySize > 4) {
    throw new Error(`Invalid golf party size: ${partySize} (must be 1..4)`);
  }
  // Prefer pairing into a partially filled slot first to maximize foursome utilization, then empty slots
  const partialFit = teeSheetSlots.find(s => s.booked_players > 0 && s.open_spots >= partySize);
  if (partialFit) {
    return { paired: true, strategy: 'foursome_auto_pair', slot: partialFit };
  }
  const emptyFit = teeSheetSlots.find(s => s.booked_players === 0 && s.open_spots >= partySize);
  if (emptyFit) {
    return { paired: true, strategy: 'new_tee_slot', slot: emptyFit };
  }
  return { paired: false, strategy: 'waitlist_required', slot: null };
}

/**
 * Restaurant Kitchen Pacing Cap Evaluator (prevents seating 40 covers in a single 15-min window)
 */
function evaluateKitchenPacing({
  existingReservations = [],
  candidateStartIso,
  candidatePartySize,
  maxCoversPer15Min = 24,
}) {
  const candMs = new Date(candidateStartIso).getTime();
  const windowMs = 15 * 60 * 1000;
  let windowCovers = candidatePartySize;

  for (const res of existingReservations) {
    if (res.status === 'canceled' || res.status === 'no_show') continue;
    const rMs = new Date(res.starts_at).getTime();
    if (Math.abs(rMs - candMs) < windowMs) {
      windowCovers += res.party_size || 1;
    }
  }

  return {
    allowed: windowCovers <= maxCoversPer15Min,
    windowCovers,
    maxCoversPer15Min,
    remainingCoversInWindow: Math.max(0, maxCoversPer15Min - (windowCovers - candidatePartySize)),
  };
}

module.exports = {
  rangesOverlap,
  detectAllocationConflicts,
  buildSplitAppointmentAllocations,
  generateTeeSheet,
  pairGolferIntoTeeSheet,
  evaluateKitchenPacing,
};
