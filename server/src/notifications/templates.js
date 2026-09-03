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
    subject_es:        'Aniversarios sacramentales esta semana — {{count}} en {{church_name}}',
    body_text_es:
`Hola {{recipient_name}}:

Estos miembros de {{church_name}} cumplen un aniversario sacramental en los próximos días. Cada entrada incluye una nota preparada que usted puede personalizar y enviar — todavía no se ha enviado nada a nadie.

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
    subject_es:        'Recordatorio: {{event_title}} el {{event_date}}',
    body_text_es:
`Hola {{recipient_name}}:

Le recordamos que le corresponde servir en {{event_title}} el {{event_date}} a las {{event_time}}.{{liturgical_line}}
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
    subject_es:        'Tarea próxima a vencer: {{task_title}}',
    body_text_es:
`Hola {{recipient_name}}:

La tarea «{{task_title}}» vence {{due_date_human}}.

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
    subject_es:        'Le hemos añadido a {{event_title}}',
    body_text_es:
`Hola {{recipient_name}}:

Le hemos añadido a {{event_title}} el {{event_date}} a las {{event_time}}.{{liturgical_line}}
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
    subject_es:        'Mañana: el cumpleaños de {{member_name}}',
    body_text_es:
`Hola {{recipient_name}}:

Un pequeño aviso para mañana — es el cumpleaños de {{member_name}} ({{birthday_date}}).

Una tarjeta, una llamada o unas palabras después de la misa significan mucho.

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
    subject_es:        'Mañana: {{member_name}} cumple {{years}} años en la parroquia',
    body_text_es:
`Hola {{recipient_name}}:

Mañana se cumplen {{years}} año(s) desde que {{member_name}} se unió a la
parroquia ({{anniversary_date}}). Vale la pena reconocerlo.

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
    subject_es:        '{{requester_name}} desea intercambiar un servicio con usted',
    body_text_es:
`Hola {{target_name}}:

{{requester_name}} le pregunta si puede tomar su turno en
{{event_title}} el {{event_date}} a las {{event_time}}.

{{note}}

Use su enlace de intercambio para aceptar o rechazar.

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
    subject_es:        '{{target_name}} aceptó su intercambio',
    body_text_es:
`Buenas noticias: {{target_name}} aceptó el intercambio. Usted ya no figura
en el turno de ese servicio; ahora le corresponde a esa persona.

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
    subject_es:        '{{target_name}} rechazó su intercambio',
    body_text_es:
`{{target_name}} no puede tomar ese turno. Usted sigue en el turno del
servicio — puede pedírselo a otra persona o hablar con el encargado de su
equipo.

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
    subject_es:        '{{requester_name}} canceló su solicitud de intercambio',
    body_text_es:
`{{requester_name}} canceló su solicitud de intercambio. No hace falta que
usted haga nada.

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
    subject_es:        'Su reporte en {{church_name}}: {{status_label}}',
    body_text_es:
`Hola {{recipient_name}}:

Una actualización sobre el problema que usted reportó («{{description_short}}»):

Estado: {{status_label}}{{notes_block}}

Puede ver todos sus reportes en Ayuda → Reportar un problema.

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
    subject_es:        'Su ofrenda a {{church_name}} — recibo',
    body_text_es:
`Hola {{donor_name}}:

Gracias por su ofrenda de {{amount}} para {{fund}} el {{date}}.

Referencia: {{reference}}

— {{church_name}}
`,
  },

  // The donor hears first, and privately. Written to be read by somebody who
  // did nothing wrong: a card expires, that is all. No "failed", no "declined",
  // no urgency — a gift that does not arrive this month is not an emergency,
  // and treating it as one is how a parish makes a person feel chased.
  recurring_gift_needs_attention: {
    notification_type: 'recurring_gift_needs_attention',
    label:             'Recurring gift needs attention',
    description:       "Sent to a donor when their recurring gift could not be taken — usually an expired card.",
    default_enabled:   true,
    subject:           'Your recurring gift to {{church_name}}',
    body_text:
`Hello {{donor_name}},

We were not able to take your {{frequency}} gift of {{amount}} this time.
This is almost always an expired or replaced card, and nothing has been
charged.

You can set it up again here whenever it suits you:
{{giving_url}}

If you would rather stop the gift, you can simply ignore this — we will not
keep trying.

Thank you for your generosity.

— {{church_name}}
`,
    subject_es:        'Su ofrenda periódica a {{church_name}}',
    body_text_es:
`Hola {{donor_name}}:

No pudimos cobrar su ofrenda {{frequency}} de {{amount}} esta vez. Casi
siempre se trata de una tarjeta vencida o reemplazada, y no se ha cobrado
nada.

Puede volver a configurarla aquí cuando le convenga:
{{giving_url}}

Si prefiere suspender la ofrenda, puede simplemente ignorar este mensaje — no
seguiremos intentándolo.

