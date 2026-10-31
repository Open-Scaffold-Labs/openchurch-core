// Public /p/:slug page payload (OC-WEB-1 PR-C).
// Keeps site-document lookup out of the growing publicEvents.js router.

import pool from '../db.js'
import { resolvePublicBranding } from './branding.js'
import { getPublishedProjectionForOrg } from '../website/repo.js'

export async function loadPublicChurchPage(slug) {
  if (!slug || typeof slug !== 'string') return null
  const { rows } = await pool.query(
    `SELECT id, name, slug, tagline, about, service_times, address, page_published, locale,
            public_display_name, public_logo_url, public_accent_hex
       FROM ochr_organizations
      WHERE slug = $1 AND held_at IS NULL
      LIMIT 1`,
    [slug],
  )
  const org = rows[0]
  if (!org || !org.page_published) return null

  const branding = resolvePublicBranding(org)
  // published_doc only — draft never reaches anonymous visitors.
  const site = await getPublishedProjectionForOrg({
    organizationId: org.id,
    slug: org.slug,
  })

  return {
    church: { name: org.name, slug: org.slug, locale: org.locale ?? 'en' },
    page: {
      tagline: org.tagline,
      about: org.about,
      service_times: org.service_times,
      address: org.address,
    },
    branding,
    // null → client keeps the legacy 4-box render.
    site: site ?? null,
  }
}
