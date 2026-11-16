/**
 * Strict input validation for every @openscaffold/schedule entry point that takes outside input
 * (agent tools, inbound callers, calendar webhooks, feeds). zod `.strict()` everywhere: unknown
 * keys are rejected. Every call also needs the caller's verified tenant (`ctx.tenantOrgId`, from the
 * host app's session, never from the request) and the input's orgId must match it.
 */
const { z } = require('zod');

class ScheduleValidationError extends Error {
  constructor(code, issues) {
    super(code === 'TENANT_MISMATCH' ? 'Not allowed for this organization' : 'Invalid schedule input');
    this.name = 'ScheduleValidationError';
    this.code = code;
    this.status = code === 'TENANT_MISMATCH' || code === 'NO_TENANT' || code === 'NOT_APPROVED' ? 403 : 400;
    this.issues = issues || [];
  }
}

const id = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const name = z.string().min(1).max(200).refine((v) => !/[\r\n<>]/.test(v), { message: 'No line breaks or angle brackets.' });
const text = (n) => z.string().max(n).refine((v) => !/<\s*\/?\s*script/i.test(v), { message: 'No script.' });
const iso = z.string().max(40).datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phone = z.string().min(7).max(20).regex(/^\+?[0-9]{7,15}$/);
const email = z.string().max(254).email();
const vertical = z.string().max(60).regex(/^[a-z0-9-]+$/);
const cents = z.number().int().min(0).max(100_000_000);
const minutes = z.number().int().min(1).max(24 * 60);
const party = z.number().int().min(1).max(500);
const tz = z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/);
const LINKED_RECORD_TYPES = Object.freeze([
  'job', 'patient', 'hoa_unit', 'catering_event', 'vendor_po',
  'reservation', 'appointment', 'booking', 'event',
]);
const linkedRecordType = z.enum(LINKED_RECORD_TYPES);

const slug = z.string().max(40).regex(/^[a-z_]+$/);
const plain = (n) => z.string().max(n).refine((v) => !/[\r\n<>]/.test(v), { message: 'No line breaks or angle brackets.' });
// A booking row as the host loaded it under RLS: every osc_sched_bookings column (src/schema.js) plus the
// view fields the feed/invite builders read. org_id, when present, must equal the session tenant (checked in check()).
const ts = z.preprocess((v) => (v instanceof Date ? v.toISOString() : v), iso);
const nn = (sch) => sch.nullable().optional();
const STATUSES = ['requested', 'confirmed', 'checked_in', 'seated_or_on_course', 'completed', 'no_show', 'canceled', 'cancelled'];
const storedBooking = z.object({
  id, org_id: id.optional(), vertical_key: vertical.optional(),
  calendar_mode: z.enum(['MODE_A_APPOINTMENT_CHAIR', 'MODE_B_CREW_WEATHER_ROUTE', 'MODE_C_EVENT_FACILITY_TEE', 'MODE_D_SHIFT_ROSTER']).optional(),
  booking_kind: slug.optional(), customer_account_id: nn(id), customer_name: name.optional(), client_name: name.optional(),
  party_size: party.optional(), status: z.enum(STATUSES).optional(), starts_at: ts, ends_at: ts,
  applied_minutes: z.number().int().min(0).max(1440).optional(), processing_minutes: z.number().int().min(0).max(1440).optional(),
  buffer_before_minutes: z.number().int().min(0).max(1440).optional(), buffer_after_minutes: z.number().int().min(0).max(1440).optional(),
  allow_double_book_in_gap: z.boolean().optional(), recall_interval_days: nn(z.number().int().min(0).max(3650)),
  deposit_payment_id: nn(id), no_show_fee_cents: cents.optional(), notes: nn(plain(2000)), version: z.number().int().min(1).optional(),
  created_at: ts.optional(), updated_at: ts.optional(),
  service_name: plain(200).optional(), resource_id: id.optional(), resource_ids: z.array(id).max(20).optional(),
  stylist_id: id.optional(), provider_id: id.optional(), customer_phone: nn(phone), customer_email: nn(email),
}).strict().refine((b) => Date.parse(b.starts_at) < Date.parse(b.ends_at), { message: 'starts_at must be before ends_at' });
const icsBooking = storedBooking;
const cascadeBooking = storedBooking;

