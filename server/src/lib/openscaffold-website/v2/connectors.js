/**
 * 8 Live Zero-Double-Entry @openscaffold/* App Data Connectors
 * (@openscaffold/website v2.0)
 *
 * Bridges the public website directly to the tenant's live operational modules:
 * 1. @openscaffold/scheduling (Mode A-G live slots, tee times, dining turns)
 * 2. @openscaffold/menu (live menus, wine lists, automatic real-time 86'd filter)
 * 3. @openscaffold/billing + @openscaffold/shop + @openscaffold/gift-cards (Mode A0 direct checkout & $0.20 ACH)
 * 4. @openscaffold/crm + @openscaffold/messaging (lead capture -> CRM household/deal + bot notification)
 * 5. @openscaffold/tour (360° virtual tours + completed job-to-portfolio promotion)
 * 6. @openscaffold/ticketing (zero-fee community/parish/venue events)
 * 7. @openscaffold/documents (public HOA CC&Rs, weekly bulletins, board packets)
 * 8. @openscaffold/esign (digital client/patient intake packets)
 */

const LIVE_CONNECTOR_MANIFEST = Object.freeze([
  {
    id: 'scheduling',
    module: '@openscaffold/scheduling',
    description: 'Real-time appointment chairs (Mode A), dining table turns (Mode B), 8-min golf tee times (Mode C), and room/amenity booking (Mode F).',
  },
  {
    id: 'menu',
    module: '@openscaffold/menu',
    description: 'Live categorized menus, wine pairings, allergen matrices, and instant 0ms hiding of 86\'d kitchen items.',
  },
  {
    id: 'billing_shop',
    module: '@openscaffold/billing + @openscaffold/shop + @openscaffold/gift-cards',
    description: 'Zero-markup Stripe Connect Mode A0 checkout, flat $0.20 wholesale ACH dues/giving/deposits, and gift card issuance.',
  },
  {
    id: 'crm_messaging',
    module: '@openscaffold/crm + @openscaffold/messaging',
    description: 'Direct website quote/contact intake into the CRM pipeline plus consent-safe notification to the vertical assistant.',
  },
  {
    id: 'tour_portfolio',
    module: '@openscaffold/tour',
    description: 'Embedded 360° equirectangular walkthroughs on Cloudflare R2 ($0 egress) and 1-click completed job-to-portfolio promotion.',
  },
  {
    id: 'ticketing',
    module: '@openscaffold/ticketing',
    description: 'Zero-markup community, parish, fire department, and venue event passes with upfront all-in pricing.',
  },
  {
    id: 'documents',
    module: '@openscaffold/documents',
    description: 'SHA-256 verified public documents vault for HOA CC&Rs, weekly church bulletins, and municipal/board packets.',
  },
  {
    id: 'esign',
    module: '@openscaffold/esign',
    description: 'Tamper-evident digital onboarding, consent, and client/patient intake packets.',
  },
]);

function listLiveConnectors() {
  return LIVE_CONNECTOR_MANIFEST;
}

/**
 * Pulls live operational data across the 8 connectors (falling back gracefully
 * when a vertical only uses a subset of tables).
 */
async function resolveLiveConnectorData(pool, prefix = '', adapters = {}) {
  const state = {
    menuItems: [],
    slots: [],
    teeTimes: [],
    portfolio: [],
    tours360: [],
    listings: [],
    events: [],
    documents: [],
    products: [],
    connectorsActive: [],
  };

  if (adapters.menuItems) {
    const raw = typeof adapters.menuItems === 'function' ? await adapters.menuItems(pool, prefix) : adapters.menuItems;
    state.menuItems = Array.isArray(raw) ? raw.filter((item) => !item.is_86d && !item.eightySixed) : [];
    state.connectorsActive.push('menu');
  }

  if (adapters.slots) {
    const raw = typeof adapters.slots === 'function' ? await adapters.slots(pool, prefix) : adapters.slots;
    state.slots = Array.isArray(raw) ? raw : [];
    state.connectorsActive.push('scheduling');
  }

  if (adapters.teeTimes) {
    const raw = typeof adapters.teeTimes === 'function' ? await adapters.teeTimes(pool, prefix) : adapters.teeTimes;
    state.teeTimes = Array.isArray(raw) ? raw : [];
    if (!state.connectorsActive.includes('scheduling')) state.connectorsActive.push('scheduling');
  }

  if (adapters.listings) {
    const raw = typeof adapters.listings === "function" ? await adapters.listings(pool, prefix) : adapters.listings;
    state.listings = Array.isArray(raw) ? raw : [];
    if (!state.connectorsActive.includes("tour_portfolio")) state.connectorsActive.push("tour_portfolio");
  }

  if (adapters.tours360) {
    const raw = typeof adapters.tours360 === 'function' ? await adapters.tours360(pool, prefix) : adapters.tours360;
    state.tours360 = Array.isArray(raw) ? raw : [];
    state.connectorsActive.push('tour_portfolio');
  }

  if (adapters.events) {
    const raw = typeof adapters.events === 'function' ? await adapters.events(pool, prefix) : adapters.events;
    state.events = Array.isArray(raw) ? raw : [];
    state.connectorsActive.push('ticketing');
  }

  if (adapters.documents) {
    const raw = typeof adapters.documents === 'function' ? await adapters.documents(pool, prefix) : adapters.documents;
    state.documents = Array.isArray(raw) ? raw : [];
    state.connectorsActive.push('documents');
  }

  if (adapters.products) {
    const raw = typeof adapters.products === 'function' ? await adapters.products(pool, prefix) : adapters.products;
    state.products = Array.isArray(raw) ? raw : [];
    state.connectorsActive.push('billing_shop');
  }

  return state;
}

/**
 * Routes a website contact/lead or booking submission into @openscaffold/crm
 * and @openscaffold/scheduling instead of leaving it stranded in a dead-end table.
 */
async function dispatchLeadOrBookingToConnectors({ kind = 'lead', payload = {}, adapters = {} } = {}) {
  const events = [];
  if (kind === 'booking' && typeof adapters.onBookingCreated === 'function') {
    const res = await adapters.onBookingCreated(payload);
    events.push({ connector: 'scheduling', result: res });
  }
  if (typeof adapters.onLeadCaptured === 'function') {
    const res = await adapters.onLeadCaptured({ kind, ...payload });
    events.push({ connector: 'crm_messaging', result: res });
  }
  return {
    routed: true,
    kind,
    events,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  LIVE_CONNECTOR_MANIFEST,
  listLiveConnectors,
  resolveLiveConnectorData,
  dispatchLeadOrBookingToConnectors,
};
