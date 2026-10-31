/**
 * @openscaffold/schedule — All 4 Vertical Calendar Modes in One Shared Engine
 *
 *  - Mode A (`MODE_A_APPOINTMENT_CHAIR`): OpenSalon, OpenDentist, OpenChiropractor, OpenCPA, OpenLawFirm
 *  - Mode B (`MODE_B_CREW_WEATHER_ROUTE`): OpenLandscapeBusiness, OpenLandscapeArchitect, OpenPropertyDeveloper
 *  - Mode C (`MODE_C_EVENT_FACILITY_TEE`): OpenCaterer, OpenGolfCourseOS, OpenChurch, OpenHOA, OpenRestaurant
 *  - Mode D (`MODE_D_SHIFT_ROSTER`): OpenFirehouse (24/48 & 48/96 Kelly shifts), OpenRestaurant/Caterer FOH/BOH, OpenSalon Booth Rosters
 */

const { rangesOverlap, generateTeeSheet, pairGolferIntoTeeSheet, evaluateKitchenPacing } = require('./slots');
const { rescheduleCascade } = require('./shifts');

const CALENDAR_MODES = Object.freeze({
  MODE_A_APPOINTMENT_CHAIR: {
    mode: 'MODE_A_APPOINTMENT_CHAIR',
    verticals: ['open-salon', 'open-dentist', 'open-chiropractor', 'open-cpa', 'open-law-firm'],
    features: [
      'Split-time processing gap squeeze-in (OpenSalon hs_stylist_busy_ranges)',
      'Dental hygienist (40m) + doctor exam (15m) multi-resource operatory overlap',
      'Automated 6-week root touch-up & 6-month dental hygiene recall rebooking',
      'Waitlist auto-fill & no-show deposit holds',
      'Grok Bot 0.77 AI-caller fast path & /.well-known/agent-booking.json',
    ],
  },
  MODE_B_CREW_WEATHER_ROUTE: {
    mode: 'MODE_B_CREW_WEATHER_ROUTE',
    verticals: ['open-landscape-business', 'open-landscape-architect', 'open-property-developer'],
    features: [
      'Multi-day project blocks & site-visit -> material-delivery -> crew-install phases',
      'Crew + truck + heavy equipment bundle allocation',
      '1-click rain-out / frost cascade rescheduling (skipping Sundays) with SMS/email preview',
    ],
  },
  MODE_C_EVENT_FACILITY_TEE: {
    mode: 'MODE_C_EVENT_FACILITY_TEE',
    verticals: ['open-caterer', 'open-golf', 'open-church', 'open-hoa', 'open-restaurant'],
    features: [
      'Integrates cleanly with @openscaffold/catering BEO & venue space holds (osc_cat_events)',
      '7-10m Golf Tee Sheet intervals, foursome auto-pairing & 18-hole shotgun blocks',
      '15-minute Restaurant kitchen pacing cap with $0 per-cover commission fee',
      'Parish hall, sanctuary, and HOA clubhouse/pickleball amenity holds',
    ],
  },
  MODE_D_SHIFT_ROSTER: {
    mode: 'MODE_D_SHIFT_ROSTER',
    verticals: ['open-firehouse', 'open-restaurant', 'open-caterer', 'open-salon'],
    features: [
      '24/48 and 48/96 Firehouse Kelly shift rotations with minimum apparatus staffing enforcement',
      'FOH/BOH server, bartender, and banquet captain shift call sheets',
      'OpenSalon commission vs. booth-rental chair/station weekly rosters',
    ],
  },
});

/**
 * Mode A1: JavaScript twin of OpenSalon's `hs_stylist_busy_ranges` SQL function (`004_hs_split_time.sql`).
 * Given an appointment `[startsAtIso, endsAtIso)` with `appliedMinutes`, `processingMinutes`,
 * `bufferBeforeMinutes`, and `bufferAfterMinutes`, returns the exact `[start, end)` busy windows
 * where the stylist/provider is occupied, plus the open processing gap window (if `processingMinutes > 0`).
 */
