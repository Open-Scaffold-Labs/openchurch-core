/**
 * @openscaffold/schedule — STD-02 / STD-21 / STD-25 Single Action Layer Tool Definitions
 */

const SCHEDULING_ACTION_TOOLS = [
  {
    name: 'schedule.check_availability',
    tier: 'Read',
    description: 'Query conflict-free resource slots (including OpenSalon split-time processing gap squeeze-in slots) across chairs, operatories, tables, tee sheets, courts, rooms, or crews.',
    requiredFields: ['org_id', 'resource_type', 'date'],
  },
  {
    name: 'schedule.book_slot',
    tier: 'Auto',
    description: 'Book a multi-resource or split-time slot (Mode A/B/C/D) with PostgreSQL tstzrange GiST overlap exclusion.',
    requiredFields: ['org_id', 'vertical_key', 'booking_kind', 'customer_name', 'starts_at', 'ends_at'],
  },
  {
    name: 'schedule.create_booking',
    tier: 'Auto',
    description: 'Create a conflict-free booking with PostgreSQL tstzrange GiST overlap exclusion.',
    requiredFields: ['org_id', 'vertical_key', 'booking_kind', 'customer_name', 'starts_at', 'ends_at'],
  },
  {
    name: 'schedule.move_or_cascade',
    tier: 'Act',
    requiresStd04Approval: true,
    description: 'Move an appointment via conflict-checked MovePanel or cascade-shift a day of crew routes due to weather/rain-out with SMS/email preview.',
    requiredFields: ['org_id', 'from_date_iso', 'shift_days'],
  },
  {
    name: 'schedule.reschedule_cascade',
    tier: 'Act',
    requiresStd04Approval: true,
    description: 'Cascade-shift a day of crew routes or appointments due to weather/emergency and notify affected clients.',
    requiredFields: ['org_id', 'from_date_iso', 'shift_days'],
  },
  {
    name: 'schedule.fill_waitlist',
    tier: 'Auto',
    description: 'Rank waiting clients by priority + desired window and generate an expiring instant claim offer when a slot opens.',
    requiredFields: ['org_id', 'slot_date', 'slot_start_iso', 'slot_end_iso', 'slot_party_capacity'],
  },
  {
    name: 'schedule.pair_tee_time',
    tier: 'Auto',
    description: 'Pair a single, twosome, or threesome into an open foursome tee slot on the course tee sheet.',
    requiredFields: ['org_id', 'course_resource_id', 'date', 'party_size'],
  },
  {
    name: 'voice.place_outbound_call',
    tier: 'Act',
    requiresStd04Approval: true,
    description: 'Place an outbound phone call on the business owner’s behalf (e.g., Delta Dental payer IVR, supplier quote, or appointment confirmation) behind STD-04 approval and attach the live transcript + summary.',
    requiredFields: ['org_id', 'target_phone_number', 'call_objective', 'script_summary', 'linked_record_type', 'linked_record_id'],
  },
];

const SCHEDULE_SKILL_SPEC = Object.freeze({
  skill_id: 'cross-vertical-schedule-ops',
  standard: 'STD-25',
  version: '0.1.0',
  modes: [
    'MODE_A_APPOINTMENT_CHAIR',
    'MODE_B_CREW_WEATHER_ROUTE',
    'MODE_C_EVENT_FACILITY_TEE',
    'MODE_D_SHIFT_ROSTER',
  ],
  tools: SCHEDULING_ACTION_TOOLS.map((t) => t.name),
});

module.exports = {
  SCHEDULING_ACTION_TOOLS,
  SCHEDULE_ACTION_TOOLS: SCHEDULING_ACTION_TOOLS,
  SCHEDULE_SKILL_SPEC,
};
