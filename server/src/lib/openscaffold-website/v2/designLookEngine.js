/**
 * @openscaffold/design v1.2.0 Integration for @openscaffold/website v2.0
 *
 * Implements the 4 official OSL Curated Looks (OS_LOOKS: warm-editorial,
 * clinical-light, midnight, high-contrast) + Settings › Branding deriveTheme
 * so any tenant's website automatically inherits their workspace branding with
 * zero duplicate setup and guaranteed WCAG AA (4.5:1+) text contrast.
 */

const { contrast, textOn } = require('../a11y');

const OS_LOOKS = Object.freeze({
  'warm-editorial': {
    id: 'warm-editorial',
    label: 'Open Scaffold Classic',
    pageBg: '#e7d9c1',
    cardBg: '#fbf7ef',
    railBg: '#1f2b22',
    railText: '#fbf7ef',
    railHeading: '#c9ab66',
    ink: '#1f2b22',
    muted: '#535e54',
    accent: '#1f2b22',
    accentSecondary: '#c9ab66',
    border: '#d5c5a8',
    fontHeading: 'Newsreader',
    fontBody: 'Source Sans 3',
  },
  'clinical-light': {
    id: 'clinical-light',
    label: 'Clinical Light',
    pageBg: '#f8fafc',
    cardBg: '#ffffff',
    railBg: '#0f172a',
    railText: '#f8fafc',
    railHeading: '#38bdf8',
    ink: '#0f172a',
    muted: '#475569',
    accent: '#0369a1',
    accentSecondary: '#0284c7',
    border: '#e2e8f0',
    fontHeading: 'Source Sans 3',
    fontBody: 'Source Sans 3',
  },
  midnight: {
    id: 'midnight',
    label: 'Midnight Dark',
    pageBg: '#0b1220',
    cardBg: '#121c2e',
    railBg: '#070c16',
    railText: '#f1f5f9',
    railHeading: '#c9ab66',
    ink: '#f8fafc',
    muted: '#94a3b8',
    accent: '#c9ab66',
    accentSecondary: '#38bdf8',
    border: '#1e293b',
    fontHeading: 'Newsreader',
    fontBody: 'Source Sans 3',
  },
  'high-contrast': {
    id: 'high-contrast',
    label: 'High Contrast',
    pageBg: '#ffffff',
    cardBg: '#ffffff',
    railBg: '#000000',
    railText: '#ffffff',
    railHeading: '#ffff00',
    ink: '#000000',
    muted: '#1f2937',
    accent: '#0000ee',
    accentSecondary: '#000000',
    border: '#000000',
    fontHeading: 'Source Sans 3',
    fontBody: 'Source Sans 3',
  },
});

function listOfficialLooks() {
  return Object.values(OS_LOOKS);
}

function resolveOfficialLook(lookId) {
  if (!lookId) return OS_LOOKS['warm-editorial'];
  const key = String(lookId).trim().toLowerCase();
  if (OS_LOOKS[key]) return OS_LOOKS[key];
  if (key === 'dark') return OS_LOOKS.midnight;
  if (key === 'light' || key === 'clinical') return OS_LOOKS['clinical-light'];
  if (key === 'earthy' || key === 'earthy-light' || key === 'classic') return OS_LOOKS['warm-editorial'];
  return OS_LOOKS['warm-editorial'];
}

/**
 * Derives a complete, WCAG AA-safe website token set from an organization's
 * Settings › Branding colors + chosen lookId.
 */
function deriveWebsiteTheme(settings = {}) {
  const look = resolveOfficialLook(settings.look_id || settings.lookId || settings.color_theme || settings.theme);
  const customPrimary = settings.primary_color || settings.primaryColor;
  const customSecondary = settings.secondary_color || settings.secondaryColor;

  const accent = customPrimary && customPrimary !== '#4F46E5' ? customPrimary : look.accent;
  const accentSecondary = customSecondary && customSecondary !== '#1B3A5C' ? customSecondary : look.accentSecondary;
  const buttonText = textOn(accent);
  const heroBg = look.id === 'midnight' || look.id === 'high-contrast' ? look.railBg : (customPrimary && customPrimary !== '#4F46E5' ? customPrimary : look.railBg);
  const heroText = textOn(heroBg);

  return {
    lookId: look.id,
    lookLabel: look.label,
    pageBg: look.pageBg,
    cardBg: look.cardBg,
    railBg: look.railBg,
    railText: look.railText,
    railHeading: look.railHeading,
    ink: look.ink,
    muted: look.muted,
    accent,
    accentSecondary,
    buttonText,
    heroBg,
    heroText,
    border: look.border,
    fontHeading: settings.font_heading || settings.headingFont || look.fontHeading,
    fontBody: settings.font_body || settings.bodyFont || look.fontBody,
    wcagContrastRatio: Number(contrast(look.ink, look.cardBg).toFixed(2)),
  };
}

function renderDerivedLookCss(settings = {}) {
  const t = deriveWebsiteTheme(settings);
  return `:root, [data-os-look="${t.lookId}"] {
    --os-bg: ${t.pageBg};
    --os-card: ${t.cardBg};
    --os-rail: ${t.railBg};
    --os-rail-text: ${t.railText};
    --os-rail-heading: ${t.railHeading};
    --os-ink: ${t.ink};
    --os-muted: ${t.muted};
    --os-accent: ${t.accent};
    --os-accent-secondary: ${t.accentSecondary};
    --os-btn-text: ${t.buttonText};
    --os-hero-bg: ${t.heroBg};
    --os-hero-text: ${t.heroText};
    --os-border: ${t.border};
    --os-font-display: '${t.fontHeading}', Georgia, serif;
    --os-font-sans: '${t.fontBody}', -apple-system, BlinkMacSystemFont, sans-serif;
  }`;
}

module.exports = {
  OS_LOOKS,
  listOfficialLooks,
  resolveOfficialLook,
  deriveWebsiteTheme,
  renderDerivedLookCss,
};
