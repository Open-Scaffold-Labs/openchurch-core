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
} = require('./agentBookingEndpoint');

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

module.exports = {
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
  rescheduleCascade,
  matchWaitlistForCanceledSlot,
  triageMissedCallToSchedule,
  // Agent & Voice Fast-Path
  handleInboundAgentCaller,
  buildPublicAgentBookingManifest,
  prepareOutboundOwnerPhoneCall,
  recordCompletedOutboundCallTranscript,
  // 4 Unified Vertical Calendar Modes & Split-Time Engine
  CALENDAR_MODES,
  computeStylistBusyRanges,
  findSplitTimeSqueezeInSlots,
  buildDentalHygienistDoctorOverlap,
  computeRecallRebookingWindow,
  buildWeatherCascadePreview,
  evaluateModeCFacilityOrTeeBooking,
  evaluateApparatusMinimumStaffing,
  // Universal Calendar Sync (.ics + Webhooks) & Shared UI View-Models
  generateTenantIcsFeed,
  processExternalCalendarWebhook,
  buildDayViewResourceGrid,
  buildWeekListMobileViewModel,
  buildMonthViewSummaryGrid,
  buildMovePanelOptions,
  // OpenSalon Migration Plan & Adapter
  OPENSALON_DOMAIN_IP_PRESERVED,
  OPENSALON_SHARED_MODULE_REPLACEMENTS,
  buildOpenSalonModuleMigrationPlan,
  adaptOpenSalonSplitAppointment,
  // STD-02 / STD-21 / STD-25 Tools
  SCHEDULING_ACTION_TOOLS,
  SCHEDULE_ACTION_TOOLS,
  SCHEDULE_SKILL_SPEC,
};
