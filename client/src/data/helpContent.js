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
    overview: 'Your at-a-glance start of day: the liturgical day and its color, the daily verse, urgent tasks, recent activity, and a Getting settled card while your parish is still settling in.',
    features: [
      'Liturgical day banner — season, feast, and color, computed for your parish timezone',
      'Personalized greeting and daily verse',
      'Urgent and overdue tasks pulled from Daily Tasks',
      'Daily checklists card \u2014 tick off today\u2019s routines; Manage checklists adds or removes the templates',
      'Getting settled card — a short link to a few good places to begin',
      'Quick links into the modules behind each number',
    ],
    sections: [
      // The old five-step Get Started checklist was replaced by the
      // Getting settled card (GettingSettledCard.jsx); help describes the card.
      { title: 'Getting settled', type: 'text',
        content: 'While your parish is new, the Dashboard shows a Getting settled card with a link to the Getting settled page. That page lists what is already in place and suggests a few good places to begin; there is no checklist or progress bar to finish. Choose \u201cCome back to this later\u201d (the \u2715) to put the card away. The page stays under Admin \u2192 Getting settled.' },
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
    overview: 'The parish registry: parishioners, staff, and volunteers with contact details, status, roles, tags, and — on each profile — their sacramental timeline and, for staff and admins, their giving history.',
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
        content: 'Fresh parishes are seeded with [Sample]-prefixed members so every screen has something to show. Clear them from the banner on the Dashboard (Clear sample data) in one action, without touching real data.' },
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
    overview: 'The parish calendar: Masses, services, and events on a grid that reads as the church year — every tile carries its liturgical color — with recurring service templates and volunteer assignments.',
    features: [
      'Month/week calendar with liturgical color stripes on each event',
      'Recurring service templates (\u201cSunday 9:00 AM Mass, weekly\u201d) that generate occurrences',
      'A warning when someone you assign is already on another event at that time',
      'Volunteer assignments per event — lector, usher, EMHC, servers',
      'Member unavailability (blackout dates) and token-based shift swaps that work without a login',
      'Per-member ICS feeds so assignments land in personal calendars',
    ],
    sections: [
      { title: 'Assignments & swaps', type: 'text',
        content: 'Assign members to roles on any event. If someone can\u2019t make it, they open the swap link you sent them and ask a specific member to take their place; that member accepts from their own swap link. Neither needs an account, and the schedule updates itself. OpenChurch doesn\u2019t check ministry training or roles on a swap, so they should ask someone who already serves in that role. Blackout dates keep the scheduler from assigning people who told you they\u2019re away.' },
      // MIN-48 (Saint, 20 Oct): the New Event dialog's Service / Meeting /
      // Event pills were unexplained. Kept in step with utils/massEvent.js.
      { title: 'Event types: Service, Meeting, Event', type: 'indicators',
        items: [
          { label: 'Service', desc: 'A Mass or other liturgy. Choose this for a Mass: it is listed first when you assign a Mass intention.' },
          { label: 'Meeting', desc: 'A gathering that is not a liturgy, such as a council or committee. A Meeting cannot take a Mass intention.' },
          { label: 'Event', desc: 'Anything else on the calendar. It can still take a Mass intention, listed after Services.' },
        ] },
      { title: 'Conflicts', type: 'text',
        content: 'The Conflicts screen (admin) lists members assigned to overlapping events, week by week, so you catch collisions before Sunday morning does. It does not check rooms: events don\u2019t book a room, and rooms in OpenChurch are only the check-in spaces.' },
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
      'Kiosk mode: an admin turns on the kiosk link from the Check-in page',
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
    overview: 'The permanent sacramental register — the parish\u2019s canonical record of baptisms, first communions, confirmations, marriages, holy orders, anointings, and funerals. Built to be trusted for decades: certificate numbers as the book records them, printable certificates, and a digitization path for the paper books.',
    features: [
      'Org-wide register searchable by name, minister, place, or certificate number',
      'Per-sacrament filter and date ordering, like the book itself',
      'Printable certificates that carry the certificate number you recorded',
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
          { label: 'Certificate #', desc: 'The number as written in the book. OpenChurch doesn\u2019t propose the next number or check for duplicates, so check the book before you save.' },
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
      'Weekly sheet (sacristy manifest) — a printable list of the week\u2019s intentions, Saturday through Friday, each with its assigned Mass (Masses with no intention are not listed). An intention with no Mass yet still prints, marked \u201cUnassigned \u2014 needs a Mass\u201d',
      'Offerings tracked apart from donations — canonically distinct money',
      'A recorded offering is held in Finance as money owed for the Mass (account 2330, Mass Stipends Payable), not parish income, and it doesn\u2019t count toward the diocesan assessment',
    ],
    sections: [
      { title: 'Why offerings aren\u2019t donations', type: 'text',
        content: 'Mass offerings (stipends) are canonically restricted and belong in their own book — so they are recorded here, not in the Donations ledger, and they never mix into offertory totals or year-end statements.' },
      { title: 'Status meanings', type: 'indicators',
        items: [
          { label: 'Open', desc: 'Requested, not yet attached to a Mass.' },
          { label: 'Scheduled', desc: 'Attached to a specific Mass on the calendar. Assigning a Mass to an Open intention makes it Scheduled automatically; releasing it from the Mass puts it back to Open.' },
          { label: 'Fulfilled', desc: 'Recorded as fulfilled in the intention book.' },
        ] },
      { title: 'Deleting or voiding an intention', type: 'text',
        content: 'Only an intention with no offering recorded and no history can be deleted. Once an offering amount is recorded, or the intention is fulfilled or voided, it stays in the book and the delete is refused for every role. Voiding is for administrators and needs a reason. If the offering is still held, the void also needs a disposition: refund it, transfer it to another open intention, or apply it as the pastor directs, with a reason. Administrators use Void on the Intentions screen; when the offering is still held they also choose a disposition. After a Mass is said, a fulfilled stipend stays held in account 2330 — Release stipend is not available yet, and voiding a fulfilled intention that still holds the stipend is refused for the same reason (remittance accounting is still an open parish decision).' },
      { title: 'Move an intention to another date or Mass', type: 'text',
        content: 'To move, reschedule, change Mass or change date for an intention: open Intentions, find the row (search by name), and choose Edit. Set the new Mass date, then pick the Mass on that day. If that day has no Mass yet, use \u201cAdd a Mass on this date\u201d \u2014 the new Mass comes back already picked. Then press Save changes. The date and the Mass must agree: if they don\u2019t, Save changes says so and nothing is saved; \u201cUse the Mass\u2019s date\u201d and \u201cClear the assignment\u201d only change the form, and nothing saves until you press Save changes. The confirmation names the new date. The intention keeps no note of its old date or Mass, so tell the requester before you move it.' },
      { title: 'All Souls envelopes with several names', type: 'text',
        content: 'An All Souls (or November) envelope with several departed names is one intention: one family line in the Intention field, and the individual names in the Note. The weekly sheet and the Sunday Packet show that note to the celebrant. There is no separate Book of the Dead list in OpenChurch \u2014 use the Note for the names the priest should read.' },
    ],
    tips: ['Print the weekly sheet Friday afternoon; it\u2019s the one sheet the weekend actually needs. An intention marked \u201cUnassigned \u2014 needs a Mass\u201d still has to be assigned a Mass.'],
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
    // There is no copy-a-plan action; the old tip promised one.
    tips: [],
  },

  // ── Conflicts ─────────────────────────────────────────────────────────────
  conflicts: {
    name: 'Conflicts', group: 'Pastoral',
    overview: 'The collision report (admin): members assigned to overlapping events, in one screen, before they become Sunday-morning surprises. Rooms are not checked.',
    features: ['Member assignment overlaps, grouped by week', 'A link to that day in Schedule'],
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
    overview: 'The parish office to-do list: tasks with priorities, due dates, assignments, checklists inside tasks, and a Recurring label (daily, weekly, Sundays) for routines like opening the church or the Sunday count.',
    features: [
      'Priorities, due dates, categories, and member assignment',
      'Checklists inside a task — a task can be a procedure',
      'Recurring is a label: a completed task doesn\u2019t come back by itself. For a routine that resets every day, use a daily checklist on the Dashboard',
      'High-priority and overdue items surface on the Dashboard under Urgent Tasks',
    ],
    sections: [
      { title: 'Checklist templates', type: 'text',
        content: 'Repeatable routines — sacristy setup, opening/closing, count procedures — are kept as checklist templates on the Dashboard, not on this page. Open the Dashboard, find the Daily checklists card, and choose Manage checklists to add or remove a template; each day gets a fresh copy, so the procedure is followed, not remembered.' },
    ],
    tips: ['For something that has to happen every day, add it to a daily checklist on the Dashboard; each day gets a fresh copy. A task marked Recurring stays done once you complete it.'],
  },

  // ── Forms ─────────────────────────────────────────────────────────────────
  forms: {
    name: 'Forms', group: 'Pastoral',
    overview: 'Public forms (admin): registration, volunteer sign-up, prayer requests — shareable by link, with responses collected inside the parish workspace.',
    features: ['Form builder with common field types', 'Public links — no login needed to respond', 'Response inbox per form'],
    sections: [],
    tips: ['Responses stay in each form\u2019s response inbox; they don\u2019t add anyone to Members. Add a new parishioner to Members yourself after you read the response.'],
  },

  // ── Bulletin ──────────────────────────────────────────────────────────────
  bulletin: {
    name: 'Bulletin', group: 'Pastoral',
    overview: 'The weekly bulletin builder (admin): assemble announcements, this week\u2019s Mass times, intentions, and readings into a printable sheet — and optionally publish a public read-online page.',
    features: [
      'Weekly issues with announcements, readings, intentions, and a pastor\u2019s note',
      'Pull this week\u2019s Mass times from the calendar (Sat\u2013Fri vigil week) and fill intentions from the intention book',
      'Pull readings from a service plan when one has them',
      'Print / PDF marks DRAFT until Published is checked',
      'Published puts the bulletin on your public church page at /p/<slug>/bulletin',
      'Pairs with AI Studio for drafting announcement copy',
    ],
    sections: [
      { title: 'Intentions and print', type: 'text',
        content: 'Use Fill from intention book so names match the sacristy sheet (scheduled only, \u2020 kept, no offering amount). Print / PDF on a draft shows \u201cDRAFT \u2014 not published\u201d on the page until you check Published and save.' },
      { title: 'Publishing', type: 'text',
        content: 'Published is separate from Save. Leaving it unchecked keeps the bulletin internal. Checking it and saving can put announcements and typed intentions (including names of the dead and requesters) on the public bulletin page.' },
    ],
    tips: [
      'Draft announcements in AI Studio (they land in the Library), then place them — writing and layout stay separate jobs.',
      'Search Help for \u201cprint bulletin\u201d or \u201cintentions bulletin\u201d to find this card.',
    ],
  },

  // ── Donations ─────────────────────────────────────────────────────────────
  donations: {
    name: 'Donations', group: 'Stewardship',
    overview: 'The giving ledger: offertory and gifts by donor, fund, method, and date — with refunds handled in place, IRS year-end statements generated from your letterhead settings, and online giving once your parish\u2019s own Stripe account is connected.',
    features: [
      'Manual entry for envelopes/cash/checks; online gifts are recorded automatically once your parish\u2019s own Stripe account is connected',
      'Designated funds (Building Fund, St. Vincent de Paul…) for restricted routing',
      'Recurring online gifts are not taken yet: the Give page accepts one-time gifts only',
      'Cash count sessions with denomination sheets, confirmed by a second signed-in staff member',
      'Refund tracking on the original gift — no negative rows',
      'Year-end statements at /donations/statements — per-donor, printable, IRS-ready',
    ],
    sections: [
      // SP-092: "collection" found nothing; parishes say "count the collection".
      { title: 'Counting the collection (cash count)', type: 'text',
        content: 'After Mass, open Cash Count on the Donations page to count the collection: enter the service, date, and the number of each bill and coin, and the total adds itself up. The count is saved as pending. A second staff member confirms it from their own sign-in, and then it posts to the donations log and shows \u201cConfirmed\u201d. Use the From and To dates above the Cash Count Sessions list to see the counts for a range of service dates. Nothing is kept until you save: if you close the count with money already entered, OpenChurch asks before throwing that count away.' },
      { title: 'Year-end statements', type: 'text',
        content: 'Statements assemble each donor\u2019s deductible giving with the IRS-required language, on your letterhead (Org details: EIN, signatory, address). Donor email/address on gifts is what makes statements deliverable — clean those as you go, not in January.' },
      { title: 'Funds vs. categories', type: 'fields',
        items: [
          { label: 'Fund', desc: 'A designated destination with restriction meaning — reportable, and honored in statements.' },
          { label: 'Category / method', desc: 'Descriptive: tithe vs. gift; cash / check / card / online.' },
        ] },
    ],
    tips: [
      'Online giving goes only to your parish\u2019s own connected Stripe account (stripe_connect_account_id on the parish row). Until one is connected, the public Give page tells donors online giving isn\u2019t set up and takes no card gift. There is no screen in OpenChurch yet to connect or edit that account column yourself — payments stay on hold.',
      'Set up funds before importing history so restricted gifts land restricted.',
      'A cash count is verified when a second staff member confirms it while signed in as themselves. One person can still post it, but it is marked \u201cSingle count, not verified\u201d.',
      'A confirmed count can\u2019t be deleted. An admin can void it with a reason: the count and its gift stay on record, and a reversing entry takes it out of the totals. Staff can request a void with a reason; it posts only when a different admin approves it.',
    ],
  },

  // ── Pledges ───────────────────────────────────────────────────────────────
  pledges: {
    name: 'Pledges', group: 'Stewardship',
    overview: 'Campaign pledges (admin): who committed what — for building campaigns and annual appeals — tracked against actual giving.',
    features: ['Pledges linked to members', 'Amounts and campaign context', 'Pairs with Donations for fulfillment reading'],
    sections: [],
    tips: ['Pledges stay in the parish: the diocese layer doesn\u2019t read them, so a diocesan appeal still needs its own report to the chancery.'],
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
      'Ledger entries: by hand, or a trial-balance CSV for one period-end date that must balance and is saved all or nothing',
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
    tips: [
      'This is a reporting ledger, not double-entry bookkeeping — it standardizes what the diocese sees; QuickBooks can still be your books.',
      'From the cutover date, a gift whose category or fund has no account mapping has no account. A period with such gifts can\u2019t be sent to the diocese until they are mapped; nothing is frozen until then.',
      'A mapping change starts today or later on your parish\u2019s calendar, and earlier gifts keep the account they had. A change that would move gifts in a period already sent to the diocese is refused.',
      'A mapping that would lower what counts toward the diocesan assessment is the diocese\u2019s to set, not the parish\u2019s, and OpenChurch has no screen yet for the diocese to set it.',
      'A period can\u2019t be sent to the diocese while it has a voided Mass intention whose offering is still held with no refund, transfer, or pastor-directed apply recorded. Record the disposition first; nothing is frozen until then.',
      'A period with deposit adjustments that aren\u2019t in the diocesan roll-up yet can\u2019t be sent, approved, or settled until they are, and an assessment can\u2019t be built from an approved period that has them.',
    ],
  },

  // ── AI Studio ─────────────────────────────────────────────────────────────
  'ai-studio': {
    name: 'AI Studio', group: 'Studio',
    overview: 'AI drafting for parish content — announcements and more — with everything you generate archived in the Library. It runs only on your parish\u2019s own AI key (Org details); with no key, AI Studio is off. Because your parish pays its own provider, OpenChurch sets no monthly AI limit; your provider\u2019s own rate limits apply.',
    features: ['Guided generation by content type', 'No monthly AI limit from OpenChurch on your own key', 'Runs on your parish\u2019s own AI key, added in Org details'],
    sections: [
      { title: 'Your own AI key', type: 'text',
        content: 'AI Studio runs on your parish\u2019s own Anthropic or OpenAI key: your provider, your bill, your rate limits, encrypted at rest. OpenChurch does not supply a key, so until an admin adds one in Org details, AI features stay off.' },
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
          { label: 'Viewer', desc: 'Sees the Dashboard, Members, Schedule and Mass Intentions (read-only on the Schedule and the weekly sheet), plus a simplified Getting settled card. On Members, a viewer doesn\u2019t see private notes, birth years (only the birthday) or giving. Cannot change parish records; can update their own profile, preferences and support tickets. The notification bell stays empty for viewers. Both limits are enforced by the API.' },
        ] },
    ],
    tips: ['Volunteers who only need to see the schedule are viewers; resist the urge to make everyone staff.'],
  },

  // ── Org details ───────────────────────────────────────────────────────────
  settings: {
    name: 'Org details', group: 'Admin',
    overview: 'Parish identity and configuration (admin): name, address, EIN and signatory (the letterhead behind giving statements), timezone, your public church page, and the diocese affiliation.',
    features: [
      'Letterhead: EIN, signatory name/title, address — powers year-end statements',
      'Timezone — drives the liturgical calendar and date math',
      'Public church page at /p/your-slug: tagline, about, service times, and an on/off switch for the public address',
      'Parish page (Publish the parish page): a draft kept apart from what visitors see, with Publish, Take the page down and Restore the previous page, each confirmed first',
      'Church page look: a public display name, a logo (an https image link) and an accent color (#RRGGBB). Leave any blank for the parish name, the OpenChurch mark or the Parchment & Brass color. They apply to the church page only; public forms, giving and bulletin pages keep the standard look',
      'Diocese: accept or revoke an affiliation invitation; choose summary vs. detail sharing',
      'Your parish\u2019s own AI key, which turns on AI Studio and other AI features',
    ],
    sections: [
      { title: 'Publishing the parish page', type: 'text',
        content: 'Open Publish the parish page from Org details. The draft and the public page are kept apart: changing the draft changes nothing visitors see until you choose Publish and confirm. Take the page down removes the composed page and keeps the draft; Restore the previous page brings back the page that was public just before. Recent changes lists each publish, take-down and restore. Visitors only reach the page while the public address switch in Org details is on, so a published page with the switch off is still not visible.' },
      { title: 'The diocese affiliation', type: 'text',
        content: 'If your diocese runs OpenChurch, they invite you by email. Accepting is explicit, the grant level is your choice (summary totals or detail), access is read-only, and you can revoke it. Nothing is shared before you accept.' },
    ],
    tips: ['Set EIN + signatory before December; statements without letterhead are the classic January scramble.'],
  },

  // ── Billing (SaaS plan) ───────────────────────────────────────────────────
  billing: {
    name: 'Billing', group: 'Admin',
    overview: 'OpenChurch is free during the open beta. Pricing will be announced before general launch. This page shows your current plan and status.',
    features: ['Current plan and status'],
    sections: [
      { title: 'If your diocese sponsors OpenChurch', type: 'text',
        content: 'Parishes affiliated with a subscribing diocese ride the diocesan contract. This page doesn\u2019t show that sponsorship yet, so check with your diocese if you have questions.' },
    ],
    tips: [],
  },

  // ── Audit log ─────────────────────────────────────────────────────────────
  audit: {
    name: 'Audit log', group: 'Admin',
    overview: 'Who changed what, and when (admin): changes to members, the register, Mass intentions, donations and funds, the calendar, and parish settings are logged — because a parish record system must be able to answer \u201cwho edited this?\u201d Not everything is logged yet: recurring service templates, swaps accepted from a swap link, and AI Studio activity don\u2019t appear here.',
    features: ['Logged changes with user and summary', 'Filter by area and time'],
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

// SP-014..022: the Viewer column is fixed here, after the table, so it holds
// whichever Billing/Finance option (ux-legal 0005a or 0005b) shaped the rows
// above. A Viewer reads only the rows named below; the server enforces the
// same list (server/src/middleware/viewerScope.js).
const VIEWER_ROWS = new Set([
  'Dashboard, Schedule, Members, Mass Intentions (view)',
  'Report a problem; use the Assistant',
])
function fixViewerColumn(table) {
  for (const row of table) row.viewer = VIEWER_ROWS.has(row.area)
  return table
}

// ─── Role permission table ──────────────────────────────────────────────────
export const ROLE_TABLE = fixViewerColumn([
  { area: 'Dashboard, Schedule, Members, Mass Intentions (view)', admin: true, staff: true, viewer: true },
  { area: 'Add/edit members, events, intentions, donations', admin: true, staff: true, viewer: false },
  { area: 'Confirm register drafts (permanent record)', admin: true, staff: true, viewer: false },
  { area: 'Groups, Forms, Bulletin, Pledges, Finance', admin: true, staff: false, viewer: false },
  { area: 'Insights, Team, Org details, Billing, Audit log', admin: true, staff: false, viewer: false },
  { area: 'Donation refunds, voiding a confirmed cash count', admin: true, staff: false, viewer: false },
  { area: 'Request a void of a confirmed cash count (an admin approves)', admin: true, staff: true, viewer: false },
  { area: 'Report a problem; use the Assistant', admin: true, staff: true, viewer: true },
])

// ─── Cross-cutting tips ─────────────────────────────────────────────────────
export const TIPS = [
  'Search with \u2318K — members, events, tasks, staff and donations. Register entries are found with the Register\u2019s own search.',
  'Every screen with a printer icon prints clean: certificates, the sacristy manifest, giving statements, checklists.',
  'Bilingual parishes: set each member\u2019s preferred language and your communications follow it.',
  'The [Sample] data on new parishes clears in one action from the Dashboard banner (Clear sample data) without touching anything real.',
  'Dark mode lives at the bottom of the sidebar; the liturgical colors are tuned for both themes.',
]

// ─── FAQ ────────────────────────────────────────────────────────────────────
export const FAQ = [
  { q: 'Is there a self-serve 60-day parallel-proof onboarding?',
    a: 'No. That guarantee was removed. Fresh parishes get [Sample] rows you can clear from the Dashboard, plus Getting settled suggestions — not a timed parallel-proof product promise.' },
  { q: 'How do I record a baptism from the old paper register?',
    a: 'Register → Digitize. Type the paper entry as a draft, review it, then confirm it into the permanent record. Nothing becomes permanent without that explicit confirmation. Type the certificate number exactly as the book has it; OpenChurch doesn\u2019t number entries or check for duplicates.' },
  { q: 'Someone needs a baptismal certificate from 1987. What\u2019s the fastest path?',
    a: 'Digitize just that entry (Register → Digitize), confirm it, open the record, and print the certificate. You don\u2019t need to digitize the whole book first.' },
  { q: 'How do I print this week\u2019s Mass intentions for the sacristy?',
    a: 'Intentions → Weekly sheet. It prints the week\u2019s intentions (Saturday through Friday) with the Mass each is assigned to and its requester — one sheet for the sacristy counter. Masses with no intention are not listed.' },
  { q: 'How do I enter an All Souls envelope with several names?',
    a: 'One intention for the family (or the group), with the individual departed names in the Note. The weekly sheet and Sunday Packet show that note to the celebrant. OpenChurch has no separate Book of the Dead list.' },
  { q: 'How do I move (reschedule) an intention to another date or Mass?',
    a: 'Intentions → Edit on the row → change date to the new day, then change Mass to one on that day (or \u201cAdd a Mass on this date\u201d) → Save changes. The toast names the new date.' },
  { q: 'Why aren\u2019t Mass offerings in my Donations totals?',
    a: 'By design. Offerings (stipends) are canonically restricted money recorded in the intention book, not the giving ledger — so offertory totals and year-end statements stay clean. In Finance they are held as money owed for the Masses (account 2330), not income, and they don\u2019t count toward the diocesan assessment.' },
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
    a: 'No — from the swap link you sent them, they ask a specific member to take it, and that member accepts from their own swap link; no login needed. Once it\u2019s accepted, the schedule updates and any queued serving reminder moves to the new person if they can get one (an email on file, reminders not turned off, and the reminder time not already past). A reminder hiccup never undoes the swap, and this isn\u2019t a delivery guarantee. OpenChurch doesn\u2019t check who is trained for the role, so they should ask someone who already serves in it.' },
  { q: 'Can volunteers see the schedule without being able to change anything?',
    a: 'Yes — add them as viewers (Team). Viewers see the Dashboard, Members, Schedule and Mass Intentions (read-only) and cannot change parish records (they can still update their own profile, preferences and support tickets); the API itself enforces both. On Members they don\u2019t see private notes or birth years. Giving, payroll, attendance, the archive, events and tasks stay with staff and admins. Finance is admin-only (same as the Roles table).' },
  { q: 'How do I move us off our old system?',
    a: 'Members → Import CSV for the census; funds first, then donation history; digitize register entries as needed via Drafts. The [Sample] data clears in one action when you\u2019re ready.' },
  { q: 'Is OpenChurch in Spanish?',
    a: 'S\u00ed, mostly. Each user picks English or Spanish in Preferences, and most screens follow it; a few, including parts of Donations and Check-in, are still English-only while translation finishes. Members have a preferred language, and notifications to them follow it.' },
  { q: 'What happens to sacramental records if I delete a member?',
    a: 'They remain in the Register, unlinked. The register is the permanent parish record and deliberately outlives the roster.' },
  { q: 'Where do I report a bug or something confusing?',
    a: 'Right here — the Report a Problem tab in this panel. Describe what happened; the report reaches the maintainers with the page you were on. An automatic first-pass diagnosis is added only when OpenChurch\u2019s own triage service is available, so don\u2019t count on one.' },
  { q: 'Is there a limit on Assistant questions?',
    a: 'Yes. Separate from your AI provider\u2019s own rate limits, OpenChurch answers a set number of Assistant questions per parish each day. The count starts over at midnight in your parish\u2019s timezone (Org details). When the day\u2019s limit is reached, the Help panel and user guide still work.' },
  { q: 'Does the AI assistant answer canon-law questions?',
    a: 'No — it will warmly point you to your pastor or the chancery. It helps with the software and everyday office operations; canonical questions deserve a canonist.' },
  { q: 'What does OpenChurch cost?',
    a: 'OpenChurch is free during the open beta. Pricing will be announced before general launch.' },
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
