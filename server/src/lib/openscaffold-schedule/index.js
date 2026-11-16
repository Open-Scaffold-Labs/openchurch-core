/**
 * @openscaffold/schedule — Main Package Entrypoint (also aliased as @openscaffold/scheduling)
 */

const {
  SCHEDULING_MIGRATION_SQL,
  ensureSchedulingSchema,
  SCHEDULE_MIGRATION_SQL,
  ensureScheduleSchema,
} = require('./schema');

const {
  rangesOverlap,
  detectAllocationConflicts,
  buildSplitAppointmentAllocations,
  generateTeeSheet,
  pairGolferIntoTeeSheet,
  evaluateKitchenPacing,
} = require('./slots');

const {
  generateKellyShiftRotation,
  rescheduleCascade,
} = require('./shifts');

const {
  matchWaitlistForCanceledSlot,
} = require('./waitlist');

const {
  triageMissedCallToSchedule,
} = require('./missedCallTriage');

const {
  handleInboundAgentCaller,
  buildPublicAgentBookingManifest,
  prepareOutboundOwnerPhoneCall,
  recordCompletedOutboundCallTranscript,
  buildXaiVoiceAgentReceptionistConfig,
  evaluateVoiceReceptionistUnitEconomics,
} = require('./inboundCallerFastPath');

const {
  CALENDAR_MODES,
  computeStylistBusyRanges,
  findSplitTimeSqueezeInSlots,
  buildDentalHygienistDoctorOverlap,
  computeRecallRebookingWindow,
  buildWeatherCascadePreview,
  evaluateModeCFacilityOrTeeBooking,
  evaluateApparatusMinimumStaffing,
} = require('./modes');

const {
  generateTenantIcsFeed,
  processExternalCalendarWebhook,
  buildDayViewResourceGrid,
  buildWeekListMobileViewModel,
  buildMonthViewSummaryGrid,
  buildMovePanelOptions,
  buildBookingIcsInviteAndSmsConfirmation,
  buildStd22IosAppIntentsDescriptor,
} = require('./calendarSyncAndViews');

const {
  OPENSALON_DOMAIN_IP_PRESERVED,
  OPENSALON_SHARED_MODULE_REPLACEMENTS,
  buildOpenSalonModuleMigrationPlan,
  adaptOpenSalonSplitAppointment,
} = require('./openSalonAdapter');

const {
  SCHEDULING_ACTION_TOOLS,
  SCHEDULE_ACTION_TOOLS,
  SCHEDULE_SKILL_SPEC,
} = require('./actions');

const {
  TYPICAL_MARKETPLACE_COVER_FEE_CENTS,
  evaluateRestaurantPacingWindow,
  matchWaitlistToCancelledSlot,
  evaluateFacilityEventBooking,
} = require('./restaurant');

const { ScheduleValidationError, parseInput, parseScheduleAction, SCHEDULE_INPUT_SCHEMAS, SCHEDULE_ACTION_SCHEMAS, LINKED_RECORD_TYPES } = require('./validation');

// Public entry points that take outside input validate strictly and require the caller's tenant:
// fn(input, { tenantOrgId }). The tenant must come from the host app's verified session.
const guarded = (kind, fn) => (input, ctx) => fn(parseInput(kind, input, ctx));

