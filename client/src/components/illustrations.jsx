// Empty-state line-art illustrations — Parchment & Brass.
//
// Style:
//  - Single-color line art on transparent background
//  - currentColor strokes so the parent's `text-*` class drives the hue
//    (we render at brass-600 in light, brass-300 in dark)
//  - 1.5px stroke, no fills — keeps the engraved/woodcut feel rather
//    than flat-modern
//  - 140×96 viewBox, render at h-24 (96px) so the proportions stay
//    crisp at the size EmptyState renders them
//
// Each export is a tiny stateless component so usage looks like:
//
//   import { MembersIllustration } from '../components/illustrations'
//   <EmptyState illustration={MembersIllustration} title="No members yet" ... />
//
// EmptyState passes no props — these are pure visual elements.

const baseProps = {
  viewBox: '0 0 140 96',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '1.5',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  className: 'w-32 h-auto mx-auto',
}

// Members — open ledger / register book with three name lines and a
// small cross watermark above. Reads as "the parish roll" rather than
// "an org chart."
export function MembersIllustration() {
  return (
    <svg {...baseProps}>
      {/* small cross above */}
      <path d="M70 8v8M66 12h8" />
      {/* book spine */}
      <path d="M70 26v52" />
      {/* left page */}
      <path d="M70 26L36 30v44l34-4" />
      {/* right page */}
      <path d="M70 26l34 4v44l-34-4" />
      {/* left page lines */}
      <path d="M44 42h20M44 50h20M44 58h16" opacity="0.6" />
      {/* right page lines */}
      <path d="M76 42h20M76 50h20M76 58h16" opacity="0.6" />
      {/* table line */}
      <path d="M22 84h96" opacity="0.4" />
    </svg>
  )
}

// Schedule — calendar grid with a small bell tucked into one cell.
// The bell is the church/scheduling cue — distinct from a generic
// "events" hat tip.
export function ScheduleIllustration() {
  return (
    <svg {...baseProps}>
      {/* binding rings */}
      <path d="M52 14v8M88 14v8" />
      {/* outer frame */}
      <rect x="38" y="20" width="64" height="62" rx="3" />
      {/* header bar */}
      <path d="M38 32h64" />
      {/* grid columns */}
      <path d="M54 32v50M70 32v50M86 32v50" opacity="0.5" />
      {/* grid rows */}
      <path d="M38 47h64M38 62h64" opacity="0.5" />
      {/* bell in a cell */}
      <path d="M75 70a4 4 0 0 1 4 -4 a4 4 0 0 1 4 4 v4 h-8 z" />
      <path d="M73 74h12" />
      <path d="M78 76v2" />
    </svg>
  )
}

// Events — a stylized arch (cathedral / liturgical doorway) with a
// star marker centered. The arch frames the moment; the star is the
// "feast / occasion" marker.
export function EventsIllustration() {
  return (
    <svg {...baseProps}>
      {/* arch */}
      <path d="M44 84V46a26 26 0 0 1 52 0v38" />
      {/* arch base / floor */}
      <path d="M30 84h80" />
      {/* inner arch frame */}
      <path d="M52 84V50a18 18 0 0 1 36 0v34" opacity="0.55" />
      {/* keystone star */}
      <path d="M70 36l2 4 4 .6-3 3 .7 4-3.7-2-3.7 2 .7-4-3-3 4-.6z" />
      {/* small flanking pillars dots */}
      <circle cx="44" cy="84" r="1.5" />
      <circle cx="96" cy="84" r="1.5" />
    </svg>
  )
}

// Tasks — open scroll with three checkmark lines and a quill resting
// on it. "The duty roll" rather than a generic to-do list.
export function TasksIllustration() {
  return (
    <svg {...baseProps}>
      {/* scroll body */}
      <path d="M30 22h70a4 4 0 0 1 4 4v44a4 4 0 0 1 -4 4h-70" />
      {/* left curl */}
      <path d="M30 22a4 4 0 0 0 0 8h4v44h-4a4 4 0 0 0 0 8" />
      {/* checkmarks (three) */}
      <path d="M44 38l3 3 6-6" />
      <path d="M44 52l3 3 6-6" />
      <path d="M44 66l3 3 6-6" />
      {/* task lines */}
      <path d="M58 41h36M58 55h36M58 69h28" opacity="0.55" />
      {/* quill */}
      <path d="M96 14l-12 18M86 30l-3 6 6-3" />
    </svg>
  )
}

// Donations — offering plate (shallow oval) with three coins above,
// and a small heart radiating from the plate to read the intent
// (gratitude / tithe rather than transaction).
export function DonationsIllustration() {
  return (
    <svg {...baseProps}>
      {/* coins */}
      <circle cx="58" cy="34" r="6" />
      <circle cx="70" cy="30" r="6" />
      <circle cx="82" cy="34" r="6" />
      <path d="M58 34h0M70 30h0M82 34h0" />
      {/* coin slot/edge */}
      <path d="M55 32q3 -2 6 0M67 28q3 -2 6 0M79 32q3 -2 6 0" opacity="0.5" />
      {/* plate (ellipse) */}
      <ellipse cx="70" cy="62" rx="38" ry="6" />
      <path d="M32 62q0 8 38 8 t38 -8" />
      {/* small heart above */}
      <path d="M70 14a3 3 0 0 0 -5 2 q0 4 5 6 q5 -2 5 -6 a3 3 0 0 0 -5 -2 z" opacity="0.7" />
    </svg>
  )
}

// Library — three stacked tomes leaning on each other, top one with
// a ribbon bookmark. "The shelf of past sermons / generations."
export function LibraryIllustration() {
  return (
    <svg {...baseProps}>
      {/* shelf line */}
      <path d="M22 82h96" opacity="0.4" />
      {/* book 1 (left, upright) */}
      <rect x="40" y="42" width="14" height="40" rx="1" />
      <path d="M44 50h6M44 58h6M44 66h6" opacity="0.5" />
      {/* book 2 (middle, slightly leaning) */}
      <rect x="58" y="38" width="14" height="44" rx="1" />
      <path d="M62 46h6M62 56h6M62 66h6" opacity="0.5" />
      {/* book 3 (right, leaning, with ribbon) */}
      <rect x="76" y="44" width="14" height="38" rx="1" transform="rotate(8 83 63)" />
      {/* ribbon hanging out top */}
      <path d="M84 40v10l3 -3 3 3v-10" />
      {/* small cross-glyph atop middle book */}
      <path d="M65 28v6M62 31h6" opacity="0.6" />
    </svg>
  )
}
