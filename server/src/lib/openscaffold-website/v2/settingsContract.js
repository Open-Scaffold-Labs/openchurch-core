/**
 * Unified Client <-> Server Settings & Multi-Tenant Contract (@openscaffold/website v2.0)
 *
 * Fixes the v1.0 mismatch where WebsiteManager.jsx sent camelCase POST requests
 * (brandName, heroHeadline, primaryColor, businessHours object, featureToggles)
 * while routes.js expected snake_case PUT requests (site_name, hero_headline,
 * primary_color, business_hours array, show_*) and hardcoded WHERE id = 1.
 */

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function defaultBusinessHoursObject() {
  const hours = {};
  for (const day of WEEKDAYS) {
    hours[`${day}_open`] = '09:00';
    hours[`${day}_close`] = '17:00';
  }
  return hours;
}

function normalizeBusinessHoursToObject(input) {
  const base = defaultBusinessHoursObject();
  if (!input) return base;
  if (Array.isArray(input)) {
    for (const row of input) {
      if (!row || typeof row !== 'object') continue;
      const day = WEEKDAYS.find(
        (d) => d.toLowerCase() === String(row.day || '').trim().toLowerCase()
      );
      if (!day) continue;
      if (row.open) base[`${day}_open`] = row.open;
      if (row.close) base[`${day}_close`] = row.close;
      if (typeof row.closed === 'boolean') base[`${day}_closed`] = row.closed;
    }
    return base;
  }
  if (typeof input === 'object') {
    return { ...base, ...input };
  }
  return base;
}

function normalizeBusinessHoursToArray(input) {
  const obj = normalizeBusinessHoursToObject(input);
  return WEEKDAYS.map((day) => ({
    day,
    open: obj[`${day}_open`] || '09:00',
    close: obj[`${day}_close`] || '17:00',
    closed: Boolean(obj[`${day}_closed`]),
  }));
}

function pickDefined(...values) {
  for (const val of values) {
    if (val !== undefined) return val;
  }
  return undefined;
}

/**
 * Normalizes any incoming settings payload (camelCase, snake_case, or mixed)
 * into canonical snake_case columns for Postgres storage.
 */
function normalizeSettingsInput(body = {}, options = {}) {
  const src = body && typeof body === 'object' ? body : {};
  const toggles = src.featureToggles && typeof src.featureToggles === 'object' ? src.featureToggles : {};
  const social = src.socialLinks && typeof src.socialLinks === 'object' ? src.socialLinks : {};

  const hoursRaw = pickDefined(src.business_hours, src.businessHours);
  const normalizedHours = hoursRaw !== undefined ? normalizeBusinessHoursToArray(hoursRaw) : undefined;

  return {
    tenant_key: pickDefined(src.tenant_key, src.tenantKey, options.tenantKey, null),
    site_name: pickDefined(src.site_name, src.brandName, src.siteName),
    tagline: pickDefined(src.tagline),
    description: pickDefined(src.description),
    logo_url: pickDefined(src.logo_url, src.logoUrl),
    hero_headline: pickDefined(src.hero_headline, src.heroHeadline),
    hero_subheadline: pickDefined(src.hero_subheadline, src.heroSubheadline),
    hero_image_url: pickDefined(src.hero_image_url, src.heroImage, src.heroImageUrl),
    hero_cta_text: pickDefined(src.hero_cta_text, src.heroCta, src.heroCtaText),
    hero_cta_link: pickDefined(src.hero_cta_link, src.heroCtaLink),
    about_title: pickDefined(src.about_title, src.aboutTitle),
    about_text: pickDefined(src.about_text, src.about, src.aboutText),
    about_image_url: pickDefined(src.about_image_url, src.aboutImage, src.aboutImageUrl),
    primary_color: pickDefined(src.primary_color, src.primaryColor),
    secondary_color: pickDefined(src.secondary_color, src.secondaryColor),
    accent_color: pickDefined(src.accent_color, src.accentColor),
    font_heading: pickDefined(src.font_heading, src.headingFont, src.fontHeading),
    font_body: pickDefined(src.font_body, src.bodyFont, src.fontBody),
    contact_email: pickDefined(src.contact_email, src.contactEmail),
    contact_phone: pickDefined(src.contact_phone, src.contactPhone),
    contact_address: pickDefined(src.contact_address, src.contactAddress),
    social_instagram: pickDefined(src.social_instagram, social.instagram, src.socialInstagram),
    social_facebook: pickDefined(src.social_facebook, social.facebook, src.socialFacebook),
    social_linkedin: pickDefined(src.social_linkedin, social.linkedin, src.socialLinkedin),
    social_twitter: pickDefined(src.social_twitter, social.twitter, src.socialTwitter),
    social_youtube: pickDefined(src.social_youtube, social.youtube, src.socialYoutube),
    meta_title: pickDefined(src.meta_title, src.seoTitle, src.metaTitle),
    meta_description: pickDefined(src.meta_description, src.seoDescription, src.metaDescription),
    google_analytics_id: pickDefined(src.google_analytics_id, src.googleAnalyticsId),
    services: Array.isArray(src.services) ? src.services : undefined,
    business_hours: normalizedHours,
    team_members: Array.isArray(src.team_members || src.teamMembers)
      ? (src.team_members || src.teamMembers)
      : undefined,
    theme: pickDefined(src.theme),
    look_id: pickDefined(src.look_id, src.lookId, src.color_theme, src.colorTheme),
    color_theme: pickDefined(src.color_theme, src.colorTheme, src.look_id, src.lookId),
    publication_state: pickDefined(src.publication_state, src.publicationState),
    custom_domain: pickDefined(src.custom_domain, src.customDomain),
    is_published: pickDefined(src.is_published, src.isPublished),
    show_testimonials: pickDefined(src.show_testimonials, toggles.showTestimonials, src.showTestimonials),
    show_blog: pickDefined(src.show_blog, toggles.showBlog, src.showBlog),
    show_booking: pickDefined(src.show_booking, toggles.showBooking, src.showBooking),
    show_portfolio: pickDefined(src.show_portfolio, toggles.showPortfolio, src.showPortfolio),
    booking_url: pickDefined(src.booking_url, src.bookingUrl),
    booking_instructions: pickDefined(src.booking_instructions, src.bookingInstructions),
    custom_css: pickDefined(src.custom_css, src.customCss),
    sections: Array.isArray(src.sections) ? src.sections : undefined,
  };
}

