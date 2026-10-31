/**
 * SEO, Schema.org Vertical JSON-LD Graph, /llms.txt & /sitemap.xml Emitters
 * (@openscaffold/website v2.0)
 */

const VERTICAL_SCHEMA_TYPES = Object.freeze({
  'real-estate': 'RealEstateAgent',
  realestate: 'RealEstateAgent',
  brokerage: 'RealEstateAgent',
  restaurant: 'Restaurant',
  caterer: 'FoodEstablishment',
  golf: 'GolfCourse',
  dentist: 'Dentist',
  salon: 'HairSalon',
  chiro: 'MedicalClinic',
  cpa: 'AccountingService',
  law: 'LegalService',
  landscape: 'HomeAndConstructionBusiness',
  service: 'HomeAndConstructionBusiness',
  architect: 'ProfessionalService',
  interior: 'InteriorDesignBusiness',
  church: 'Church',
  hoa: 'Organization',
  firehouse: 'FireStation',
  developer: 'RealEstateAgent',
  plants: 'GardenStore',
});

function resolveVerticalSchemaType(vertical = '') {
  const key = String(vertical || '').toLowerCase();
  for (const [k, schemaType] of Object.entries(VERTICAL_SCHEMA_TYPES)) {
    if (key.includes(k)) return schemaType;
  }
  return 'LocalBusiness';
}

function emitVerticalSchemaGraph(siteData = {}, options = {}) {
  const settings = siteData.settings || {};
  const vertical = options.vertical || settings.vertical || settings.theme || '';
  const primaryType = resolveVerticalSchemaType(vertical);
  const name = settings.site_name || settings.brandName || 'Business';
  const baseUrl = options.baseUrl || (settings.custom_domain ? `https://${settings.custom_domain}` : '');

  const primaryEntity = {
    '@context': 'https://schema.org',
    '@type': primaryType,
    name,
    ...(settings.tagline ? { slogan: settings.tagline } : {}),
    ...(settings.description || settings.meta_description ? { description: settings.description || settings.meta_description } : {}),
    ...(baseUrl ? { url: baseUrl } : {}),
    ...(settings.logo_url ? { logo: settings.logo_url } : {}),
    ...(settings.contact_phone ? { telephone: settings.contact_phone } : {}),
    ...(settings.contact_email ? { email: settings.contact_email } : {}),
    ...(settings.contact_address ? { address: settings.contact_address } : {}),
    potentialAction: {
      '@type': primaryType === 'Restaurant' || primaryType === 'GolfCourse' || primaryType === 'Dentist' ? 'ReserveAction' : 'CommunicateAction',
      target: `${baseUrl || ''}/book`,
    },
  };

  const graphs = [primaryEntity];

  // Add Menu graph if live menu items are present
  const menuItems = Array.isArray(siteData.menuItems)
    ? siteData.menuItems.filter((item) => !item.is_86d && !item.eightySixed)
    : [];
  if (menuItems.length > 0) {
    graphs.push({
      '@context': 'https://schema.org',
      '@type': 'Menu',
      name: `${name} Live Menu`,
      hasMenuItem: menuItems.map((item) => ({
        '@type': 'MenuItem',
        name: item.name,
        description: item.description || '',
        offers: item.price ? { '@type': 'Offer', price: String(item.price).replace(/[^0-9.]/g, ''), priceCurrency: 'USD' } : undefined,
      })),
    });
  }

  // Add RealEstateListing graph if active property listings are present
  const listings = Array.isArray(siteData.listings) ? siteData.listings : [];
  if (listings.length > 0) {
    for (const listing of listings) {
      graphs.push({
        '@context': 'https://schema.org',
        '@type': 'RealEstateListing',
        name: listing.address || listing.title,
        description: listing.summary || listing.description || '',
        ...(listing.price ? { offers: { '@type': 'Offer', price: String(listing.price).replace(/[^0-9.]/g, ''), priceCurrency: 'USD' } } : {}),
      });
    }
  }

  // Add FAQPage graph if FAQs exist
  const faqs = Array.isArray(siteData.faqs) ? siteData.faqs : [];
  if (faqs.length > 0) {
    graphs.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: f.answer,
        },
      })),
    });
  }

  return graphs;
}

function generateLlmsTxt(siteData = {}, options = {}) {
  const settings = siteData.settings || {};
  const name = settings.site_name || settings.brandName || 'Organization';
  const tagline = settings.tagline || '';
  const description = settings.description || settings.about_text || '';
  const services = Array.isArray(settings.services) ? settings.services : [];
  const menuItems = Array.isArray(siteData.menuItems)
    ? siteData.menuItems.filter((i) => !i.is_86d && !i.eightySixed)
    : [];
  const listings = Array.isArray(siteData.listings) ? siteData.listings : [];
  const baseUrl = options.baseUrl || (settings.custom_domain ? `https://${settings.custom_domain}` : '');

  const lines = [
    `# ${name}`,
    tagline ? `> ${tagline}` : '',
    '',
    description ? description : '',
    '',
    '## Direct Actions & Contact (Zero-Middleman Official Channels)',
    settings.contact_phone ? `- Phone: ${settings.contact_phone}` : '',
    settings.contact_email ? `- Email: ${settings.contact_email}` : '',
    settings.contact_address ? `- Address: ${settings.contact_address}` : '',
    `- Direct Online Booking / Inquiry: ${baseUrl}/book`,
    `- Contact & Lead Form: ${baseUrl}/contact`,
  ].filter(Boolean);

  if (services.length > 0) {
    lines.push('', '## Services & Offerings');
    for (const s of services) {
      const label = typeof s === 'string' ? s : `${s.name || s.title}${s.price ? ` (${s.price})` : ''}: ${s.description || ''}`;
      lines.push(`- ${label}`);
    }
  }

  if (listings.length > 0) {
    lines.push('', '## Active Brokerage Property Listings & 360° Tours');
    for (const l of listings) {
      lines.push(`- ${l.address || l.title}${l.price ? ` — ${l.price}` : ''}${l.bedsBaths ? ` (${l.bedsBaths})` : ''}${l.status ? ` [${l.status}]` : ''}`);
    }
  }

  if (menuItems.length > 0) {
    lines.push('', '## Live Available Menu Items (Real-Time Kitchen Sync)');
    for (const m of menuItems) {
      lines.push(`- ${m.name}${m.price ? ` — ${m.price}` : ''}${m.description ? `: ${m.description}` : ''}`);
    }
  }

  return lines.join('\n') + '\n';
}

function generateSitemapXml(siteData = {}, options = {}) {
  const settings = siteData.settings || {};
  const baseUrl = (options.baseUrl || (settings.custom_domain ? `https://${settings.custom_domain}` : 'https://example.openscaffold.site')).replace(/\/$/, '');
  const slugs = ['', 'about', 'services', 'portfolio', 'blog', 'testimonials', 'contact', 'book'];
  const customPages = Array.isArray(siteData.pages) ? siteData.pages.map((p) => `page/${p.slug}`) : [];
  const allPaths = [...slugs, ...customPages];

  const urls = allPaths.map((p) => `  <url><loc>${baseUrl}/${p}</loc><changefreq>daily</changefreq></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

module.exports = {
  VERTICAL_SCHEMA_TYPES,
  resolveVerticalSchemaType,
  emitVerticalSchemaGraph,
  generateLlmsTxt,
  generateSitemapXml,
};
