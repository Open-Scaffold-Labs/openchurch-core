/**
 * @openscaffold/schedule — OpenSalon Migration Plan & Split-Time Adapter
 *
 * Maps `Open-Scaffold-Labs/OpenSalon` (`main` @ `fb4125d`) onto shared `@openscaffold/*` modules
 * while preserving 100% of Matt's true Salon Domain IP (`backbar.js`, `bowls.js`, `formulas.js`,
 * `addons.js`, `shade-templates`, and `waste.js`).
 */

const { computeStylistBusyRanges, computeRecallRebookingWindow } = require('./modes');

const OPENSALON_DOMAIN_IP_PRESERVED = Object.freeze([
  {
    file: 'server/src/routes/backbar.js',
    tables: ['hs_color_lines', 'hs_shades', 'hs_backbar_adjustments'],
    verdict: 'PRESERVE_VERTICAL_IP',
    rationale: 'True salon chemical backbar inventory: role-gated cost visibility (stylist/assistant sees grams only; manager/owner sees cost_cents), shade template seeding, and 10-minute adjustment undo.',
  },
  {
    file: 'server/src/routes/bowls.js',
    tables: ['hs_bowls'],
    verdict: 'PRESERVE_VERTICAL_IP',
    rationale: 'Empty-bowl tare library in whole tenths of a gram (tare_tenths_g) + 480px JPEG scale photo for backbar re-weigh stations.',
  },
  {
    file: 'server/src/lib/waste.js',
    tables: [],
    verdict: 'PRESERVE_VERTICAL_IP',
    rationale: 'Pure integer tenths-of-a-gram reweigh({ reading, tare, mixed, costCents }) math computing leftoverTenthsG, usedTenthsG, wastePctBp, and wasteCostCents with below_tare / above_mixed scale guards.',
  },
  {
    file: 'server/src/routes/formulas.js & server/src/routes/addons.js & server/src/data/shade-templates/*',
    tables: ['hs_formulas', 'hs_service_addons'],
    verdict: 'PRESERVE_VERTICAL_IP',
    rationale: 'Client hair color formula history (Aurelia Professional, Bellmere, Maison, Solenne, Velour shade lines) and per-service chemical add-ons.',
  },
]);

const OPENSALON_SHARED_MODULE_REPLACEMENTS = Object.freeze([
  {
    opensalon_files: [
      'migrations/004_hs_split_time.sql',
      'server/src/lib/availability.js',
      'server/test/split-time-api.mjs',
      'client/src/components/calendar/WeekList.jsx',
      'client/src/components/calendar/MovePanel.jsx',
    ],
    target_shared_module: '@openscaffold/schedule v0.1.0 (@openscaffold/core/schedule)',
    action: 'HARVEST_AND_PROMOTE_TO_SHARED',
    migration_notes:
      'Matt’s hs_stylist_busy_ranges split-time processing gap SQL, single-statement timezone-aware AVAILABILITY_SQL, WeekList phone view, and WCAG 2.5.7 MovePanel are promoted into @openscaffold/schedule Mode A so OpenSalon, OpenDentist, and all 12 verticals share one battle-tested engine.',
  },
  {
    opensalon_files: ['server/src/routes/gift-cards.js', 'hs_gift_cards', 'hs_gift_card_entries'],
    target_shared_module: '@openscaffold/gift-cards v0.1.0 (@openscaffold/core/gift-cards)',
    action: 'REPLACE_WITH_SHARED_MODULE',
    migration_notes:
      'Preserves Matt’s append-only ledger design (SUM(delta_cents)) while upgrading to osc_gc_cards + osc_gc_transactions with paid_principal vs. promo_bonus separation, CA Civil Code § 1749.5 <$10 cash-out compliance, @openscaffold/books Account 2350 unearned liability journals, and split-tender checkout handoff.',
  },
  {
    opensalon_files: [
      'server/src/routes/products.js',
      'server/src/routes/transactions.js',
      'server/src/lib/barcode.js',
      'server/test/checkout-tenders.mjs',
    ],
    target_shared_module: '@openscaffold/shop + @openscaffold/billing v2.0 (@openscaffold/pay-client)',
    action: 'REPLACE_WITH_SHARED_MODULE',
    migration_notes:
      'Replaces bespoke hs_products, hs_transactions, and hs_transaction_tenders with @openscaffold/shop (osh_* retail SKUs, barcode scanning) + @openscaffold/billing v2.0 (Tap to Pay, IC+, multi-tender split across card + gift card + cash + tip).',
  },
  {
    opensalon_files: ['server/src/routes/financial.js'],
    target_shared_module: '@openscaffold/books Phase 2 (open-salon preset)',
    action: 'REPLACE_WITH_SHARED_MODULE',
    migration_notes:
      'Replaces bespoke revenue summary queries with double-entry journal automation: booth-rental vs. sliding-scale commission stylist splits, 1099-NEC tracking, backbar chemical COGS (from waste.js) vs. retail COGS, and QuickBooks 30d/60d $0.00 Variance parallel proof.',
  },
  {
    opensalon_files: ['server/src/lib/consent.js'],
    target_shared_module: '@openscaffold/esign + @openscaffold/messaging',
    action: 'REPLACE_WITH_SHARED_MODULE',
    migration_notes:
      'Replaces bespoke SMS disclosure strings and chemical waiver flags with tamper-evident @openscaffold/esign chemical/color waivers and STD-10 send_ledger TCPA consent tracking.',
  },
  {
    opensalon_files: ['server/src/lib/email.js'],
    target_shared_module: '@openscaffold/messaging',
    action: 'REPLACE_WITH_SHARED_MODULE',
    migration_notes:
      'Routes confirmation, 24h reminder, and 6-week root touch-up recall notifications through @openscaffold/messaging with idempotent send_ledger protection.',
  },
  {
    opensalon_files: ['client/src/pages/AIAssistantPage.jsx', 'server/test/agent-booking.mjs'],
    target_shared_module: '@open-scaffold-labs/ai v0.2.1 + @openscaffold/schedule',
    action: 'REPLACE_WITH_SHARED_MODULE',
    migration_notes:
      'Replaces the "Not available yet" placeholder in AIAssistantPage.jsx with the live STD-14/21/25 Two-Door /api/agent/mcp runtime and /.well-known/agent-booking.json fast path.',
  },
]);