function computeStylistBusyRanges({
  startsAtIso,
  endsAtIso,
  appliedMinutes = 0,
  processingMinutes = 0,
  bufferBeforeMinutes = 0,
  bufferAfterMinutes = 0,
}) {
  const startMs = new Date(startsAtIso).getTime();
  const endMs = new Date(endsAtIso).getTime();
  const minMs = 60 * 1000;
  const totalDurationMinutes = Math.round((endMs - startMs) / minMs);

  if (appliedMinutes + processingMinutes > totalDurationMinutes) {
    throw new Error(
      `Invalid split-time service: appliedMinutes (${appliedMinutes}) + processingMinutes (${processingMinutes}) exceeds duration (${totalDurationMinutes})`
    );
  }

  if (processingMinutes > 0) {
    const busy1Start = new Date(startMs - bufferBeforeMinutes * minMs).toISOString();
    const busy1End = new Date(startMs + appliedMinutes * minMs).toISOString();
    const gapStart = busy1End;
    const gapEnd = new Date(startMs + (appliedMinutes + processingMinutes) * minMs).toISOString();
    const busy2Start = gapEnd;
    const busy2End = new Date(endMs + bufferAfterMinutes * minMs).toISOString();

    return {
      isSplitTime: true,
      busyRanges: [
        { phase: 'application_with_setup', starts_at: busy1Start, ends_at: busy1End },
        { phase: 'finishing_with_cleanup', starts_at: busy2Start, ends_at: busy2End },
      ],
      processingGap: {
        phase: 'processing_gap',
        starts_at: gapStart,
        ends_at: gapEnd,
        duration_minutes: processingMinutes,
        allow_double_book_in_gap: true,
      },
    };
  }

  return {
    isSplitTime: false,
    busyRanges: [
      {
        phase: 'contiguous_busy',
        starts_at: new Date(startMs - bufferBeforeMinutes * minMs).toISOString(),
        ends_at: new Date(endMs + bufferAfterMinutes * minMs).toISOString(),
      },
    ],
    processingGap: null,
  };
}

/**
 * Mode A2: OpenSalon Split-Time Availability & Squeeze-In Finder (`server/src/lib/availability.js` pattern).
 * Scans a stylist/provider's working window on a fixed grid (`slotStepMinutes`) and finds all start times
 * where a candidate service (`durationMinutes`, optionally split itself) fits without overlapping any
 * busy range — including automatically discovering "squeeze-in" slots inside another client's color processing gap!
 */
function findSplitTimeSqueezeInSlots({
  stylistId,
  stylistName = 'Stylist',
  windowStartIso,
  windowEndIso,
  durationMinutes = 45,
  slotStepMinutes = 15,
  candidateAppliedMinutes = 0,
  candidateProcessingMinutes = 0,
  candidateBufferBeforeMinutes = 0,
  candidateBufferAfterMinutes = 0,
  existingAppointments = [],
}) {
  const winStartMs = new Date(windowStartIso).getTime();
  const winEndMs = new Date(windowEndIso).getTime();
  const minMs = 60 * 1000;

  const existingBusy = [];
  const processingGaps = [];

  for (const appt of existingAppointments) {
    if (appt.status === 'canceled' || appt.status === 'cancelled' || appt.status === 'no_show') continue;
    if (appt.stylist_id && String(appt.stylist_id) !== String(stylistId)) continue;
    const computed = computeStylistBusyRanges({
      startsAtIso: appt.starts_at,
      endsAtIso: appt.ends_at,
      appliedMinutes: appt.applied_minutes || 0,
      processingMinutes: appt.processing_minutes || 0,
      bufferBeforeMinutes: appt.buffer_before_minutes || 0,
      bufferAfterMinutes: appt.buffer_after_minutes || 0,
    });
    existingBusy.push(...computed.busyRanges);
    if (computed.processingGap) {
      processingGaps.push({ ...computed.processingGap, parent_appointment_id: appt.id });
    }
  }

  const candidateStartsSet = new Set();
  for (
    let slotStartMs = winStartMs;
    slotStartMs + durationMinutes * minMs <= winEndMs;
    slotStartMs += slotStepMinutes * minMs
  ) {
    candidateStartsSet.add(slotStartMs);
  }
  for (const g of processingGaps) {
    const gapStartMs = new Date(g.starts_at).getTime();
    if (gapStartMs >= winStartMs && gapStartMs + durationMinutes * minMs <= winEndMs) {
      candidateStartsSet.add(gapStartMs);
    }
  }
  const sortedStarts = Array.from(candidateStartsSet).sort((a, b) => a - b);
  const openSlots = [];
  for (const slotStartMs of sortedStarts) {
    const slotStartIso = new Date(slotStartMs).toISOString();
    const slotEndIso = new Date(slotStartMs + durationMinutes * minMs).toISOString();

    const candBusy = computeStylistBusyRanges({
      startsAtIso: slotStartIso,
      endsAtIso: slotEndIso,
      appliedMinutes: candidateAppliedMinutes,
      processingMinutes: candidateProcessingMinutes,
      bufferBeforeMinutes: candidateBufferBeforeMinutes,
      bufferAfterMinutes: candidateBufferAfterMinutes,
    }).busyRanges;

    let collides = false;
    for (const cb of candBusy) {
      for (const eb of existingBusy) {
        if (rangesOverlap(cb.starts_at, cb.ends_at, eb.starts_at, eb.ends_at)) {
          collides = true;
          break;
        }
      }
      if (collides) break;
    }

    if (!collides) {
      const fitsInsideProcessingGap = processingGaps.some(
        (g) =>
          new Date(slotStartIso).getTime() >= new Date(g.starts_at).getTime() &&
          new Date(slotEndIso).getTime() <= new Date(g.ends_at).getTime()
      );
      openSlots.push({
        stylist_id: stylistId,
        stylist_name: stylistName,
        starts_at: slotStartIso,
        ends_at: slotEndIso,
        duration_minutes: durationMinutes,
        allow_overlap: fitsInsideProcessingGap,
        squeeze_in_processing_gap: fitsInsideProcessingGap,
      });
    }
  }

  return openSlots;
}