Gracias por su generosidad.

— {{church_name}}
`,
  },

  // Only after the donor has had three chances to fix it quietly. This one
  // goes to the office, and its job is to prompt a conversation, not to
  // produce a collections task.
  // The donor's LAST message, sent when the gift is paused. Without it the
  // last thing they heard was "we will try again" — while the parish was
  // being told they had been notified every time. Both halves of that were
  // wrong, and this is the half that owed the donor something.
  recurring_gift_stopped: {
    notification_type: 'recurring_gift_stopped',
    label:             'Recurring gift stopped',
    description:       "Sent to a donor when their recurring gift has been stopped after repeated attempts.",
    default_enabled:   true,
    subject:           'Your recurring gift to {{church_name}} has stopped',
    body_text:
`Hello {{donor_name}},

We have stopped trying to take your gift of {{amount}}. Nothing was charged
on any attempt, and there is nothing you need to do.

If you would like to start it again, you can do that here:
{{giving_url}}

Thank you for your generosity.

— {{church_name}}
`,
    subject_es:        'Su ofrenda periódica a {{church_name}} se ha detenido',
    body_text_es:
`Hola {{donor_name}}:

Hemos dejado de intentar cobrar su ofrenda de {{amount}}. No se cobró nada en
ningún intento y usted no tiene que hacer nada.

Si desea volver a activarla, puede hacerlo aquí:
{{giving_url}}

Gracias por su generosidad.

— {{church_name}}
`,
  },

  recurring_gift_paused: {
    notification_type: 'recurring_gift_paused',
    label:             'Recurring gift paused',
    description:       'Sent to the parish when a recurring gift has stopped after repeated attempts.',
    default_enabled:   true,
    subject:           'A recurring gift has stopped — {{donor_name}}',
    body_text:
`{{donor_name}}'s {{frequency}} gift of {{amount}} has stopped.

We tried {{attempts}} times between {{first_failed}} and {{last_failed}} and
let them know each time. Nothing was charged on any attempt.

Last reason given: {{last_error}}

Nothing further will be tried automatically. If you know them, a word after
Mass is usually all this needs.

— OpenChurch
`,
    subject_es:        'Una ofrenda periódica se ha detenido — {{donor_name}}',
    body_text_es:
`La ofrenda {{frequency}} de {{amount}} de {{donor_name}} se ha detenido.

Lo intentamos {{attempts}} veces entre el {{first_failed}} y el
{{last_failed}}, y avisamos a esta persona cada vez. No se cobró nada en
ningún intento.

Último motivo indicado: {{last_error}}

No se intentará nada más de forma automática. Si usted la conoce, unas
palabras después de la misa suelen ser suficiente.

— OpenChurch
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
    subject_es:        'Sus servicios de esta semana',
    body_text_es:
`Hola {{recipient_name}}:

Esto es lo que le corresponde servir esta semana:

{{events_list}}

Gracias por servir.

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
    subject_es:        'Sigue pendiente: la solicitud de intercambio de {{requester_name}}',
    body_text_es:
`Hola {{target_name}}:

{{requester_name}} sigue esperando respuesta sobre el intercambio de
{{event_title}} el {{event_date}} a las {{event_time}}.

Abra su enlace de intercambio para aceptar o rechazar.

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
// `lang` selects the wording. Every template carries English, and Spanish
// where it has been written; a template missing Spanish falls back to English
// PER FIELD rather than refusing to send. A parishioner receiving an English
// reminder is a translation gap; a parishioner receiving nothing because the
// Spanish was missing is a person who misses their serving slot.
//
// This exists because ochr_clients.preferred_language has been stored since
// migration 001 — "bilingual-first-class" — exposed on the roster, and read
// by nothing. Every notification in the product went out in English,
// including to the members a parish had explicitly recorded as preferring
// Spanish.
export function render(template, vars = {}, lang = 'en') {
  const apply = (s) => (s ?? '').replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const v = vars[key]
    return v === undefined || v === null ? '' : String(v)
  })
  // 'both' is a valid stored preference and means the person reads either.
  // English is the parish's own working language in every deployment so far,
  // so 'both' resolves to English rather than guessing.
  const wantsEs = lang === 'es'
  return {
    subject:   apply(wantsEs ? (template.subject_es   ?? template.subject)   : template.subject),
    body_text: apply(wantsEs ? (template.body_text_es ?? template.body_text) : template.body_text),
    language:  wantsEs && template.subject_es ? 'es' : 'en',
  }
}

// Lookup helper. Throws on unknown type so the caller fails loudly
// rather than silently no-op'ing.
export function getTemplate(notification_type) {
  const tpl = TEMPLATES[notification_type]
  if (!tpl) throw new Error(`Unknown notification_type: ${notification_type}`)
  return tpl
}
