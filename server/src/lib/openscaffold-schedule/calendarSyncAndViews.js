/**
 * @openscaffold/schedule — Universal Calendar Sync (RFC 5545 .ics + Webhooks)
 * & Shared UI Calendar View-Models (DayView, WeekList, MonthView, MovePanel)
 */

const crypto = require('crypto');
const { computeStylistBusyRanges, findSplitTimeSqueezeInSlots } = require('./modes');

function formatIcsUtcTimestamp(isoStr) {
  return new Date(isoStr).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(str = '') {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Generates a tokenized, tenant-scoped RFC 5545 `.ics` (`VCALENDAR`) feed compatible with
 * Google Calendar, Apple Calendar (iOS/macOS), and Microsoft Outlook.
 */
function generateTenantIcsFeed({
  orgId,
  calendarName = 'Open Scaffold Schedule',
  timezone = 'America/Los_Angeles',
  feedToken = 'tok_demo',
  bookings = [],
}) {
  const tokenSha256 = crypto.createHash('sha256').update(`${orgId}:${feedToken}`).digest('hex');
  const dtstamp = formatIcsUtcTimestamp(new Date().toISOString());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Open Scaffold Labs//@openscaffold/schedule v0.1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    `X-WR-TIMEZONE:${timezone}`,
    `X-OSL-TENANT:${escapeIcsText(orgId)}`,
  ];

  for (const b of bookings) {
    if (b.status === 'canceled' || b.status === 'cancelled') continue;
    const uid = `${b.id || crypto.randomUUID()}@${orgId}.openscaffold.org`;
    const summary = b.service_name
      ? `${b.customer_name || b.client_name} — ${b.service_name}`
      : `${b.customer_name || b.client_name} (${b.booking_kind || 'Booking'})`;
    const descParts = [
      `Status: ${b.status || 'confirmed'}`,
      b.applied_minutes && b.processing_minutes
        ? `Split-Time: ${b.applied_minutes}m apply / ${b.processing_minutes}m processing gap`
        : null,
      b.notes ? `Notes: ${b.notes}` : null,
    ].filter(Boolean);

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${formatIcsUtcTimestamp(b.starts_at)}`,
      `DTEND:${formatIcsUtcTimestamp(b.ends_at)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `DESCRIPTION:${escapeIcsText(descParts.join(' | '))}`,
      `STATUS:${b.status === 'requested' ? 'TENTATIVE' : 'CONFIRMED'}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  return {
    org_id: orgId,
    token_sha256: tokenSha256,
    content_type: 'text/calendar; charset=utf-8',
    event_count: bookings.filter((b) => b.status !== 'canceled' && b.status !== 'cancelled').length,
    ics_body: lines.join('\r\n') + '\r\n',
  };
}

/**
 * Processes an inbound two-way webhook event from Google Calendar, Apple CalDAV, or Microsoft Graph
 * and normalizes external busy blocks into `osc_sched_bookings` / `osc_sched_allocations`.
 */
function processExternalCalendarWebhook({
  orgId,
  provider = 'google_calendar',
  resourceId,
  externalEvents = [],
  syncCursor = null,
}) {
  const upsertedBlocks = [];
  const canceledExternalIds = [];

  for (const ev of externalEvents) {
    if (ev.status === 'cancelled' || ev.status === 'canceled') {
      canceledExternalIds.push(ev.external_id);
      continue;
    }
    upsertedBlocks.push({
      org_id: orgId,
      resource_id: resourceId,
      external_provider: provider,
      external_id: ev.external_id,
      starts_at: ev.starts_at,
      ends_at: ev.ends_at,
      summary: ev.summary || 'External Calendar Busy Block',
      active_exclusive: ev.transparency !== 'transparent',
    });
  }

  return {
    org_id: orgId,
    provider,
    resource_id: resourceId,
    upserted_count: upsertedBlocks.length,
    canceled_count: canceledExternalIds.length,
    upserted_blocks: upsertedBlocks,
    canceled_external_ids: canceledExternalIds,
    next_sync_cursor: syncCursor || `cursor_${Date.now()}`,
  };
}

/**
 * Shared UI View-Model 1: `DayView` Multi-Column Resource Grid with Split-Time Processing Gap Blocks.
 */
function buildDayViewResourceGrid({
  dateStr,
  resources = [],
  bookings = [],
  dayStartHour = 8,
  dayEndHour = 20,
}) {
  const columns = resources.map((res) => {
    const resBookings = bookings
      .filter((b) => String(b.resource_id || b.stylist_id) === String(res.id) && b.status !== 'canceled')
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

    const blocks = resBookings.map((b) => {
      const splitInfo = computeStylistBusyRanges({
        startsAtIso: b.starts_at,
        endsAtIso: b.ends_at,
        appliedMinutes: b.applied_minutes || 0,
        processingMinutes: b.processing_minutes || 0,
        bufferBeforeMinutes: b.buffer_before_minutes || 0,
        bufferAfterMinutes: b.buffer_after_minutes || 0,
      });
      return {
        booking_id: b.id,
        customer_name: b.customer_name || b.client_name,
        service_name: b.service_name || b.booking_kind,
        starts_at: b.starts_at,
        ends_at: b.ends_at,
        status: b.status,
        is_split_time: splitInfo.isSplitTime,
        busy_segments: splitInfo.busyRanges,
        open_processing_gap: splitInfo.processingGap,
      };
    });

    return {
      resource_id: res.id,
      resource_name: res.name,
      resource_type: res.resource_type || 'provider',
      blocks,
    };
  });

  return {
    view: 'DayView',
    date: dateStr,
    hours_range: [dayStartHour, dayEndHour],
    columns,
  };
}

/**
 * Shared UI View-Model 2: `WeekList` Mobile Phone View harvested from Matt's `OpenSalon` (`WeekList.jsx`).
 * Groups a 7-day range into clean daily sections with category color tokens and tap-to-open actions.
 */
function buildWeekListMobileViewModel({
  weekStartDateStr,
  bookings = [],
  selectedResourceId = null,
}) {
  const startMs = new Date(`${weekStartDateStr}T00:00:00Z`).getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  const days = Array.from({ length: 7 }, (_, i) => {
    const dayIso = new Date(startMs + i * dayMs).toISOString().slice(0, 10);
    const items = bookings
      .filter((b) => {
        if (b.status === 'canceled' || b.status === 'cancelled') return false;
        if (selectedResourceId && String(b.resource_id || b.stylist_id) !== String(selectedResourceId)) return false;
        return String(b.starts_at).slice(0, 10) === dayIso;
      })
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
      .map((b) => ({
        id: b.id,
        starts_at: b.starts_at,
        ends_at: b.ends_at,
        customer_name: b.customer_name || b.client_name,
        service_name: b.service_name || b.booking_kind,
        resource_name: b.resource_name || b.stylist_name || 'Assigned Resource',
        category_color: b.service_category || 'general',
        status: b.status,
        has_processing_gap: Number(b.processing_minutes || 0) > 0,
      }));

    return {
      date: dayIso,
      item_count: items.length,
      items,
    };
  });

  return {
    view: 'WeekList',
    harvested_from: 'OpenSalon/client/src/components/calendar/WeekList.jsx',
    week_start: weekStartDateStr,
    total_bookings: days.reduce((acc, d) => acc + d.item_count, 0),
    days,
  };
}

/**
 * Shared UI View-Model 3: `MonthView` High-Level Capacity, Event & Recall Density Grid.
 */
function buildMonthViewSummaryGrid({ yearMonth, bookings = [] }) {
  const byDate = {};
  for (const b of bookings) {
    if (b.status === 'canceled' || b.status === 'cancelled') continue;
    const d = String(b.starts_at).slice(0, 10);
    if (!d.startsWith(yearMonth)) continue;
    if (!byDate[d]) {
      byDate[d] = { date: d, booking_count: 0, split_gap_opportunities: 0 };
    }
    byDate[d].booking_count += 1;
    if (Number(b.processing_minutes || 0) > 0) {
      byDate[d].split_gap_opportunities += 1;
    }
  }
  return {
    view: 'MonthView',
    year_month: yearMonth,
    active_days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Shared UI View-Model 4: `MovePanel` WCAG 2.5.7 Non-Drag Conflict-Checked Rescheduler
 * harvested from Matt's `OpenSalon` (`client/src/components/calendar/MovePanel.jsx`).
 */
function buildMovePanelOptions({
  appointment,
  candidateStylistId,
  candidateStylistName = 'Stylist',
  targetWindowStartIso,
  targetWindowEndIso,
  existingAppointments = [],
}) {
  const durationMinutes = Math.round(
    (new Date(appointment.ends_at).getTime() - new Date(appointment.starts_at).getTime()) / (60 * 1000)
  );
  const filteredExisting = existingAppointments.filter((a) => String(a.id) !== String(appointment.id));

  const validSlots = findSplitTimeSqueezeInSlots({
    stylistId: candidateStylistId,
    stylistName: candidateStylistName,
    windowStartIso: targetWindowStartIso,
    windowEndIso: targetWindowEndIso,
    durationMinutes,
    slotStepMinutes: 15,
    candidateAppliedMinutes: appointment.applied_minutes || 0,
    candidateProcessingMinutes: appointment.processing_minutes || 0,
    candidateBufferBeforeMinutes: appointment.buffer_before_minutes || 0,
    candidateBufferAfterMinutes: appointment.buffer_after_minutes || 0,
    existingAppointments: filteredExisting,
  });

  return {
    view: 'MovePanel',
    wcag_2_5_7_compliant: true,
    harvested_from: 'OpenSalon/client/src/components/calendar/MovePanel.jsx',
    appointment_id: appointment.id,
    duration_minutes: durationMinutes,
    target_stylist_id: candidateStylistId,
    available_move_slots: validSlots,
  };
}

module.exports = {
  generateTenantIcsFeed,
  processExternalCalendarWebhook,
  buildDayViewResourceGrid,
  buildWeekListMobileViewModel,
  buildMonthViewSummaryGrid,
  buildMovePanelOptions,
};