/**
 * Mode A3: OpenDentist Multi-Resource Operatory + Hygienist (40m) + Doctor Exam (15m) Overlap Builder.
 * Locks the dental operatory chair for the full 55m while locking the hygienist for [0..40m) and
 * the dentist only for [40..55m), allowing the dentist to examine 3–4 hygiene chairs per hour without conflict.
 */
function buildDentalHygienistDoctorOverlap({
  orgId,
  bookingId,
  operatoryResourceId,
  hygienistResourceId,
  doctorResourceId,
  startsAtIso,
  hygienistMinutes = 40,
  doctorExamMinutes = 15,
}) {
  const startMs = new Date(startsAtIso).getTime();
  const minMs = 60 * 1000;
  const totalMinutes = hygienistMinutes + doctorExamMinutes;
  const handoffIso = new Date(startMs + hygienistMinutes * minMs).toISOString();
  const endIso = new Date(startMs + totalMinutes * minMs).toISOString();

  return {
    org_id: orgId,
    booking_id: bookingId,
    calendar_mode: 'MODE_A_APPOINTMENT_CHAIR',
    starts_at: startsAtIso,
    ends_at: endIso,
    total_duration_minutes: totalMinutes,
    allocations: [
      {
        org_id: orgId,
        booking_id: bookingId,
        resource_id: operatoryResourceId,
        segment_label: 'operatory_full_visit',
        starts_at: startsAtIso,
        ends_at: endIso,
        active_exclusive: true,
      },
      {
        org_id: orgId,
        booking_id: bookingId,
        resource_id: hygienistResourceId,
        segment_label: 'hygienist_cleaning_and_xrays',
        starts_at: startsAtIso,
        ends_at: handoffIso,
        active_exclusive: true,
      },
      {
        org_id: orgId,
        booking_id: bookingId,
        resource_id: doctorResourceId,
        segment_label: 'doctor_periodic_exam',
        starts_at: handoffIso,
        ends_at: endIso,
        active_exclusive: true,
      },
    ],
  };
}

/**
 * Mode A4: Automated Recall / Rebooking Date Calculator (6-week Salon root touch-up or 6-month Dental hygiene recall).
 */
function computeRecallRebookingWindow({ completedAtIso, verticalKey = 'open-salon', customWeeks = null }) {
  const baseMs = new Date(completedAtIso).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const weeks = customWeeks || (verticalKey === 'open-dentist' ? 26 : 6);
  const targetDateIso = new Date(baseMs + weeks * 7 * dayMs).toISOString().slice(0, 10);
  return {
    vertical_key: verticalKey,
    recall_weeks: weeks,
    recommended_date: targetDateIso,
    recall_reason: verticalKey === 'open-dentist' ? '6-Month Hygiene & Periodic Exam Recall' : '6-Week Color & Root Touch-Up Rebook',
  };
}

/**
 * Mode B: Crew, Route & Weather-Shift Dispatch Mode (`OpenLandscapeBusiness`, `OpenLandscapeArchitect`, `OpenPropertyDeveloper`)
 */
function buildWeatherCascadePreview({
  orgId,
  weatherEvent = 'Heavy Rain / Turf Saturation Warning',
  bookings = [],
  fromDateIso,
  shiftDays = 1,
  skipSundays = true,
}) {
  const shifted = rescheduleCascade(bookings, { fromDateIso, shiftDays, skipSundays });
  const affected = shifted.filter((b) => b.cascaded);

  return {
    org_id: orgId,
    calendar_mode: 'MODE_B_CREW_WEATHER_ROUTE',
    weather_event: weatherEvent,
    affected_count: affected.length,
    skip_sundays: skipSundays,
    requires_std_04_approval: true,
    updated_bookings: shifted,
    sms_preview_messages: affected.map((b) => ({
      booking_id: b.id,
      customer_name: b.customer_name || 'Client',
      message: `Weather Update: Due to ${weatherEvent}, your crew visit has been shifted to ${b.starts_at.slice(0, 10)}. Reply HELP if you need a different day.`,
    })),
  };
}

