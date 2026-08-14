// ─── Per-module help content (SUP.5) ────────────────────────────────────────
// Each entry maps a page id to structured reference documentation rendered
// by HelpPanel.jsx. Structure:
//   { name, group, overview, features[], sections[], tips[] }
// section types: 'text' | 'fields' | 'indicators' | 'tips'
//
// Written against the actual codebase (routes + pages), not aspirationally.
// Vocabulary rules: "offerings & fees", never "billing" in parish-facing
// copy; "Members", never "clients"; sacraments are recorded, never sold.

export const MODULE_HELP = {

  // ── Dashboard ─────────────────────────────────────────────────────────────
  dashboard: {
    name: 'Dashboard', group: 'General',
    overview: 'Your at-a-glance start of day: the liturgical day and its color, the daily verse, urgent tasks, recent activity, and the Get Started checklist while your parish is still settling in.',
    features: [
      'Liturgical day banner — season, feast, and color, computed for your parish timezone',
      'Personalized greeting and daily verse',
      'Urgent and overdue tasks pulled from Daily Tasks',
      'Get Started checklist — auto-completes as you configure the parish',
      'Quick links into the modules behind each number',
    ],
    sections: [
      { title: 'The Get Started checklist', type: 'text',
        content: 'Five setup steps: add your first real member, add your first event, set the church letterhead (EIN + signatory — this powers year-end giving statements), invite a teammate, and publish your public church page. Each row deep-links to the right screen and checks itself off when done. Dismiss it with the ✕ once you\u2019re rolling.' },
      { title: 'Liturgical colors', type: 'indicators',
        items: [
          { label: 'Green', desc: 'Ordinary Time.' },
          { label: 'Violet', desc: 'Advent and Lent.' },
          { label: 'White/Gold', desc: 'Christmas, Easter, solemnities and feasts of the Lord.' },
          { label: 'Red', desc: 'Palm Sunday, Good Friday, Pentecost, martyrs.' },
          { label: 'Rose', desc: 'Gaudete and Laetare Sundays.' },
        ] },
    ],
    tips: ['If the liturgical day looks off by one, check Org details → timezone — the calendar is computed in your parish\u2019s timezone, not the browser\u2019s.'],
  },

  // ── Members ───────────────────────────────────────────────────────────────
  members: {
    name: 'Members', group: 'Pastoral',
    overview: 'The parish registry: parishioners, staff, and volunteers with contact details, status, roles, tags, and — on each profile — their giving history and sacramental timeline.',
    features: [
      'Full directory with search, status and role filters',
      'CSV import for migrating from a previous system',
      'Per-member profile: contact, tags, birthday (with feast-day overlap notes), joined date',
      'Sacramental timeline on the profile — records entered here appear in the Register',
      'Personal calendar feed (ICS) per member, and self-serve shift-swap links',
      'Bilingual: each member has a preferred language for communications',
    ],
    sections: [
      { title: 'Key fields', type: 'fields',
        items: [
          { label: 'Status', desc: 'active / inactive. Inactive members stay in the registry (and the Register) but drop out of scheduling and default lists.' },
          { label: 'Role', desc: 'Member, Volunteer, or Staff — a descriptive label, separate from login roles on the Team page.' },
          { label: 'Tags', desc: 'Free-form labels (Choir, Lector, RCIA…) used by filters and group tools.' },
        ] },
      { title: 'Sample members', type: 'text',
        content: 'Fresh parishes are seeded with [Sample]-prefixed members so every screen has something to show. Adding your first real member is a Get Started step; clearing samples removes them in one action without touching real data.' },
    ],
    tips: [
      'Import your census CSV first, then fix statuses — filters make bulk cleanup fast.',
      'Deleting a member never deletes their sacramental records; the Register outlives the roster.',
    ],
  },

  // ── Groups ────────────────────────────────────────────────────────────────
  groups: {
    name: 'Groups', group: 'Pastoral',
    overview: 'Ministries and small groups — choir, lectors, St. Vincent de Paul, RCIA — with membership lists and an interest/waitlist flow for people who want to join.',
    features: [
      'Create groups per ministry with member rosters',
      'Interest list — members can raise a hand before being placed',
      'Admin-only: visible to admins in the sidebar',
    ],
    sections: [
      { title: 'Interest → membership', type: 'text',
        content: 'Interests are a queue, not a membership. Review who has expressed interest, then place them into the group — nothing is automatic, so ministry leads keep control of their rosters.' },
    ],
    tips: ['Groups pair with tags: tag broadly (\u201cMusic\u201d), group precisely (\u201c9am Choir\u201d).'],
  },

  // ── Schedule ──────────────────────────────────────────────────────────────
  schedule: {
    name: 'Schedule', group: 'Pastoral',
    overview: 'The parish calendar: Masses, services, and events on a grid that reads as the church year — every tile carries its liturgical color — with recurring service templates, room booking, and volunteer assignments.',
    features: [
      'Month/week calendar with liturgical color stripes on each event',
      'Recurring service templates (\u201cSunday 9:00 AM Mass, weekly\u201d) that generate occurrences',
      'Room booking with conflict detection',
      'Volunteer assignments per event — lector, usher, EMHC, servers',
      'Member unavailability (blackout dates) and token-based shift swaps that work without a login',
      'Per-member ICS feeds so assignments land in personal calendars',
    ],
    sections: [
      { title: 'Assignments & swaps', type: 'text',
        content: 'Assign members to roles on any event. If someone can\u2019t make it, they open their swap link, and another qualified member accepts — no account required for the acceptance, and the schedule updates itself. Blackout dates keep the scheduler from assigning people who told you they\u2019re away.' },
      { title: 'Conflicts', type: 'text',
        content: 'The Conflicts screen (admin) surfaces double-booked rooms and members assigned to overlapping events, so you catch collisions before Sunday morning does.' },
    ],
    tips: ['Build recurring templates for your regular Mass schedule first; one template replaces fifty-two manual events.'],
  },

  // ── Check-in ──────────────────────────────────────────────────────────────
  checkin: {
    name: 'Check-in', group: 'Pastoral',
    overview: 'Attendance for events and classes, with child-safety security codes: each child check-in issues a pickup code that must match at release.',
    features: [
      'Fast check-in against any event',
      'Child security codes for pickup matching',
      'Kiosk mode via a per-parish kiosk token (Org details)',
      'Attendance history feeds Insights',
    ],
    sections: [
      { title: 'Child safety flow', type: 'text',
        content: 'Check a child in → the system issues a short code on the tag/receipt → at pickup the adult presents the code and it must match. Codes are per-check-in, not per-family, so a code can\u2019t be reused next week.' },
    ],
    tips: ['Religious-ed classrooms run smoothest with one kiosk device at the door and the roster pre-filtered to the class group.'],
  },

  // ── Register ──────────────────────────────────────────────────────────────
  register: {
    name: 'Register', group: 'Pastoral',
    overview: 'The permanent sacramental register — the parish\u2019s canonical record of baptisms, first communions, confirmations, marriages, holy orders, anointings, and funerals. Built to be trusted for decades: sequential certificate numbers, printable certificates, and a digitization path for the paper books.',
    features: [
      'Org-wide register searchable by name, minister, place, or certificate number',
      'Per-sacrament filter and date ordering, like the book itself',
      'Printable certificates with sequential numbers per book',
      'Records attach to member profiles but survive member deletion — the register outlives the roster',
      'Digitize (Drafts): back-enter paper registers safely',
    ],
    sections: [
      { title: 'Digitization drafts', type: 'text',
        content: 'Paper entries are typed (or photographed and transcribed) into Drafts at /register/drafts. Nothing enters the permanent record without an explicit human confirmation of each entry — a deliberate ceremony, because a register you can casually edit is a register nobody can trust.' },
      { title: 'Entering a sacrament', type: 'fields',
        items: [
          { label: 'Type + date', desc: 'The sacrament and when it was celebrated.' },
          { label: 'Minister', desc: 'Who celebrated — recorded as written, including visiting clergy.' },
          { label: 'Place', desc: 'Where — usually your parish, but marriages and baptisms elsewhere are recordable.' },
          { label: 'Certificate #', desc: 'Sequential within the book. The system proposes the next number; gaps are allowed, duplicates are not.' },
        ] },
    ],
    tips: [
      'Add records from the member\u2019s profile when the person exists; they appear in the register automatically.',
      'For certificate requests on old paper entries, digitize just that entry via Drafts — you don\u2019t need the whole book done first.',
    ],
  },

  // ── Intentions ────────────────────────────────────────────────────────────
  intentions: {
    name: 'Intentions', group: 'Pastoral',
    overview: 'The Mass intention book: who asked, for whom, the offering, and which Mass it\u2019s scheduled at — with the printable weekly sacristy manifest so the celebrant always knows the intention.',
    features: [
      'Intention entries with requester (free text or linked member) and offering amount',
      'Lifecycle: open → scheduled → fulfilled (or cancelled)',
      'Link each intention to a specific Mass on the calendar',
      'Weekly sacristy manifest — a printable sheet of the week\u2019s Masses and intentions',
      'Offerings tracked apart from donations — canonically distinct money',
    ],
    sections: [
      { title: 'Why offerings aren\u2019t donations', type: 'text',
        content: 'Mass offerings (stipends) are canonically restricted and belong in their own book — so they are recorded here, not in the Donations ledger, and they never mix into offertory totals or year-end statements.' },
      { title: 'Status meanings', type: 'indicators',
        items: [
          { label: 'Open', desc: 'Requested, not yet attached to a Mass.' },
          { label: 'Scheduled', desc: 'Attached to a specific Mass on the calendar.' },
          { label: 'Fulfilled', desc: 'The Mass was celebrated.' },
        ] },
    ],
    tips: ['Print the sacristy manifest Friday afternoon; it\u2019s the one sheet the weekend actually needs.'],
  },

  // ── Worship ───────────────────────────────────────────────────────────────
  worship: {
    name: 'Worship', group: 'Pastoral',
    overview: 'Order-of-service planning: one plan per Mass or service, with ordered elements — hymns, readings, rites — ready to print for musicians and sacristans.',
    features: [
      'One plan per calendar event',
      'Ordered elements: hymns, readings, rites, announcements',
      'Reorder freely; the printout follows the order',
    ],
    sections: [
      { title: 'Plan → calendar', type: 'text',
        content: 'Plans hang off calendar events, so the 9:00 and 11:00 Masses can share readings but differ in music. Create the event first, then its plan.' },
    ],
    tips: ['Duplicate last week\u2019s plan and edit — most weeks change three lines, not thirty.'],
  },

  // ── Conflicts ─────────────────────────────────────────────────────────────
  conflicts: {
    name: 'Conflicts', group: 'Pastoral',
    overview: 'The collision report (admin): double-booked rooms and members assigned to overlapping events, in one screen, before they become Sunday-morning surprises.',
    features: ['Room double-bookings', 'Member assignment overlaps', 'Deep links to the offending events'],
    sections: [],
    tips: ['Check Conflicts after any bulk scheduling session; it\u2019s faster than eyeballing the grid.'],
  },

  // ── Events ────────────────────────────────────────────────────────────────
  events: {
    name: 'Events', group: 'Pastoral',
    overview: 'The event list view — the same occurrences as the Schedule calendar, in a filterable list with member assignments, for when you\u2019re working through events rather than looking at a month.',
    features: ['List view with filters', 'Member assignment management', 'Public events can surface on your church page'],
    sections: [],
    tips: ['Use Schedule for planning the week, Events for cleaning up the backlog.'],
  },

  // ── Daily Tasks ───────────────────────────────────────────────────────────
  tasks: {
    name: 'Daily Tasks', group: 'Pastoral',
    overview: 'The parish office to-do list: tasks with priorities, due dates, assignments, checklists inside tasks, and recurring routines (open the church, Sunday count, month-end) that regenerate themselves.',
    features: [
      'Priorities, due dates, categories, and member assignment',
      'Checklists inside a task — a task can be a procedure',
      'Recurring tasks and reusable checklist templates for routines',
      'Urgent/overdue items surface on the Dashboard',
    ],
    sections: [
      { title: 'Checklist templates', type: 'text',
        content: 'Repeatable routines — sacristy setup, opening/closing, count procedures — live as templates and stamp out fresh runs each time, so the procedure is followed, not remembered.' },
    ],
    tips: ['Give every recurring obligation a recurring task; the Dashboard becomes your morning briefing.'],
  },

  // ── Forms ─────────────────────────────────────────────────────────────────
  forms: {
    name: 'Forms', group: 'Pastoral',
    overview: 'Public forms (admin): registration, volunteer sign-up, prayer requests — shareable by link, with responses collected inside the parish workspace.',
    features: ['Form builder with common field types', 'Public links — no login needed to respond', 'Response inbox per form'],
    sections: [],
    tips: ['A \u201cNew Parishioner\u201d form on your public church page quietly feeds Members with clean data.'],
  },

  // ── Bulletin ──────────────────────────────────────────────────────────────
  bulletin: {
    name: 'Bulletin', group: 'Pastoral',
    overview: 'The weekly bulletin builder (admin): assemble announcements, schedule, and content into the week\u2019s bulletin — and let AI Studio draft the announcement copy.',
    features: ['Weekly issues with sections', 'Pulls from events and announcements', 'Pairs with AI Studio for drafting'],
    sections: [],
    tips: ['Draft announcements in AI Studio (they land in the Library), then place them — writing and layout stay separate jobs.'],
  },

  // ── Donations ─────────────────────────────────────────────────────────────
  donations: {
    name: 'Donations', group: 'Stewardship',
    overview: 'The giving ledger: offertory and gifts by donor, fund, method, and date — with online giving, refunds handled in place, and IRS year-end statements generated from your letterhead settings.',
    features: [
      'Manual entry for envelopes/cash/checks; online gifts arrive automatically',
      'Designated funds (Building Fund, St. Vincent de Paul…) for restricted routing',
      'Recurring online gifts',
      'Two-person cash count sessions with denomination sheets',
      'Refund tracking on the original gift — no negative rows',
      'Year-end statements at /donations/statements — per-donor, printable, IRS-ready',
    ],
    sections: [
      { title: 'Year-end statements', type: 'text',
        content: 'Statements assemble each donor\u2019s deductible giving with the IRS-required language, on your letterhead (Org details: EIN, signatory, address). Donor email/address on gifts is what makes statements deliverable — clean those as you go, not in January.' },
      { title: 'Funds vs. categories', type: 'fields',
        items: [
          { label: 'Fund', desc: 'A designated destination with restriction meaning — reportable, and honored in statements.' },
          { label: 'Category / method', desc: 'Descriptive: tithe vs. gift; cash / check / card / online.' },
        ] },
    ],
    tips: [
      'Set up funds before importing history so restricted gifts land restricted.',
      'The cash-count flow wants two people by design; the verifier field isn\u2019t decoration, it\u2019s your audit control.',
    ],
  },

  // ── Pledges ───────────────────────────────────────────────────────────────
  pledges: {
    name: 'Pledges', group: 'Stewardship',
    overview: 'Campaign pledges (admin): who committed what — for building campaigns and annual appeals — tracked against actual giving.',
    features: ['Pledges linked to members', 'Amounts and campaign context', 'Pairs with Donations for fulfillment reading'],
    sections: [],
    tips: ['For the diocesan annual appeal, pledge here and let the diocese layer read the roll-up — no separate spreadsheet.'],
  },

  // ── Payroll ───────────────────────────────────────────────────────────────
  payroll: {
    name: 'Payroll', group: 'Stewardship',
    overview: 'Light staff payroll: the staff registry with pay rates, and shift logging with hours — enough for the parish with a part-time secretary and organist, without pretending to be ADP.',
    features: ['Staff list with roles and hourly rates', 'Shift entries with date, hours, type', 'Totals for the bookkeeper'],
    sections: [],
    tips: ['This is a record of hours and rates, not a tax filer — your payroll provider or bookkeeper still cuts the checks.'],
  },

  // ── Finance ───────────────────────────────────────────────────────────────
  finance: {
    name: 'Finance', group: 'Stewardship',
    overview: 'The parish ledger and the bridge to the diocese (admin): a chart of accounts (with the diocesan standard built in), ledger entries by hand or CSV import, and period submissions whose approved totals are frozen — the numbers the chancery consolidates and assesses.',
    features: [
      'Chart of accounts: diocesan standard rows + parish-local additions, mapped together',
      'The assessable flag on accounts — this defines what counts toward the diocesan assessment',
      'Ledger entries: manual or CSV import in batches',
      'Period close → submission to the diocese → approved or returned with a note',
      'Approved totals are frozen snapshots; consolidations read only approved periods',
    ],
    sections: [
      { title: 'The submission lifecycle', type: 'indicators',
        items: [
          { label: 'Submitted', desc: 'Totals frozen and sent; awaiting chancery review.' },
          { label: 'Approved', desc: 'Locked in; feeds diocesan roll-ups and the assessment base.' },
          { label: 'Returned', desc: 'Sent back with a review note; fix and resubmit.' },
        ] },
      { title: 'Why totals freeze', type: 'text',
        content: 'A submitted period\u2019s totals are snapshotted at submission. Later ledger edits don\u2019t silently change what the diocese approved — which is exactly why the chancery can trust the roll-up, and why your pastor can trust the assessment math.' },
    ],
    tips: ['This is a reporting ledger, not double-entry bookkeeping — it standardizes what the diocese sees; QuickBooks can still be your books.'],
  },

  // ── AI Studio ─────────────────────────────────────────────────────────────
  'ai-studio': {
    name: 'AI Studio', group: 'Studio',
    overview: 'AI drafting for parish content — announcements and more — with everything you generate archived in the Library. Metered monthly by plan (20 on Free, 500 on Parish).',
    features: ['Guided generation by content type', 'Monthly quota by plan with clear counts', 'Optionally bring your own AI key (Org details) to run on your own account'],
    sections: [
      { title: 'Your own AI key', type: 'text',
        content: 'A parish can plug in its own Anthropic or OpenAI key: your provider, your bill, your rate limits, encrypted at rest. Leave it blank and you ride the platform\u2019s keys inside your plan quota.' },
    ],
    tips: ['Generated drafts are starting points — the pastor\u2019s voice is the edit pass.'],
  },

  // ── Library ───────────────────────────────────────────────────────────────
  library: {
    name: 'Library', group: 'Studio',
    overview: 'The archive of everything AI Studio has produced — searchable, reusable, and the source you place from when building bulletins.',
    features: ['All generations, kept', 'Search and reuse'],
    sections: [], tips: [],
  },

  // ── Insights ──────────────────────────────────────────────────────────────
  insights: {
    name: 'Insights', group: 'Admin',
    overview: '12-month trends across the parish (admin): attendance, giving, membership movement — the vitality picture behind the day-to-day.',
    features: ['Trend charts over the trailing year', 'Drill-through to the source modules'],
    sections: [], tips: ['Screenshot the giving trend for finance-council night; it answers half the agenda.'],
  },

  // ── Team ──────────────────────────────────────────────────────────────────
  team: {
    name: 'Team', group: 'Admin',
    overview: 'Login accounts and roles (admin): who can sign in, and as what — admin, staff, or viewer.',
    features: ['Invite teammates by email', 'Role management', 'Deactivate departures without losing their history'],
    sections: [
      { title: 'Roles', type: 'indicators',
        items: [
          { label: 'Admin', desc: 'Everything, including settings, finance, register confirmation, and this page.' },
          { label: 'Staff', desc: 'Day-to-day work: members, schedule, donations, intentions — no org settings.' },
          { label: 'Viewer', desc: 'Read-only everywhere; mutations are blocked at the API.' },
        ] },
    ],
    tips: ['Volunteers who only need to see the schedule are viewers; resist the urge to make everyone staff.'],
  },

  // ── Org details ───────────────────────────────────────────────────────────
  settings: {
    name: 'Org details', group: 'Admin',
    overview: 'Parish identity and configuration (admin): name, address, EIN and signatory (the letterhead behind giving statements), timezone, kiosk token, your public church page, and the diocese affiliation.',
    features: [
      'Letterhead: EIN, signatory name/title, address — powers year-end statements',
      'Timezone — drives the liturgical calendar and date math',
      'Public church page at /p/your-slug: tagline, about, service times, publish toggle',
      'Kiosk token for check-in devices',
      'Diocese: accept or revoke an affiliation invitation; choose summary vs. detail sharing',
      'Own AI key (optional) for AI Studio',
    ],
    sections: [
      { title: 'The diocese affiliation', type: 'text',
        content: 'If your diocese runs OpenChurch, they invite you by email. Accepting is explicit, the grant level is your choice (summary totals or detail), access is read-only, and you can revoke it. Nothing is shared before you accept.' },
    ],
    tips: ['Set EIN + signatory before December; statements without letterhead are the classic January scramble.'],
  },

  // ── Billing (SaaS plan) ───────────────────────────────────────────────────
  billing: {
    name: 'Billing', group: 'Admin',
    overview: 'Your OpenChurch plan (admin): Free (50 members, trial-sized) or Parish — $79/month flat, everything unlimited. Managed through Stripe with a self-serve portal.',
    features: ['Plan status and renewal date', 'Upgrade/downgrade via Stripe checkout', 'Invoices in the Stripe portal'],
    sections: [
      { title: 'If your diocese sponsors OpenChurch', type: 'text',
        content: 'Parishes affiliated with a subscribing diocese ride the diocesan contract — this page will show that sponsorship instead of a card form.' },
    ],
    tips: [],
  },

  // ── Audit log ─────────────────────────────────────────────────────────────
  audit: {
    name: 'Audit log', group: 'Admin',
    overview: 'Every change, remembered (admin): who did what, when, across the whole workspace — because a parish record system must be able to answer \u201cwho edited this?\u201d',
    features: ['Every successful mutation logged with user and summary', 'Filter by area and time'],
    sections: [], tips: ['The register and donations questions that start \u201cwho changed…\u201d end here.'],
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  notifications: {
    name: 'Notifications', group: 'Admin',
    overview: 'Parish-wide notification behavior (admin): reminder lead times and delivery settings; members\u2019 personal choices live in their own Preferences.',
    features: ['Reminder lead-hours for assignments', 'Delivery configuration'],
    sections: [], tips: [],
  },

  // ── Preferences ───────────────────────────────────────────────────────────
  preferences: {
    name: 'Preferences', group: 'You',
    overview: 'Your personal settings: language (English/Español) and notification choices. Yours alone — every user sets their own.',
    features: ['Interface language', 'Personal notification opt-outs'],
    sections: [], tips: [],
  },
}

// ─── Role permission table ──────────────────────────────────────────────────
export const ROLE_TABLE = [
  { area: 'Dashboard, Schedule, Members (view)', admin: true, staff: true, viewer: true },
  { area: 'Add/edit members, events, intentions, donations', admin: true, staff: true, viewer: false },
  { area: 'Confirm register drafts (permanent record)', admin: true, staff: true, viewer: false },
  { area: 'Groups, Forms, Bulletin, Pledges, Finance', admin: true, staff: false, viewer: false },
  { area: 'Insights, Team, Org details, Billing, Audit log', admin: true, staff: false, viewer: false },
  { area: 'Donation refunds', admin: true, staff: false, viewer: false },
  { area: 'Report a problem; use the Assistant', admin: true, staff: true, viewer: true },
]

// ─── Cross-cutting tips ─────────────────────────────────────────────────────
export const TIPS = [
  'Search anything with \u2318K — members, events, donations, register entries.',
  'Every screen with a printer icon prints clean: certificates, the sacristy manifest, giving statements, checklists.',
  'Bilingual parishes: set each member\u2019s preferred language and your communications follow it.',
  'The [Sample] data on new parishes clears in one action — Org details → clear samples — without touching anything real.',
  'Dark mode lives at the bottom of the sidebar; the liturgical colors are tuned for both themes.',
]

// ─── FAQ ────────────────────────────────────────────────────────────────────
export const FAQ = [
  { q: 'How do I record a baptism from the old paper register?',
    a: 'Register → Digitize. Type the paper entry as a draft, review it, then confirm it into the permanent record. Nothing becomes permanent without that explicit confirmation, and the certificate number keeps the book\u2019s sequence.' },
  { q: 'Someone needs a baptismal certificate from 1987. What\u2019s the fastest path?',
    a: 'Digitize just that entry (Register → Digitize), confirm it, open the record, and print the certificate. You don\u2019t need to digitize the whole book first.' },
  { q: 'How do I print this week\u2019s Mass intentions for the sacristy?',
    a: 'Intentions → the weekly manifest button. It prints the week\u2019s Masses with each intention and requester — one sheet for the sacristy counter.' },
  { q: 'Why aren\u2019t Mass offerings in my Donations totals?',
    a: 'By design. Offerings (stipends) are canonically restricted money recorded in the intention book, not the giving ledger — so offertory totals, statements, and diocesan reporting stay clean.' },
  { q: 'How do year-end giving statements work?',
    a: 'Donations → Statements. Statements are built per donor from their deductible gifts, on your letterhead (EIN, signatory — set in Org details), with the IRS-required language, ready to print or send.' },
  { q: 'How do I give our diocese access to our numbers?',
    a: 'Your diocese sends an invitation; accept it in Org details → Diocese and choose summary or detail sharing. Access is read-only, scoped to what you granted, and revocable. The diocese only ever consolidates periods you submitted and they approved.' },
  { q: 'What does \u201creturned\u201d mean on my period submission?',
    a: 'The chancery sent it back with a note (visible on the submission). Fix the flagged items in the ledger, close the period again, and resubmit — the approved version is always a frozen snapshot.' },
  // NOTE: wedding/funeral fee invoicing (offerings & fees) is a PROPOSED
  // module — its FAQ entries return here when it ships. Help never
  // describes surfaces that don't exist yet.
  { q: 'How do I add a second Mass time on Sundays?',
    a: 'Schedule → recurring templates: add \u201cSunday 11:00 AM Mass, weekly.\u201d Occurrences generate onto the calendar, and each Mass gets its own worship plan and assignments.' },
  { q: 'A lector can\u2019t make Sunday. Do I reschedule everyone?',
    a: 'No — they open their swap link and another qualified member accepts it, no login needed. The schedule and reminders update themselves.' },
  { q: 'Can volunteers see the schedule without being able to change anything?',
    a: 'Yes — invite them as viewers (Team). Viewers read everything they\u2019re shown and can change nothing; the API itself blocks their writes.' },
  { q: 'How do I move us off our old system?',
    a: 'Members → Import CSV for the census; funds first, then donation history; digitize register entries as needed via Drafts. The [Sample] data clears in one action when you\u2019re ready.' },
  { q: 'Is OpenChurch in Spanish?',
    a: 'S\u00ed — the interface is bilingual English/Spanish. Each user picks their language in Preferences, and members have a preferred language for communications.' },
  { q: 'What happens to sacramental records if I delete a member?',
    a: 'They remain in the Register, unlinked. The register is the permanent parish record and deliberately outlives the roster.' },
  { q: 'Where do I report a bug or something confusing?',
    a: 'Right here — the Report a Problem tab in this panel. Describe what happened; a diagnostic runs automatically and the report reaches the maintainers with the context they need.' },
  { q: 'Does the AI assistant answer canon-law questions?',
    a: 'No — it will warmly point you to your pastor or the chancery. It helps with the software and everyday office operations; canonical questions deserve a canonist.' },
  { q: 'What does the Parish plan cost, and what\u2019s in it?',
    a: '$79/month flat: unlimited members and events, every module, 500 AI generations monthly, and priority support. The Free plan is a look-around tier capped at 50 members. Diocese-sponsored parishes ride their diocesan contract instead.' },
]

// ─── Search index ───────────────────────────────────────────────────────────
export function buildSearchIndex() {
  const rows = []
  for (const [id, mod] of Object.entries(MODULE_HELP)) {
    rows.push({ kind: 'module', id, title: mod.name, text: `${mod.overview} ${(mod.features || []).join(' ')}` })
    for (const s of mod.sections || []) {
      const body = s.content || (s.items || []).map(i => `${i.label} ${i.desc}`).join(' ')
      rows.push({ kind: 'section', id, title: `${mod.name} — ${s.title}`, text: body })
    }
    for (const t of mod.tips || []) rows.push({ kind: 'tip', id, title: `${mod.name} tip`, text: t })
  }
  FAQ.forEach((f, i) => rows.push({ kind: 'faq', id: `faq-${i}`, title: f.q, text: f.a }))
  return rows
}