const S = {
  inboundCaller: z.object({
    orgId: id, verticalKey: vertical, callerUserAgent: z.string().max(500).optional(), speechPreamble: text(2000).optional(),
    endCustomerName: name, endCustomerPhone: phone.nullable().optional(), endCustomerEmail: email.nullable().optional(),
    requestedAction: z.enum(['check_availability', 'book_slot', 'pricing_and_hours']).optional(),
    requestedStartIso: iso, durationMinutes: minutes.optional(), partyOrGuestCount: party.optional(), quotedPriceCents: cents.optional(),
  }).strict(),
  outboundCall: z.object({
    orgId: id, verticalKey: vertical, initiatedByAgentId: id, onBehalfOfUserId: id, targetRecipientName: name,
    targetPhoneNumber: phone, callObjective: text(1000).pipe(z.string().min(1)), scriptSummary: text(4000).pipe(z.string().min(1)),
    ivrNavigationHints: z.array(text(300)).max(20).optional(),
    fallbackAction: z.enum(['leave_voicemail_and_send_sms', 'leave_voicemail', 'send_sms', 'none']).optional(),
    linkedRecordType: linkedRecordType, linkedRecordId: id,
  }).strict(),
  calendarWebhook: z.object({
    orgId: id, provider: z.enum(['google_calendar', 'apple_caldav', 'microsoft_graph']).optional(), resourceId: id,
    externalEvents: z.array(z.object({
      external_id: id, starts_at: iso.optional(), ends_at: iso.optional(), summary: text(500).optional(),
      status: z.enum(['confirmed', 'tentative', 'cancelled', 'canceled']).optional(), transparency: z.enum(['opaque', 'transparent']).optional(),
    }).strict().refine((e) => e.status === 'cancelled' || e.status === 'canceled' || (e.starts_at && e.ends_at && Date.parse(e.starts_at) < Date.parse(e.ends_at)), { message: 'Active events need starts_at before ends_at.' })).max(2000),
    syncCursor: z.string().max(500).nullable().optional(),
  }).strict(),
  icsFeed: z.object({
    orgId: id, calendarName: z.string().max(200).optional(), timezone: tz.optional(),
    feedToken: z.string().min(24).max(200).regex(/^[A-Za-z0-9_-]+$/),
    bookings: z.array(z.lazy(() => icsBooking)).max(5000).optional(),
  }).strict(),
  cascade: z.object({
    orgId: id, bookings: z.array(cascadeBooking).max(5000),
    options: z.object({ fromDateIso: iso, shiftDays: z.number().int().min(-30).max(30).optional(), skipSundays: z.boolean().optional() }).strict(),
  }).strict(),
  transcript: z.object({
    orgId: id,
    approvalCard: z.object({
      tool_name: z.literal('voice.place_outbound_call'), tier: z.literal('Act'), requiresStd04Approval: z.literal(true),
      status: z.literal('waiting_on_approval'), org_id: id, vertical_key: vertical, initiated_by_agent_id: id, on_behalf_of: id,
      exact_item_hash: z.string().regex(/^[a-f0-9]{64}$/),
      preview_card_json: z.object({
        card_type: z.literal('outbound_phone_call_approval'), title: plain(260), target_phone_number: phone,
        call_objective: text(1000), script_summary: text(4000), ivr_navigation_hints: z.array(text(300)).max(20),
        fallback_action: z.enum(['leave_voicemail_and_send_sms', 'leave_voicemail', 'send_sms', 'none']),
        linked_record: z.object({ type: linkedRecordType, id }).strict(),
      }).strict(),
      post_call_artifact_contract: z.object({
        attach_to_record_type: linkedRecordType, attach_to_record_id: id,
        captures_live_transcript: z.boolean(), captures_structured_summary: z.boolean(),
      }).strict(),
    }).strict().refine((c) => c.exact_item_hash === require('crypto').createHash('sha256').update(JSON.stringify({ tool_name: 'voice.place_outbound_call', org_id: c.org_id, on_behalf_of: c.on_behalf_of, preview: c.preview_card_json })).digest('hex')
      && c.post_call_artifact_contract.attach_to_record_type === c.preview_card_json.linked_record.type
      && c.post_call_artifact_contract.attach_to_record_id === c.preview_card_json.linked_record.id, { message: 'Approval card was altered after it was built.' }),
    approvalGrantedByUserId: id, callDurationSeconds: z.number().int().min(0).max(4 * 3600),
    transcriptLines: z.array(text(2000)).max(2000).optional(), structuredOutcome: z.record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
  }).strict(),
  invite: z.object({
    orgId: id, tenantSlug: z.string().max(63).regex(/^[a-z0-9-]+$/).optional(), businessName: plain(200).optional(), verticalKey: vertical.optional(),
    baseUrl: z.string().max(300).refine((u) => !/[\u0000-\u0020\u007f-\u009f<>"'`\\]/.test(u), { message: 'No whitespace, control or quote characters.' }).pipe(z.string().url()).refine((u) => /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(u), { message: 'https origin + plain path only' }).nullable().optional(),
    booking: z.lazy(() => icsBooking), customerPhone: phone.nullable().optional(), customerEmail: email.nullable().optional(),
    locationAddress: plain(300).nullable().optional(), tokenSecret: z.string().min(32).max(512),
  }).strict(),
  weatherCascade: z.object({
    orgId: id, weatherEvent: plain(200).optional(), bookings: z.array(cascadeBooking).max(5000),
    fromDateIso: iso, shiftDays: z.number().int().min(-30).max(30).optional(), skipSundays: z.boolean().optional(),
  }).strict(),
  missedCall: z.object({
    orgId: id, verticalKey: vertical, callerName: name, callerPhone: phone, requestedStartIso: iso,
    durationMinutes: minutes.optional(), partyOrGuestCount: party.optional(),
    inquiryKind: z.enum(['appointment', 'catering_or_private_dining']).optional(),
  }).strict(),
};

// Agent action tools (actions.js). Field lists follow each tool's requiredFields plus documented optionals.
const ACTIONS = {
  'schedule.check_availability': { org_id: id, resource_type: z.string().max(40).regex(/^[a-z_]+$/), date },
  'schedule.book_slot': { org_id: id, vertical_key: vertical, booking_kind: z.string().max(40).regex(/^[a-z_]+$/), customer_name: name, starts_at: iso, ends_at: iso, resource_ids: z.array(id).max(20).optional(), notes: text(2000).optional(), customer_phone: phone.optional(), customer_email: email.optional() },
  'schedule.move_or_cascade': { org_id: id, from_date_iso: iso.or(date), shift_days: z.number().int().min(-30).max(30), booking_id: id.optional() },
  'schedule.fill_waitlist': { org_id: id, slot_date: date, slot_start_iso: iso, slot_end_iso: iso, slot_party_capacity: party },
  'schedule.pair_tee_time': { org_id: id, course_resource_id: id, date, party_size: z.number().int().min(1).max(4) },
  'voice.place_outbound_call': { org_id: id, target_phone_number: phone, call_objective: text(1000), script_summary: text(4000), linked_record_type: linkedRecordType, linked_record_id: id },
};
ACTIONS['schedule.create_booking'] = ACTIONS['schedule.book_slot'];
ACTIONS['schedule.reschedule_cascade'] = ACTIONS['schedule.move_or_cascade'];
const ACTION_SCHEMAS = Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => {
  let s = z.object(v).strict();
  if (v.starts_at && v.ends_at) s = s.refine((o) => Date.parse(o.starts_at) < Date.parse(o.ends_at), { message: 'starts_at must be before ends_at', path: ['ends_at'] });
  if (v.slot_start_iso && v.slot_end_iso) s = s.refine((o) => Date.parse(o.slot_start_iso) < Date.parse(o.slot_end_iso), { message: 'slot start must be before end', path: ['slot_end_iso'] });
  return [k, s];
}));