/**
 * Formats a database settings row so BOTH snake_case server consumers AND
 * camelCase React client consumers (WebsiteManager.jsx & WebsiteStudio.jsx)
 * receive every expected property without per-vertical shim files.
 */
function formatSettingsDualContract(row = {}) {
  if (!row || typeof row !== 'object' || Object.keys(row).length === 0) {
    return {};
  }
  const hoursObj = normalizeBusinessHoursToObject(row.business_hours || row.businessHours);
  const hoursArr = normalizeBusinessHoursToArray(row.business_hours || row.businessHours);

  return {
    ...row,
    // snake_case canonical
    site_name: row.site_name ?? row.brandName ?? '',
    hero_headline: row.hero_headline ?? row.heroHeadline ?? '',
    hero_subheadline: row.hero_subheadline ?? row.heroSubheadline ?? '',
    hero_image_url: row.hero_image_url ?? row.heroImage ?? '',
    hero_cta_text: row.hero_cta_text ?? row.heroCta ?? 'Get Started',
    about_text: row.about_text ?? row.about ?? '',
    primary_color: row.primary_color ?? row.primaryColor ?? '#1f2b22',
    secondary_color: row.secondary_color ?? row.secondaryColor ?? '#c9ab66',
    accent_color: row.accent_color ?? row.accentColor ?? '#2e5a3c',
    font_heading: row.font_heading ?? row.headingFont ?? 'Newsreader',
    font_body: row.font_body ?? row.bodyFont ?? 'Source Sans 3',
    contact_email: row.contact_email ?? row.contactEmail ?? '',
    contact_phone: row.contact_phone ?? row.contactPhone ?? '',
    contact_address: row.contact_address ?? row.contactAddress ?? '',
    meta_title: row.meta_title ?? row.seoTitle ?? '',
    meta_description: row.meta_description ?? row.seoDescription ?? '',
    business_hours: hoursArr,
    team_members: Array.isArray(row.team_members) ? row.team_members : (Array.isArray(row.teamMembers) ? row.teamMembers : []),
    services: Array.isArray(row.services) ? row.services : [],
    // camelCase client contract
    brandName: row.site_name ?? row.brandName ?? '',
    logoUrl: row.logo_url ?? row.logoUrl ?? '',
    heroHeadline: row.hero_headline ?? row.heroHeadline ?? '',
    heroSubheadline: row.hero_subheadline ?? row.heroSubheadline ?? '',
    heroImage: row.hero_image_url ?? row.heroImage ?? '',
    heroCta: row.hero_cta_text ?? row.heroCta ?? 'Get Started',
    heroCtaLink: row.hero_cta_link ?? row.heroCtaLink ?? '#book',
    aboutTitle: row.about_title ?? row.aboutTitle ?? '',
    about: row.about_text ?? row.about ?? '',
    aboutImage: row.about_image_url ?? row.aboutImage ?? '',
    primaryColor: row.primary_color ?? row.primaryColor ?? '#1f2b22',
    secondaryColor: row.secondary_color ?? row.secondaryColor ?? '#c9ab66',
    accentColor: row.accent_color ?? row.accentColor ?? '#2e5a3c',
    headingFont: row.font_heading ?? row.headingFont ?? 'Newsreader',
    bodyFont: row.font_body ?? row.bodyFont ?? 'Source Sans 3',
    contactEmail: row.contact_email ?? row.contactEmail ?? '',
    contactPhone: row.contact_phone ?? row.contactPhone ?? '',
    contactAddress: row.contact_address ?? row.contactAddress ?? '',
    seoTitle: row.meta_title ?? row.seoTitle ?? '',
    seoDescription: row.meta_description ?? row.seoDescription ?? '',
    businessHours: hoursObj,
    teamMembers: Array.isArray(row.team_members) ? row.team_members : (Array.isArray(row.teamMembers) ? row.teamMembers : []),
    socialLinks: {
      instagram: row.social_instagram ?? row.socialLinks?.instagram ?? '',
      facebook: row.social_facebook ?? row.socialLinks?.facebook ?? '',
      linkedin: row.social_linkedin ?? row.socialLinks?.linkedin ?? '',
      twitter: row.social_twitter ?? row.socialLinks?.twitter ?? '',
      youtube: row.social_youtube ?? row.socialLinks?.youtube ?? '',
    },
    featureToggles: {
      showTestimonials: row.show_testimonials ?? true,
      showBlog: row.show_blog ?? true,
      showBooking: row.show_booking ?? true,
      showPortfolio: row.show_portfolio ?? true,
    },
  };
}

module.exports = {
  WEEKDAYS,
  defaultBusinessHoursObject,
  normalizeBusinessHoursToObject,
  normalizeBusinessHoursToArray,
  normalizeSettingsInput,
  formatSettingsDualContract,
};