module.exports = {
  ScheduleValidationError,
  LINKED_RECORD_TYPES,
  parseScheduleAction,
  SCHEDULE_INPUT_SCHEMAS,
  SCHEDULE_ACTION_SCHEMAS,
  // Schema
  SCHEDULING_MIGRATION_SQL,
  ensureSchedulingSchema,
  SCHEDULE_MIGRATION_SQL,
  ensureScheduleSchema,
  // Core Slot & Pacing Engine
  rangesOverlap,
  detectAllocationConflicts,
  buildSplitAppointmentAllocations,
  generateTeeSheet,
  pairGolferIntoTeeSheet,
  evaluateKitchenPacing,
  // Shifts, Weather Cascade & Waitlist
  generateKellyShiftRotation,
  rescheduleCascade: (bookings, options, ctx) => { const d = parseInput('cascade', { orgId: ctx && ctx.tenantOrgId, bookings, options }, ctx); return rescheduleCascade(d.bookings, d.options); },
  matchWaitlistForCanceledSlot,
  triageMissedCallToSchedule: guarded('missedCall', triageMissedCallToSchedule),
  // Agent & Voice Fast-Path + xAI Voice Agent API Pilot (IDEA-2026-10-25-01 & IDEA-2026-10-25-05)
  handleInboundAgentCaller: guarded('inboundCaller', handleInboundAgentCaller),
  buildPublicAgentBookingManifest,
  prepareOutboundOwnerPhoneCall: guarded('outboundCall', prepareOutboundOwnerPhoneCall),
  // The host must pass ctx.approvedItemHash from its own stored approval record (never from the request);
  // a card whose hash differs, even if self-consistent, is refused.
  recordCompletedOutboundCallTranscript: (input, ctx) => {
    const d = parseInput('transcript', input, ctx);
    if (!ctx.approvedItemHash || ctx.approvedItemHash !== d.approvalCard.exact_item_hash
      || (ctx.approvedByUserId && ctx.approvedByUserId !== d.approvalGrantedByUserId)) throw new ScheduleValidationError('NOT_APPROVED');
    const { orgId, ...rest } = d;
    return recordCompletedOutboundCallTranscript(rest);
  },
  buildXaiVoiceAgentReceptionistConfig,
  evaluateVoiceReceptionistUnitEconomics,
  // 4 Unified Vertical Calendar Modes & Split-Time Engine
  CALENDAR_MODES,
  computeStylistBusyRanges,
  findSplitTimeSqueezeInSlots,
  buildDentalHygienistDoctorOverlap,
  computeRecallRebookingWindow,
  buildWeatherCascadePreview: guarded('weatherCascade', buildWeatherCascadePreview),
  evaluateModeCFacilityOrTeeBooking,
  evaluateRestaurantPacingWindow,
  matchWaitlistToCancelledSlot,
  evaluateFacilityEventBooking,
  TYPICAL_MARKETPLACE_COVER_FEE_CENTS,
  evaluateApparatusMinimumStaffing,
  // Universal Calendar Sync (.ics + Webhooks), Grok Bot iOS Phone Apps (IDEA-2026-10-25-04) & Shared UI View-Models
  generateTenantIcsFeed: guarded('icsFeed', generateTenantIcsFeed),
  processExternalCalendarWebhook: guarded('calendarWebhook', processExternalCalendarWebhook),
  buildDayViewResourceGrid,
  buildWeekListMobileViewModel,
  buildMonthViewSummaryGrid,
  buildMovePanelOptions,
  buildBookingIcsInviteAndSmsConfirmation: guarded('invite', buildBookingIcsInviteAndSmsConfirmation),
  buildIosAppIntentsDescriptor: buildStd22IosAppIntentsDescriptor,
  // Salon vertical migration plan & adapter (neutral names)
  SALON_DOMAIN_IP_PRESERVED: OPENSALON_DOMAIN_IP_PRESERVED,
  SALON_SHARED_MODULE_REPLACEMENTS: OPENSALON_SHARED_MODULE_REPLACEMENTS,
  buildSalonModuleMigrationPlan: buildOpenSalonModuleMigrationPlan,
  adaptSalonSplitAppointment: adaptOpenSalonSplitAppointment,
  /** @deprecated use buildIosAppIntentsDescriptor */
  buildStd22IosAppIntentsDescriptor,
  /** @deprecated use SALON_DOMAIN_IP_PRESERVED */
  OPENSALON_DOMAIN_IP_PRESERVED,
  /** @deprecated use SALON_SHARED_MODULE_REPLACEMENTS */
  OPENSALON_SHARED_MODULE_REPLACEMENTS,
  /** @deprecated use buildSalonModuleMigrationPlan */
  buildOpenSalonModuleMigrationPlan,
  /** @deprecated use adaptSalonSplitAppointment */
  adaptOpenSalonSplitAppointment,
  // STD-02 / STD-21 / STD-25 Tools
  SCHEDULING_ACTION_TOOLS,
  SCHEDULE_ACTION_TOOLS,
  SCHEDULE_SKILL_SPEC,
};
