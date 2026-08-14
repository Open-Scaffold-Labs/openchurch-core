// Shared Tailwind class maps for the five canonical liturgical
// colors. These are the SAME hues a printed liturgical calendar
// uses (not the Parchment & Brass brand palette) — Purple for Lent /
// Advent, White for Christmas / Easter, Red for Pentecost / Holy
// Week, Green for Ordinary Time, Gold for high feasts where the
// rubrics allow it.
//
// Hoisted out of Events.jsx so Schedule (event modal + grid tiles)
// and Clients (member-profile feast-day tag) can reuse without
// drift. Any change here propagates to every surface.

// Canonical ordered list — drives admin-UI dropdowns. Order matches
// how a typical liturgical year is taught (Ordinary/feast → solemn →
// gold) rather than alphabetical, so the default 'White' lands first.
// Server-side validation in routes/parishFeasts.js mirrors this set.
export const LIT_COLORS = ['White', 'Red', 'Green', 'Purple', 'Gold']

// The "no liturgical colour recorded" dot. NOT a liturgical hue — it is
// the absence of one, so it belongs to the brand palette rather than the
// canonical set. Call sites used to spell this `?? 'bg-gray-300'` inline,
// which put a cool Tailwind grey on eleven surfaces and made the empty
// state look like a sixth liturgical colour.
export const LIT_COLOR_DOT_NONE = 'bg-parchment-300 dark:bg-ink-600'

// Small filled dot for color-coding tags / chips.
export const LIT_COLOR_DOT = {
  Purple: 'bg-purple-500',
  White:  'bg-gray-100 border border-gray-300',
  Green:  'bg-emerald-500',
  Red:    'bg-red-500',
  Gold:   'bg-yellow-400',
}

// Combined text + tinted background + matching border. Reads as a
// soft chip; legible on parchment surfaces in light and on ink in
// dark.
export const LIT_COLOR_TEXT = {
  Purple: 'text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/20 border-purple-100 dark:border-purple-800/30',
  White:  'text-ink-600 dark:text-parchment-200 bg-parchment-100 dark:bg-ink-800 border-parchment-300/70 dark:border-brass-900/40',
  Green:  'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-800/30',
  Red:    'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-800/30',
  Gold:   'text-yellow-700 dark:text-yellow-300 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-100 dark:border-yellow-800/30',
}

// Left-edge stripe per color. The row/tile scans as a liturgical-
// year stripe at a glance: purple for Lent/Advent, white for Easter
// and Christmas, red for Pentecost and Holy Week, green for
// Ordinary Time.
export const LIT_COLOR_STRIPE = {
  Purple: 'border-l-purple-500',
  White:  'border-l-stone-300 dark:border-l-parchment-300/40',
  Green:  'border-l-emerald-500',
  Red:    'border-l-red-500',
  Gold:   'border-l-yellow-400',
}
