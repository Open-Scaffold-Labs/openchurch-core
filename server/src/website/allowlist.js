// OC-WEB-1 PR-C — parish v1 block allowlist.
//
// Dale #342 (2026-10-29): hero, Mass & Confession times, bulletin/documents,
// events, giving, location/hours/map, clergy & staff, FAQ.
// Deferred: 360° tour, event ticketing, lead capture, and the rest of the
// 18-block Dale catalog. Giving is display/link only (payments ON HOLD).

export const OC_V1_BLOCK_TYPES = Object.freeze([
  'hero_split',
  'mass_confession_times',
  'public_documents_vault',
  'parish_events',
  'donation_dues_portal',
  'location_hours_map',
  'team_roster_grid',
  'faq_accordion',
])

export const OC_V1_BLOCK_SET = new Set(OC_V1_BLOCK_TYPES)

// Dale catalog ids that map 1:1 onto an OC allowlisted type.
export const DALE_TO_OC_BLOCK = Object.freeze({
  hero_split: 'hero_split',
  public_documents_vault: 'public_documents_vault',
  donation_dues_portal: 'donation_dues_portal',
  location_hours_map: 'location_hours_map',
  team_roster_grid: 'team_roster_grid',
  faq_accordion: 'faq_accordion',
})

// Explicitly rejected for v1 (product + Atlas OUT list).
export const OC_V1_BLOCK_REJECTED = Object.freeze([
  'virtual_tour_360',
  'event_ticketing_calendar',
  'lead_capture_crm',
  'tee_sheet_widget',
  'live_menu_grid',
  'live_booking_widget',
  'shop_gift_cards',
  'catering_beo_inquiry',
  'esign_intake_portal',
  'before_after_gallery',
  'services_pricing_matrix',
  'testimonials_reviews',
])

export function isAllowedBlockType(type) {
  return typeof type === 'string' && OC_V1_BLOCK_SET.has(type)
}

export const DEFAULT_LOOK_ID = 'warm-editorial'

// Admin-chosen looks from Dale's designLookEngine. Visitors do not pick a
// look — they only get a high-contrast accessibility toggle (client-side).
export const OC_ADMIN_LOOK_IDS = Object.freeze([
  'warm-editorial',
  'clinical-light',
  'midnight',
  'high-contrast',
])

export function isAllowedLookId(lookId) {
  return typeof lookId === 'string' && OC_ADMIN_LOOK_IDS.includes(lookId)
}
