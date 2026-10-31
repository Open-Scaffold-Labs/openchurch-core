/**
 * Generic public-renderer checks borrowed from Open HOA's community page:
 * contrast for text on a brand color, and sample / draft / live state.
 * Skip-link markup lives in the shared HTML shell.
 */

const AA_CONTRAST = 4.5;

function channel(hex, index) {
  const raw = String(hex || '').trim().replace('#', '');
  const full = raw.length === 3
    ? raw.split('').map((c) => c + c).join('')
    : raw;
  const value = parseInt(full.slice(index * 2, index * 2 + 2), 16);
  return Number.isFinite(value) ? value : 0;
}

function linearize(value) {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const r = linearize(channel(hex, 0));
  const g = linearize(channel(hex, 1));
  const b = linearize(channel(hex, 2));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Whichever of light or dark text meets WCAG AA on `background`. */
function textOn(background, light = '#ffffff', dark = '#142018') {
  if (!background || String(background).startsWith('rgba') || String(background).startsWith('rgb')) {
    return light;
  }
  return contrast(light, background) >= AA_CONTRAST ? light : dark;
}

/**
 * sample | draft | live.
 * An explicit publication_state wins. Otherwise a published row is live.
 */
function publicationState(settings) {
  const explicit = String(settings?.publication_state || settings?.publicationState || '')
    .trim()
    .toLowerCase();
  if (explicit === 'sample' || explicit === 'preview') return 'sample';
  if (explicit === 'draft') return 'draft';
  if (explicit === 'live' || explicit === 'published') return 'live';
  return settings?.is_published ? 'live' : 'draft';
}

function publicationBanner(state, siteName, esc) {
  const name = esc(siteName || 'this business');
  if (state === 'sample') {
    return `<p class="site-state-banner" role="status">Sample preview. Not published. Example copy only. Nothing on this preview is a fact about ${name}.</p>`;
  }
  if (state === 'draft') {
    return `<p class="site-state-banner" role="status">Draft preview. This page is not on the public site yet.</p>`;
  }
  return '';
}

const SKIP_LINK_CSS = `
    .skip-link {
      position: absolute;
      left: 1rem;
      top: -4rem;
      background: #fff;
      color: #142018;
      padding: 0.5rem 1rem;
      z-index: 5;
    }
    .skip-link:focus { top: 0.5rem; }
    a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
      outline: 3px solid var(--accent, #4F46E5);
      outline-offset: 2px;
    }
    .site-state-banner {
      margin: 0;
      padding: 0.75rem 1.25rem;
      background: #3d3014;
      color: #fff8e8;
      font-size: 0.95rem;
    }
`;

module.exports = {
  AA_CONTRAST,
  contrast,
  textOn,
  publicationState,
  publicationBanner,
  SKIP_LINK_CSS,
};