/**
 * Mode C: Event, Banquet & Facility Hold Mode (`OpenCaterer`, `OpenGolfCourseOS`, `OpenChurch`, `OpenHOA`, `OpenRestaurant`)
 */
function evaluateModeCFacilityOrTeeBooking({
  orgId,
  verticalKey,
  bookingSubtype = 'banquet_hold', // 'banquet_hold' | 'golf_tee_time' | 'restaurant_table'
  candidateStartIso,
  candidateEndIso,
  partySize = 4,
  existingBookings = [],
  maxCoversPer15Min = 24,
  blocksTeeSheet = false,
}) {
  if (bookingSubtype === 'restaurant_table') {
    const pacing = evaluateKitchenPacing({
      existingReservations: existingBookings,
      candidateStartIso,
      candidatePartySize: partySize,
      maxCoversPer15Min,
    });
    return {
      org_id: orgId,
      vertical_key: verticalKey,
      calendar_mode: 'MODE_C_EVENT_FACILITY_TEE',
      booking_subtype: bookingSubtype,
      allowed: pacing.allowed,
      per_cover_fee_cents: 0, // Zero OpenTable cover tax!
      pacing,
    };
  }

  if (bookingSubtype === 'golf_tee_time') {
    const sheet = generateTeeSheet({
      courseResourceId: 'course_tee_1',
      dateStr: candidateStartIso.slice(0, 10),
      existingBookings,
    });
    const paired = pairGolferIntoTeeSheet(sheet, partySize);
    return {
      org_id: orgId,
      vertical_key: verticalKey,
      calendar_mode: 'MODE_C_EVENT_FACILITY_TEE',
      booking_subtype: bookingSubtype,
      allowed: paired.paired,
      pairing_result: paired,
    };
  }

  // Banquet / Facility / Shotgun hold conflict check
  const conflicts = existingBookings.filter(
    (b) => b.status !== 'canceled' && rangesOverlap(candidateStartIso, candidateEndIso, b.starts_at, b.ends_at)
  );
  return {
    org_id: orgId,
    vertical_key: verticalKey,
    calendar_mode: 'MODE_C_EVENT_FACILITY_TEE',
    booking_subtype: bookingSubtype,
    allowed: conflicts.length === 0,
    blocks_tee_sheet: blocksTeeSheet,
    conflicts,
  };
}

/**
 * Mode D: Shift & Roster Mode (`OpenFirehouse` 24/48 & 48/96 Kelly Shifts with Minimum Apparatus Staffing Enforcement,
 * `OpenRestaurant`/`OpenCaterer` FOH/BOH shifts, and `OpenSalon` booth/commission rosters).
 */
function evaluateApparatusMinimumStaffing({
  orgId,
  apparatusId = 'Engine-1',
  shiftAssignments = [], // [{ firefighter_id, name, role_rank: 'officer' | 'driver_operator' | 'firefighter_emt' }]
  minimumTotalCrew = 4,
  requiredRoles = ['officer', 'driver_operator'],
}) {
  const presentRoles = new Set(shiftAssignments.map((a) => a.role_rank));
  const missingRoles = requiredRoles.filter((r) => !presentRoles.has(r));
  const headcountShortfall = Math.max(0, minimumTotalCrew - shiftAssignments.length);
  const compliant = missingRoles.length === 0 && headcountShortfall === 0;

  return {
    org_id: orgId,
    calendar_mode: 'MODE_D_SHIFT_ROSTER',
    apparatus_id: apparatusId,
    assigned_count: shiftAssignments.length,
    minimum_required: minimumTotalCrew,
    headcount_shortfall: headcountShortfall,
    missing_critical_roles: missingRoles,
    nfpa_1710_compliant: compliant,
    callback_page_required: !compliant,
  };
}

module.exports = {
  CALENDAR_MODES,
  computeStylistBusyRanges,
  findSplitTimeSqueezeInSlots,
  buildDentalHygienistDoctorOverlap,
  computeRecallRebookingWindow,
  buildWeatherCascadePreview,
  evaluateModeCFacilityOrTeeBooking,
  evaluateApparatusMinimumStaffing,
};
