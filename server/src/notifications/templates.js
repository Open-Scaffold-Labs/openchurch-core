// Notification template registry. Each template is identified by its
// `notification_type` string — that's the same id used in
// ochr_notification_prefs (so a user can toggle individual types) and
// in the trigger registry (the code that fires notify() at the right
// moment).
//
// Templates are plain text with {{variable}} placeholders. Keep them
// here (not in the database) so version control captures every wording
// change. If we ever need per-org branding/customization, an org-level
// override table can sit on top of this.
//
// Format: subject + body_text. body_html is intentionally omitted for
// v1 — most providers can render plain text fine, and adding HTML
// later is a non-breaking enhancement.

export const TEMPLATES = {
  sacrament_anniversary_digest: {
    notification_type: 'sacrament_anniversary_digest',
    label:             'Sacrament anniversary digest',
    description:       'A weekly list of upcoming sacramental anniversaries, with draft outreach notes.',
    default_enabled:   true,
    subject:           'Sacrament anniversaries this week — {{count}} at {{church_name}}',
    body_text:
`Hello {{recipient_name}},

These members of {{church_name}} mark a sacramental anniversary in the coming week. Each entry includes a draft note you can personalize and send — nothing has been sent to anyone.

{{items_block}}

— OpenChurch
`,
  },

  assignment_reminder: {
    notification_type: 'assignment_reminder',
    label:             'Event reminders',
    description:       'A reminder before events you are assigned to.',
    default_enabled:   true,
    subject:           'Reminder: {{event_title}} on {{event_date}}',
    body_text:
`Hello {{recipient_name}},

This is a reminder that you're assigned to {{event_title}} on {{event_date}} at {{event_time}}.{{liturgical_line}}
{{event_location_line}}

— OpenChurch
`,
  },

  task_due_reminder: {
    notification_type: 'task_due_reminder',
    label:             'Task due reminders',
    description:       'A reminder before tasks assigned to you fall due.',
    default_enabled:   true,
    subject:           'Task due soon: {{task_title}}',
    body_text:
`Hello {{recipient_name}},

The task "{{task_title}}" is due {{due_date_human}}.

{{task_description_line}}

— OpenChurch
`,
  },

  event_assignment_added: {
    notification_type: 'event_assignment_added',
    label:             'New event assignments',
    description:       'A notification when you are added to an event roster.',
    default_enabled:   true,
    subject:           'You’ve been added to {{event_title}}',
    body_text:
`Hello {{recipient_name}},

You've been added to {{event_title}} on {{event_date}} at {{event_time}}.{{liturgical_line}}
{{event_location_line}}

— OpenChurch
`,
  },

  member_birthday: {
    notification_type: 'member_birthday',
    label:             'Member birthdays',
    description:       'A daily heads-up when a member’s birthday is tomorrow.',
    default_enabled:   true,
    subject:           'Tomorrow: {{member_name}}’s birthday',
    body_text:
`Hello {{recipient_name}},

A small note for tomorrow — it’s {{member_name}}’s birthday ({{birthday_date}}).

A card, a call, or a quick word after service goes a long way.

— OpenChurch
`,
  },

  member_anniversary: {
    notification_type: 'member_anniversary',
    label:             'Membership anniversaries',
    description:       'A daily heads-up when a member’s anniversary in the church is tomorrow.',
    default_enabled:   true,
    subject:           'Tomorrow: {{member_name}} marks {{years}} years',
    body_text:
`Hello {{recipient_name}},

Tomorrow marks {{years}} year(s) since {{member_name}} joined the church
({{anniversary_date}}). Worth acknowledging.

— OpenChurch
`,
  },
  swap_requested: {
    notification_type: 'swap_requested',
    label:             'Swap requests',
    description:       'When another member asks to swap an event with you.',
    default_enabled:   true,
    subject:           '{{requester_name}} wants to swap an event with you',
    body_text:
`Hello {{target_name}},

{{requester_name}} is asking if you can take their slot for
{{event_title}} on {{event_date}} at {{event_time}}.

{{note}}

Use your swap link to accept or decline.

— OpenChurch
`,
  },

  swap_accepted: {
    notification_type: 'swap_accepted',
    label:             'Swap accepted',
    description:       'When the member you asked accepts your swap.',
    default_enabled:   true,
    subject:           '{{target_name}} accepted your swap',
    body_text:
`Good news — {{target_name}} accepted the swap. You're off the rota
for that event; they're on it.

— OpenChurch
`,
  },

  swap_declined: {
    notification_type: 'swap_declined',
    label:             'Swap declined',
    description:       'When the member you asked declines your swap.',
    default_enabled:   true,
    subject:           '{{target_name}} declined your swap',
    body_text:
`{{target_name}} can't take that slot. You're still on the rota for
the event — try asking someone else, or talk to your team lead.

— OpenChurch
`,
  },

  swap_cancelled: {
    notification_type: 'swap_cancelled',
    label:             'Swap cancelled',
    description:       'When the member who asked to swap with you cancels their request.',
    default_enabled:   true,
    subject:           '{{requester_name}} cancelled their swap request',
    body_text:
`{{requester_name}} cancelled their swap request. No action needed
from you.

— OpenChurch
`,
  },

  support_ticket_update: {
    notification_type: 'support_ticket_update',
    label:             'Support report updates',
    description:       'A note when a problem you reported is resolved or needs something from you.',
    default_enabled:   true,
    subject:           'Your report at {{church_name}}: {{status_label}}',
    body_text:
`Hello {{recipient_name}},

An update on the problem you reported ("{{description_short}}"):

Status: {{status_label}}{{notes_block}}

You can see every report you've sent under Help → Report a Problem.

— OpenChurch
`,
  },

  donation_receipt: {
    notification_type: 'donation_receipt',
    label:             'Giving receipts',
    description:       'A receipt sent to a donor after an online gift.',
    default_enabled:   true,
    subject:           'Your gift to {{church_name}} — receipt',
    body_text:
`Hello {{donor_name}},

Thank you for your gift of {{amount}} to {{fund}} on {{date}}.

Reference: {{reference}}

— {{church_name}}
`,
  },

  weekly_serving_digest: {
    notification_type: 'weekly_serving_digest',
    label:             'Weekly serving digest',
    description:       'A weekly summary of the events you are serving this week.',
    default_enabled:   true,
    subject:           'Your serving schedule this week',
    body_text:
`Hello {{recipient_name}},

Here's what you're serving this week:

{{events_list}}

Thank you for serving.

— OpenChurch
`,
  },

  swap_pending_reminder: {
    notification_type: 'swap_pending_reminder',
    label:             'Swap request reminders',
    description:       'A nudge when a swap request is still waiting on your reply.',
    default_enabled:   true,
    subject:           'Still pending: {{requester_name}}’s swap request',
    body_text:
`Hello {{target_name}},

{{requester_name}} is still waiting to hear back about swapping
{{event_title}} on {{event_date}} at {{event_time}}.

Open your swap link to accept or decline.

— OpenChurch
`,
  },
}

// Public list for the prefs UI dropdown / settings panel.
export const NOTIFICATION_TYPES = Object.values(TEMPLATES).map(t => ({
  notification_type: t.notification_type,
  label:             t.label,
  description:       t.description,
  default_enabled:   t.default_enabled,
}))

// Render a template with the provided vars. Missing vars become an
// empty string — better to send a slightly thin notification than
// to crash on a "Hi {{recipient_name}}" with no name on file.
//
// Only the strings inside the matched {{var}} tokens are interpolated
// — no expression evaluation, no eval, no risk of injection from
// template content (templates are static, vars are values).
export function render(template, vars = {}) {
  const apply = (s) => (s ?? '').replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const v = vars[key]
    return v === undefined || v === null ? '' : String(v)
  })
  return {
    subject:   apply(template.subject),
    body_text: apply(template.body_text),
  }
}

// Lookup helper. Throws on unknown type so the caller fails loudly
// rather than silently no-op'ing.
export function getTemplate(notification_type) {
  const tpl = TEMPLATES[notification_type]
  if (!tpl) throw new Error(`Unknown notification_type: ${notification_type}`)
  return tpl
}