function check(schema, input, ctx, orgKey) {
  const tenant = ctx && ctx.tenantOrgId;
  if (!tenant || typeof tenant !== 'string') throw new ScheduleValidationError('NO_TENANT');
  const r = schema.safeParse(input);
  if (!r.success) throw new ScheduleValidationError('INVALID', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  if (r.data[orgKey] !== tenant) throw new ScheduleValidationError('TENANT_MISMATCH');
  const nested = [...(r.data.bookings || []), r.data.booking, r.data.approvalCard].filter(Boolean);
  if (nested.some((b) => b.org_id !== undefined && b.org_id !== tenant)) throw new ScheduleValidationError('TENANT_MISMATCH');
  if (r.data.approvalCard && r.data.approvalCard.org_id !== tenant) throw new ScheduleValidationError('TENANT_MISMATCH');
  return r.data;
}
const parseInput = (kind, input, ctx) => check(S[kind], input, ctx, 'orgId');
function parseScheduleAction(tool, input, ctx) {
  const schema = ACTION_SCHEMAS[tool];
  if (!schema) throw new ScheduleValidationError('INVALID', [{ path: 'tool', message: 'Unknown tool' }]);
  return check(schema, input, ctx, 'org_id');
}

module.exports = {
  LINKED_RECORD_TYPES, ScheduleValidationError, parseInput, parseScheduleAction, SCHEDULE_INPUT_SCHEMAS: S, SCHEDULE_ACTION_SCHEMAS: ACTION_SCHEMAS };
