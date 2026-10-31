/**
 * 18 Composable Vertical Section Blocks (@openscaffold/website v2.0)
 *
 * Replaces the v1.0 3-tag (<p>, <h2>, <img>) renderer in publicSite.js with
 * 18 rich, connector-aware vertical blocks that render clean, accessible HTML
 * styled by @openscaffold/design v1.2.0 CSS variables.
 */

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SECTION_BLOCK_CATALOG = Object.freeze([
  { id: 'hero_split', label: 'Editorial Split Hero & Trust Strip', category: 'core', module: '@openscaffold/design' },
  { id: 'live_booking_widget', label: 'Live Appointment, Chair & Table Booking', category: 'commerce', module: '@openscaffold/scheduling' },
  { id: 'live_menu_grid', label: 'Live Menu, Wine List & 86-Filter', category: 'hospitality', module: '@openscaffold/menu' },
  { id: 'tee_sheet_widget', label: '8-Minute Golf Tee Sheet (Zero Barter)', category: 'golf', module: '@openscaffold/scheduling' },
  { id: 'before_after_gallery', label: 'Before & After Project Portfolio', category: 'field', module: '@openscaffold/tour' },
  { id: 'virtual_tour_360', label: '360° Interactive Spatial Walkthrough', category: 'spatial', module: '@openscaffold/tour' },
  { id: 'services_pricing_matrix', label: 'Service Tiers & Transparent Pricing', category: 'core', module: '@openscaffold/crm' },
  { id: 'event_ticketing_calendar', label: 'Zero-Fee Community & Venue Events', category: 'events', module: '@openscaffold/ticketing' },
  { id: 'donation_dues_portal', label: 'Online Giving, Fund Drive & Dues ($0.20 ACH)', category: 'payments', module: '@openscaffold/billing' },
  { id: 'public_documents_vault', label: 'Public Bulletins, CC&Rs & Board Packets', category: 'governance', module: '@openscaffold/documents' },
  { id: 'shop_gift_cards', label: 'Pro Shop, Retail Catalog & Instant Gift Cards', category: 'commerce', module: '@openscaffold/shop' },
  { id: 'catering_beo_inquiry', label: 'Banquet, Outing & Catering Package Builder', category: 'hospitality', module: '@openscaffold/catering' },
  { id: 'esign_intake_portal', label: 'Digital Client / Patient Intake & E-Sign', category: 'intake', module: '@openscaffold/esign' },
  { id: 'team_roster_grid', label: 'Team, Clinicians, Clergy & Leadership Roster', category: 'core', module: '@openscaffold/kernel' },
  { id: 'testimonials_reviews', label: 'Verified Client Reviews & Star Ratings', category: 'social_proof', module: '@openscaffold/website' },
  { id: 'faq_accordion', label: 'Interactive FAQ & Schema.org Answer Graph', category: 'seo', module: '@openscaffold/website' },
  { id: 'location_hours_map', label: 'Live Hours, Service Area & Directions', category: 'core', module: '@openscaffold/website' },
  { id: 'lead_capture_crm', label: 'Instant Quote & Inquiry Form (Direct to CRM)', category: 'crm', module: '@openscaffold/crm' },
]);

function listSectionBlocks() {
  return SECTION_BLOCK_CATALOG;
}

