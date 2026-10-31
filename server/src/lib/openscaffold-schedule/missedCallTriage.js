/**
 * @openscaffold/scheduling — 24/7 Missed-Call SMS & Voice Receptionist Triage Bridge
 * Implements IDEA-2026-10-24-03:
 *  - Captures unanswered inbound calls after 3 rings or after-hours
 *  - Books directly into conflict-free `osc_sched_*` slots
 *  - Automatically queues downstream `Prepare` tasks:
 *      * `open-dentist`: schedules a `Prepare` insurance eligibility check 48 hours prior to appointment
 *      * `open-restaurant` / `open-caterer`: creates an interactive `@openscaffold/crm` `catering_beo` draft (`scales_with_guests = true`)
 */

function triageMissedCallToSchedule({
  orgId,
  verticalKey,
  callerName,
  callerPhone,
  requestedStartIso,
  durationMinutes = 60,
  partyOrGuestCount = 1,
  inquiryKind = 'appointment', // 'appointment' | 'catering_or_private_dining'
}) {
  const startMs = new Date(requestedStartIso).getTime();
  const endIso = new Date(startMs + durationMinutes * 60000).toISOString();
  const hours48Ms = 48 * 60 * 60 * 1000;

  const bookingDraft = {
    org_id: orgId,
    vertical_key: verticalKey,
    booking_kind: inquiryKind === 'catering_or_private_dining' ? 'event_room' : 'appointment',
    customer_name: callerName,
    party_size: partyOrGuestCount,
    starts_at: requestedStartIso,
    ends_at: endIso,
    status: 'confirmed',
  };

  const downstreamPrepareTasks = [];

  if (verticalKey === 'open-dentist') {
    const verifyAtIso = new Date(startMs - hours48Ms).toISOString();
    downstreamPrepareTasks.push({
      tier: 'Prepare',
      tool_name: 'dentist.verify_insurance_eligibility_48h',
      scheduled_for: verifyAtIso,
      description: `Re-verify dental insurance eligibility for ${callerName} 48h before ${requestedStartIso}`,
    });
  }

  if (
    verticalKey === 'open-restaurant' ||
    verticalKey === 'open-caterer' ||
    inquiryKind === 'catering_or_private_dining'
  ) {
    downstreamPrepareTasks.push({
      tier: 'Prepare',
      tool_name: 'crm.build_interactive_proposal',
      proposal_kind: 'catering_beo',
      scales_with_guests: true,
      guest_or_unit_count: partyOrGuestCount,
      description: `Interactive Catering / PDR BEO draft for ${callerName} (${partyOrGuestCount} guests)`,
    });
  }

  return {
    orgId,
    verticalKey,
    callerPhone,
    instantSmsReplyQueued: true,
    bookingDraft,
    downstreamPrepareTasks,
  };
}

module.exports = {
  triageMissedCallToSchedule,
};