function buildOpenSalonModuleMigrationPlan() {
  return {
    repo: 'Open-Scaffold-Labs/OpenSalon',
    audited_commit: 'fb4125d',
    domain_ip_preserved_pct: 15,
    shared_module_consolidation_pct: 85,
    preserved_vertical_ip: OPENSALON_DOMAIN_IP_PRESERVED,
    shared_module_replacements: OPENSALON_SHARED_MODULE_REPLACEMENTS,
  };
}

/**
 * Adapts an `OpenSalon` appointment row (`hs_appointments` + `hs_services` split-time columns)
 * into a canonical `@openscaffold/schedule` booking + `osc_sched_segments` array.
 */
function adaptOpenSalonSplitAppointment(hsAppt) {
  const orgId = `salon_${hsAppt.salon_id}`;
  const split = computeStylistBusyRanges({
    startsAtIso: hsAppt.starts_at,
    endsAtIso: hsAppt.ends_at,
    appliedMinutes: hsAppt.applied_minutes || 0,
    processingMinutes: hsAppt.processing_minutes || 0,
    bufferBeforeMinutes: hsAppt.buffer_before_minutes || 0,
    bufferAfterMinutes: hsAppt.buffer_after_minutes || 0,
  });

  const segments = [];
  for (const br of split.busyRanges) {
    segments.push({
      org_id: orgId,
      booking_id: hsAppt.id,
      resource_id: hsAppt.stylist_id,
      segment_phase: br.phase === 'application_with_setup' ? 'application' : 'finishing',
      starts_at: br.starts_at,
      ends_at: br.ends_at,
      allow_double_book_in_gap: false,
      occupies_provider: true,
    });
  }
  if (split.processingGap) {
    segments.push({
      org_id: orgId,
      booking_id: hsAppt.id,
      resource_id: hsAppt.stylist_id,
      segment_phase: 'processing_gap',
      starts_at: split.processingGap.starts_at,
      ends_at: split.processingGap.ends_at,
      allow_double_book_in_gap: true,
      occupies_provider: false,
    });
  }

  const recall = computeRecallRebookingWindow({
    completedAtIso: hsAppt.ends_at,
    verticalKey: 'open-salon',
  });

  return {
    booking: {
      id: hsAppt.id,
      org_id: orgId,
      vertical_key: 'open-salon',
      calendar_mode: 'MODE_A_APPOINTMENT_CHAIR',
      booking_kind: 'appointment',
      customer_name: hsAppt.client_name || 'Salon Client',
      starts_at: hsAppt.starts_at,
      ends_at: hsAppt.ends_at,
      applied_minutes: hsAppt.applied_minutes || 0,
      processing_minutes: hsAppt.processing_minutes || 0,
      buffer_before_minutes: hsAppt.buffer_before_minutes || 0,
      buffer_after_minutes: hsAppt.buffer_after_minutes || 0,
      allow_double_book_in_gap: split.isSplitTime,
      recall_interval_days: recall.recall_weeks * 7,
      recommended_rebook_date: recall.recommended_date,
    },
    segments,
    split_analysis: split,
  };
}

module.exports = {
  OPENSALON_DOMAIN_IP_PRESERVED,
  OPENSALON_SHARED_MODULE_REPLACEMENTS,
  buildOpenSalonModuleMigrationPlan,
  adaptOpenSalonSplitAppointment,
};