function renderSectionBlock(block = {}, liveData = {}) {
  const type = String(block.type || 'text').trim();

  // Backward-compatible v1.0 blocks
  if (type === 'text') {
    return `<p class="os-web-prose">${esc(block.content || block.text || '')}</p>`;
  }
  if (type === 'heading') {
    return `<h2 class="os-web-h2">${esc(block.content || block.title || '')}</h2>`;
  }
  if (type === 'image') {
    return `<figure class="os-web-figure"><img src="${esc(block.url || '')}" alt="${esc(block.alt || '')}" class="os-web-img" />${block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : ''}</figure>`;
  }

  switch (type) {
    case 'hero_split': {
      const badges = Array.isArray(block.badges) ? block.badges : [];
      return `<section class="os-web-block os-block-hero-split" data-block="hero_split">
        <div class="os-hero-copy">
          ${block.eyebrow ? `<span class="os-pill">${esc(block.eyebrow)}</span>` : ''}
          <h1 class="os-page-title">${esc(block.headline || block.title || '')}</h1>
          <p class="os-hero-sub">${esc(block.subheadline || block.subtitle || '')}</p>
          <div class="os-hero-actions">
            <a href="${esc(block.ctaLink || '#book')}" class="os-button os-button-primary">${esc(block.ctaText || 'Book Online')}</a>
            ${block.secondaryCtaText ? `<a href="${esc(block.secondaryCtaLink || '#contact')}" class="os-button os-button-secondary">${esc(block.secondaryCtaText)}</a>` : ''}
          </div>
          ${badges.length ? `<div class="os-trust-badges">${badges.map((b) => `<span class="os-badge-chip">${esc(b)}</span>`).join('')}</div>` : ''}
        </div>
      </section>`;
    }

    case 'live_menu_grid': {
      const allItems = Array.isArray(liveData.menuItems) ? liveData.menuItems : (Array.isArray(block.items) ? block.items : []);
      const visibleItems = allItems.filter((item) => !item.is_86d && !item.eightySixed);
      const hiddenCount = allItems.length - visibleItems.length;
      return `<section class="os-web-block os-block-menu" data-block="live_menu_grid" data-hidden-86="${hiddenCount}">
        <div class="os-block-header">
          <h2 class="os-web-h2">${esc(block.title || 'Live Seasonal Menu')}</h2>
          <span class="os-live-pill">Live Kitchen Sync · ${visibleItems.length} Available</span>
        </div>
        <div class="os-menu-grid">
          ${visibleItems.map((item) => `<article class="os-menu-card">
            <div class="os-menu-row">
              <strong>${esc(item.name)}</strong>
              <span class="os-figure">${esc(item.price || '')}</span>
            </div>
            <p>${esc(item.description || '')}</p>
            ${Array.isArray(item.dietary) && item.dietary.length ? `<div class="os-tags">${item.dietary.map((t) => `<span class="os-tag">${esc(t)}</span>`).join('')}</div>` : ''}
          </article>`).join('')}
        </div>
      </section>`;
    }

    case 'live_booking_widget': {
      const slots = Array.isArray(liveData.slots) ? liveData.slots : (Array.isArray(block.slots) ? block.slots : ['9:00 AM', '10:30 AM', '1:30 PM', '3:15 PM']);
      return `<section class="os-web-block os-block-booking" id="book" data-block="live_booking_widget">
        <h2 class="os-web-h2">${esc(block.title || 'Instant Online Booking')}</h2>
        <p>${esc(block.subtitle || 'Real-time availability synced directly with our schedule — zero middleman booking fees.')}</p>
        <div class="os-slot-grid">
          ${slots.map((s) => `<button type="button" class="os-slot-pill">${esc(typeof s === 'string' ? s : `${s.time} (${s.resource || 'Available'})`)}</button>`).join('')}
        </div>
      </section>`;
    }

    case 'tee_sheet_widget': {
      const teeTimes = Array.isArray(liveData.teeTimes) ? liveData.teeTimes : (Array.isArray(block.teeTimes) ? block.teeTimes : [
        { time: '07:28 AM', holes: 18, players: 4, rate: '$78', status: 'Available' },
        { time: '07:36 AM', holes: 18, players: 4, rate: '$78', status: 'Available' },
      ]);
      return `<section class="os-web-block os-block-tee-sheet" data-block="tee_sheet_widget">
        <div class="os-block-header">
          <h2 class="os-web-h2">${esc(block.title || 'Book Direct Tee Times (Best Rate Guaranteed)')}</h2>
          <span class="os-live-pill">8-Min Interval Live Tee Sheet · $0 Booking Fee</span>
        </div>
        <div class="os-tee-grid">
          ${teeTimes.map((t) => `<div class="os-tee-card">
            <strong>${esc(t.time)}</strong>
            <span>${esc(t.holes || 18)} Holes · Up to ${esc(t.players || 4)} Players</span>
            <span class="os-figure">${esc(t.rate)}</span>
          </div>`).join('')}
        </div>
      </section>`;
    }

    case 'before_after_gallery': {
      const projects = Array.isArray(liveData.portfolio) ? liveData.portfolio : (Array.isArray(block.projects) ? block.projects : []);
      return `<section class="os-web-block os-block-portfolio" data-block="before_after_gallery">
        <h2 class="os-web-h2">${esc(block.title || 'Featured Completed Projects')}</h2>
        <div class="os-portfolio-grid">
          ${projects.map((p) => `<article class="os-portfolio-card">
            <h3>${esc(p.title)}</h3>
            <p>${esc(p.description || '')}</p>
            ${p.location ? `<span class="os-meta">${esc(p.location)}</span>` : ''}
          </article>`).join('')}
        </div>
      </section>`;
    }

    case 'virtual_tour_360': {
      const hotspots = Array.isArray(block.hotspots) ? block.hotspots : [];
      return `<section class="os-web-block os-block-tour-360" data-block="virtual_tour_360">
        <div class="os-block-header">
          <h2 class="os-web-h2">${esc(block.title || 'Interactive 360° Spatial Walkthrough')}</h2>
          <span class="os-live-pill">360° Panorama Viewer</span>
        </div>
        <p>${esc(block.sceneName || 'Main Space Panorama')}</p>
        <div class="os-hotspot-list">
          ${hotspots.map((h) => `<span class="os-hotspot-chip">📍 ${esc(h.label || h)}</span>`).join('')}
        </div>
      </section>`;
    }

    case 'services_pricing_matrix': {
      const tiers = Array.isArray(block.tiers || liveData.services) ? (block.tiers || liveData.services) : [];
      return `<section class="os-web-block os-block-services" data-block="services_pricing_matrix">
        <h2 class="os-web-h2">${esc(block.title || 'Services & Transparent Pricing')}</h2>
        <div class="os-tier-grid">
          ${tiers.map((t) => `<article class="os-tier-card">
            <h3>${esc(t.name || t.title)}</h3>
            ${t.price ? `<div class="os-figure">${esc(t.price)}</div>` : ''}
            <p>${esc(t.description || '')}</p>
          </article>`).join('')}
        </div>
      </section>`;
    }

    case 'event_ticketing_calendar': {
      const events = Array.isArray(liveData.events) ? liveData.events : (Array.isArray(block.events) ? block.events : []);
      return `<section class="os-web-block os-block-events" data-block="event_ticketing_calendar">
        <h2 class="os-web-h2">${esc(block.title || 'Upcoming Events & Community Calendar')}</h2>
        <div class="os-event-list">
          ${events.map((ev) => `<article class="os-event-card">
            <strong>${esc(ev.title)}</strong>
            <span>${esc(ev.date || '')}</span>
            <span>${esc(ev.price || 'Free RSVP')} (All-In Price · $0 Platform Markup)</span>
          </article>`).join('')}
        </div>
      </section>`;
    }

    case 'donation_dues_portal': {
      return `<section class="os-web-block os-block-giving" data-block="donation_dues_portal">
        <h2 class="os-web-h2">${esc(block.title || 'Online Stewardship, Dues & Direct ACH Payments')}</h2>
        <p>${esc(block.description || 'Pay securely via flat $0.20 wholesale bank transfer (ACH) or card — 100% credited directly to your account ledger.')}</p>
        <a href="${esc(block.portalUrl || '/pay')}" class="os-button os-button-primary">${esc(block.ctaText || 'Pay or Give Online')}</a>
      </section>`;
    }

    case 'public_documents_vault': {
      const docs = Array.isArray(liveData.documents) ? liveData.documents : (Array.isArray(block.documents) ? block.documents : []);
      return `<section class="os-web-block os-block-documents" data-block="public_documents_vault">
        <h2 class="os-web-h2">${esc(block.title || 'Public Documents, Bulletins & Governance Packet Vault')}</h2>
        <ul class="os-doc-list">
          ${docs.map((d) => `<li class="os-doc-item">
            <a href="${esc(d.url || '#')}">${esc(d.title)}</a>
            <span class="os-doc-meta">${esc(d.category || 'PDF')} · Verified</span>
          </li>`).join('')}
        </ul>
      </section>`;
    }

    case 'shop_gift_cards': {
      const products = Array.isArray(liveData.products) ? liveData.products : (Array.isArray(block.products) ? block.products : []);
      return `<section class="os-web-block os-block-shop" data-block="shop_gift_cards">
        <h2 class="os-web-h2">${esc(block.title || 'Online Storefront & Digital Gift Cards')}</h2>
        <div class="os-shop-grid">
          ${products.map((prod) => `<article class="os-shop-card">
            <h3>${esc(prod.name)}</h3>
            <span class="os-figure">${esc(prod.price)}</span>
          </article>`).join('')}
        </div>
      </section>`;
    }

    case 'catering_beo_inquiry': {
      return `<section class="os-web-block os-block-catering" data-block="catering_beo_inquiry">
        <h2 class="os-web-h2">${esc(block.title || 'Private Events, Outings & Catering Packages')}</h2>
        <p>${esc(block.description || 'Build your custom event menu or tournament outing package with transparent per-guest pricing and $0.20 ACH milestone deposits.')}</p>
      </section>`;
    }

    case 'esign_intake_portal': {
      return `<section class="os-web-block os-block-esign" data-block="esign_intake_portal">
        <h2 class="os-web-h2">${esc(block.title || 'Secure Digital New-Client & Patient Onboarding')}</h2>
        <p>${esc(block.description || 'Complete your intake and tamper-evident e-signature packet from your phone before you arrive.')}</p>
      </section>`;
    }

    case 'team_roster_grid': {
      const members = Array.isArray(liveData.teamMembers) ? liveData.teamMembers : (Array.isArray(block.members) ? block.members : []);
      return `<section class="os-web-block os-block-team" data-block="team_roster_grid">
        <h2 class="os-web-h2">${esc(block.title || 'Meet Our Team')}</h2>
        <div class="os-team-grid">
          ${members.map((m) => `<article class="os-team-card">
            <h3>${esc(m.name)}</h3>
            <span>${esc(m.role || m.title || '')}</span>
          </article>`).join('')}
        </div>
      </section>`;
    }

    case 'testimonials_reviews': {
      const reviews = Array.isArray(liveData.testimonials) ? liveData.testimonials : (Array.isArray(block.reviews) ? block.reviews : []);
      return `<section class="os-web-block os-block-testimonials" data-block="testimonials_reviews">
        <h2 class="os-web-h2">${esc(block.title || 'What Our Community Says')}</h2>
        <div class="os-review-grid">
          ${reviews.map((r) => `<blockquote class="os-review-card">
            <p>"${esc(r.quote || r.text)}"</p>
            <footer>— ${esc(r.client_name || r.author || 'Verified Client')}</footer>
          </blockquote>`).join('')}
        </div>
      </section>`;
    }

    case 'faq_accordion': {
      const faqs = Array.isArray(block.faqs) ? block.faqs : [];
      return `<section class="os-web-block os-block-faq" data-block="faq_accordion">
        <h2 class="os-web-h2">${esc(block.title || 'Frequently Asked Questions')}</h2>
        <div class="os-faq-list">
          ${faqs.map((f) => `<details class="os-faq-item">
            <summary>${esc(f.question)}</summary>
            <p>${esc(f.answer)}</p>
          </details>`).join('')}
        </div>
      </section>`;
    }

    case 'location_hours_map': {
      return `<section class="os-web-block os-block-location" data-block="location_hours_map">
        <h2 class="os-web-h2">${esc(block.title || 'Hours, Service Area & Directions')}</h2>
        <p>${esc(block.address || liveData.address || '')}</p>
        <p>${esc(block.hoursSummary || 'Mon–Fri 8:00 AM – 6:00 PM')}</p>
      </section>`;
    }

    case 'lead_capture_crm': {
      return `<section class="os-web-block os-block-lead-crm" data-block="lead_capture_crm">
        <h2 class="os-web-h2">${esc(block.title || 'Request an Estimate or Consultation')}</h2>
        <form method="POST" action="/contact" class="os-lead-form">
          <input type="text" name="name" placeholder="Full Name" required />
          <input type="email" name="email" placeholder="Email Address" required />
          <input type="tel" name="phone" placeholder="Mobile Phone" />
          <textarea name="message" placeholder="Tell us about your project or request" required></textarea>
          <button type="submit" class="os-button os-button-primary">${esc(block.submitLabel || 'Send Request')}</button>
        </form>
      </section>`;
    }

    default:
      return `<div class="os-web-block" data-block="${esc(type)}">${esc(block.content || block.title || '')}</div>`;
  }
}

function renderPageBlocks(blocks = [], liveData = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  return blocks.map((b) => renderSectionBlock(b, liveData)).join('\n');
}

module.exports = {
  SECTION_BLOCK_CATALOG,
  listSectionBlocks,
  renderSectionBlock,
  renderPageBlocks,
};
