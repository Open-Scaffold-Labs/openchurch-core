// Server-side message catalogue (MIG.1.1, scope 3).
//
// The Migration Studio's server messages were English sentences returned
// as `{ error: "..." }`. The client rendered them verbatim, so a parish
// working in Spanish got Spanish navigation, Spanish headings, and
// English explanations at the exact moment something had gone wrong —
// which is the moment a person is least able to work around it.
//
// The shape here is deliberate:
//
//   key    a stable identifier. It is the contract. Clients may switch on
//          it, tests assert on it, and it never changes when the wording
//          does.
//   en/es  the sentence, as a template with {named} slots.
//   vars   the values. They are DATA — a person's name, an email, a fund
//          — and are interpolated, never translated. Nothing canonical or
//          sensitive is machine-translated at request time; a parish's own
//          words come back exactly as they were typed.
//
// A response carries all three:
//
//   { error: <English>, code: <key>, message: { en, es }, vars: {...} }
//
// `error` stays English and stays first for compatibility: every existing
// caller, test and log line reads it. `message` is what a localized UI
// renders, choosing by the reader's language rather than the server's
// guess. Both are produced from the same template, so they cannot drift.
//
// Adding a message means adding BOTH languages. A key with only English
// is caught by a test, not by a Spanish-speaking secretary.

const CATALOGUE = {
  // ── reading the file ──────────────────────────────────────────────────
  'import.kind_invalid': {
    en: 'Choose what this file contains: members, funds, or gifts.',
    es: 'Elija qué contiene este archivo: miembros, fondos u ofrendas.',
  },
  'import.file_empty': {
    en: 'The file appears to be empty.',
    es: 'El archivo parece estar vacío.',
  },
  'import.file_too_large': {
    en: 'This file is larger than the Studio can read in one import. Split it and import in parts.',
    es: 'Este archivo es más grande de lo que el Estudio puede leer de una vez. Divídalo e impórtelo por partes.',
  },
  'import.file_unreadable': {
    en: 'This file could not be read as a CSV. Export it as UTF-8 CSV and try again.',
    es: 'No se pudo leer este archivo como CSV. Expórtelo como CSV en UTF-8 e inténtelo de nuevo.',
  },
  'import.headings_missing': {
    en: 'The first row must be column headings.',
    es: 'La primera fila debe contener los encabezados de las columnas.',
  },
  'import.no_rows': {
    en: 'The file has headings but no rows.',
    es: 'El archivo tiene encabezados pero ninguna fila.',
  },
  'import.too_many_rows': {
    en: 'The Studio reads up to {max} rows per import. Split the file and import in parts.',
    es: 'El Estudio lee hasta {max} filas por importación. Divida el archivo e impórtelo por partes.',
  },
  'import.read_failed': {
    en: 'Failed to read the file.',
    es: 'No se pudo leer el archivo.',
  },

  // ── mapping the columns ───────────────────────────────────────────────
  'import.mapping_required': {
    en: 'A mapping is required.',
    es: 'Es necesario asignar las columnas.',
  },
  'import.field_unsupported': {
    en: '"{field}" is not a field this import supports.',
    es: '«{field}» no es un campo admitido en esta importación.',
  },
  'import.field_duplicated': {
    en: 'Two columns are mapped to the same field ({field}).',
    es: 'Dos columnas están asignadas al mismo campo ({field}).',
  },
  'import.required_unmapped': {
    en: 'A required field is not mapped yet: {fields}.',
    es: 'Falta asignar un campo obligatorio: {fields}.',
  },
  'import.mapping_failed': {
    en: 'Failed to apply the mapping.',
    es: 'No se pudo aplicar la asignación de columnas.',
  },

  // ── the rows themselves ───────────────────────────────────────────────
  'row.name_missing': {
    en: 'This row does not include a name, so it cannot be added yet.',
    es: 'Esta fila no incluye un nombre, por lo que aún no se puede agregar.',
  },
  'row.fund_name_missing': {
    en: 'This row does not include a fund name, so it cannot be added yet.',
    es: 'Esta fila no incluye el nombre de un fondo, por lo que aún no se puede agregar.',
  },
  'row.giver_missing': {
    en: 'This row does not name the giver, so it cannot be added yet.',
    es: 'Esta fila no indica quién dio la ofrenda, por lo que aún no se puede agregar.',
  },
  'row.email_malformed': {
    en: '"{email}" does not look like an email address. Fix it, or clear it and add the email later.',
    es: '«{email}» no parece una dirección de correo electrónico. Corríjala, o bórrela y agregue el correo más adelante.',
  },
  'row.amount_unreadable': {
    en: '"{value}" is not an amount this row can use. It should be a number like 25 or 25.00.',
    es: '«{value}» no es una cantidad que esta fila pueda usar. Debe ser un número como 25 o 25.00.',
  },
  'row.date_unreadable': {
    en: '"{value}" is not a date this row can use. Dates like 2025-03-09 or 3/9/2025 work.',
    es: '«{value}» no es una fecha que esta fila pueda usar. Sirven fechas como 2025-03-09 o 9/3/2025.',
  },
  'row.fund_unknown': {
    en: 'This gift names the fund "{fund}", which is not in the parish\'s fund list yet. Add the fund first (or import funds first), or leave this row for follow-up.',
    es: 'Esta ofrenda menciona el fondo «{fund}», que todavía no está en la lista de fondos de la parroquia. Agregue el fondo primero (o importe los fondos antes), o deje esta fila para dar seguimiento.',
  },

  // ── possible duplicates, each with the sentence that made it one ──────
  'dup.member_email_exists': {
    en: 'A member with the email {email} is already in the parish roster. Review before creating another record.',
    es: 'Ya hay un miembro con el correo {email} en el padrón de la parroquia. Revise antes de crear otro registro.',
  },
  'dup.member_email_in_file': {
    en: 'Another row in this file uses the email {email}.',
    es: 'Otra fila de este archivo usa el correo {email}.',
  },
  'dup.member_name_exists': {
    en: '"{name}" matches the name of an existing member. Review before creating another record.',
    es: '«{name}» coincide con el nombre de un miembro que ya existe. Revise antes de crear otro registro.',
  },
  'dup.fund_exists': {
    en: 'A fund named "{name}" already exists. Review before creating another one.',
    es: 'Ya existe un fondo llamado «{name}». Revise antes de crear otro.',
  },
  'dup.fund_in_file': {
    en: 'Another row in this file also names the fund "{name}".',
    es: 'Otra fila de este archivo también nombra el fondo «{name}».',
  },
  'dup.gift_exists': {
    en: 'A gift of ${amount} from {donor} on {date} is already recorded. Review before adding it again.',
    es: 'Ya está registrada una ofrenda de ${amount} de {donor} con fecha {date}. Revise antes de agregarla de nuevo.',
  },
  'dup.gift_in_file': {
    en: 'Another row in this file has the same giver, date, and amount.',
    es: 'Otra fila de este archivo tiene el mismo donante, la misma fecha y la misma cantidad.',
  },

  // ── review and approval ───────────────────────────────────────────────
  'import.not_found': {
    en: 'Import not found.',
    es: 'No se encontró la importación.',
  },
  'import.closed': {
    en: 'This import is closed.',
    es: 'Esta importación está cerrada.',
  },
  'import.review_not_open': {
    en: 'Review opens after the columns are mapped.',
    es: 'La revisión se abre después de asignar las columnas.',
  },
  'row.not_found': {
    en: 'Row not found.',
    es: 'No se encontró la fila.',
  },
  'row.not_reviewable': {
    en: 'This row is not reviewable.',
    es: 'Esta fila no se puede revisar.',
  },
  'row.decision_invalid': {
    en: 'A decision must be import, skip, or none.',
    es: 'La decisión debe ser importar, omitir o ninguna.',
  },
  'row.import_anyway_only_duplicates': {
    en: 'Only a possible duplicate can be marked "import anyway".',
    es: 'Solo un posible duplicado puede marcarse como «importar de todos modos».',
  },
  'import.not_reviewed': {
    en: 'Only a reviewed import can be approved.',
    es: 'Solo se puede aprobar una importación que ya fue revisada.',
  },
  'import.nothing_ready': {
    en: 'Nothing is ready to import — every row is held, skipped, or awaiting review.',
    es: 'No hay nada listo para importar: todas las filas están retenidas, omitidas o pendientes de revisión.',
  },
  'import.commit_failed': {
    en: 'The import could not be completed. Nothing was added — the batch is unchanged and can be tried again.',
    es: 'No se pudo completar la importación. No se agregó nada: el lote quedó igual y puede intentarse de nuevo.',
  },
  'import.already_closed': {
    en: 'This import is already closed.',
    es: 'Esta importación ya está cerrada.',
  },

  // ── authorization ─────────────────────────────────────────────────────
  'import.approval_forbidden': {
    en: 'Only a parish administrator can approve an import. You can prepare and review it, and ask an administrator to approve it.',
    es: 'Solo un administrador de la parroquia puede aprobar una importación. Usted puede prepararla y revisarla, y pedirle a un administrador que la apruebe.',
  },

  // ── retention ─────────────────────────────────────────────────────────
  'import.rows_purged': {
    en: 'The rows read from this file are no longer kept. They are removed {days} days after an import is finished or closed. The receipt for this import is still here.',
    es: 'Ya no se conservan las filas leídas de este archivo. Se eliminan {days} días después de que una importación termina o se cierra. El comprobante de esta importación sigue disponible.',
  },
  'import.rows_purged_cannot_commit': {
    en: 'This import can no longer be approved: the rows read from the file were removed {days} days after it was prepared. Start a new import from your own copy of the file.',
    es: 'Esta importación ya no se puede aprobar: las filas leídas del archivo se eliminaron {days} días después de prepararla. Comience una importación nueva desde su propia copia del archivo.',
  },
  'import.retention_notice': {
    en: 'The rows read from your file are kept for {days} days so you can review or finish this import, then removed. The receipt, the counts, and the reasons anything was held stay with the parish permanently. The file itself is never stored.',
    es: 'Las filas leídas de su archivo se conservan durante {days} días para que pueda revisar o terminar esta importación, y luego se eliminan. El comprobante, los totales y los motivos por los que algo quedó retenido permanecen en la parroquia de forma permanente. El archivo en sí nunca se almacena.',
  },

  // ── things that only fail because something is wrong with us ──────────
  'import.history_failed': {
    en: 'Failed to load import history.',
    es: 'No se pudo cargar el historial de importaciones.',
  },
  'import.load_failed': {
    en: 'Failed to load import.',
    es: 'No se pudo cargar la importación.',
  },
  'import.rows_load_failed': {
    en: 'Failed to load rows.',
    es: 'No se pudieron cargar las filas.',
  },
  'row.decision_failed': {
    en: 'Failed to record the decision.',
    es: 'No se pudo registrar la decisión.',
  },
  'import.close_failed': {
    en: 'Failed to close the import.',
    es: 'No se pudo cerrar la importación.',
  },

  // ── one column, because the separator was not ours ────────────────────
  'import.one_column': {
    en: 'Only one column was found, headed "{heading}". The file probably uses a separator this reader does not know — in Excel, use File → Save As → CSV UTF-8, or check the list separator in your regional settings.',
    es: 'Solo se encontró una columna, con el encabezado «{heading}». Es probable que el archivo use un separador que este lector no conoce: en Excel, use Archivo → Guardar como → CSV UTF-8, o revise el separador de listas en la configuración regional.',
  },
  'dup.member_name_in_file': {
    en: 'Another row in this file has the same name, "{name}".',
    es: 'Otra fila de este archivo tiene el mismo nombre, «{name}».',
  },

  // ── undoing a whole import ────────────────────────────────────────────
  'undo.not_committed': {
    en: 'Only a finished import can be undone.',
    es: 'Solo se puede deshacer una importación que ya terminó.',
  },
  'undo.already_undone': {
    en: 'This import was already undone on {date}.',
    es: 'Esta importación ya se deshizo el {date}.',
  },
  'undo.window_closed': {
    en: 'This import can no longer be undone: the rows that recorded what it added were removed {days} days after it finished. The records it created are ordinary parish records now — remove any of them one at a time if you need to.',
    es: 'Esta importación ya no se puede deshacer: las filas que registraban lo que agregó se eliminaron {days} días después de terminar. Los registros que creó ahora son registros normales de la parroquia; si necesita quitar alguno, hágalo de uno en uno.',
  },
  'undo.forbidden': {
    en: 'Only a parish administrator can undo an import.',
    es: 'Solo un administrador de la parroquia puede deshacer una importación.',
  },
  'undo.done': {
    en: 'The import was undone. {removed} records were moved to Archive & Recovery, where an administrator can put any of them back. {kept} were left alone because somebody has edited them since.',
    es: 'La importación se deshizo. {removed} registros se movieron a Archivo y recuperación, donde un administrador puede devolver cualquiera de ellos. {kept} se dejaron intactos porque alguien los editó desde entonces.',
  },
  'undo.failed': {
    en: 'The import could not be undone. Nothing was changed.',
    es: 'No se pudo deshacer la importación. No se cambió nada.',
  },

  // ── completion ────────────────────────────────────────────────────────
  'import.committed': {
    en: 'The import is finished. {imported} records were added, and a receipt is available.',
    es: 'La importación terminó. Se agregaron {imported} registros y hay un comprobante disponible.',
  },
}

const LANGS = ['en', 'es']

function fill(template, vars) {
  if (!vars) return template
  let out = template
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v))
  return out
}

// The localized pair for a key. Unknown keys throw in development rather
// than silently rendering the key at a parish — a missing message is a
// bug in this file, and it should be found here.
export function localize(key, vars) {
  const entry = CATALOGUE[key]
  if (!entry) throw new Error(`i18n: unknown message key "${key}"`)
  const out = {}
  for (const lang of LANGS) out[lang] = fill(entry[lang], vars)
  return out
}

// The response body shape. `error` first and in English so every existing
// caller, log line and test keeps working unchanged.
export function msg(key, vars) {
  const message = localize(key, vars)
  return { error: message.en, code: key, message, vars: vars ?? {} }
}

// For a stored row issue: the English sentence to persist, plus the key
// and variables that let it be re-rendered in any language later.
export function issue(key, vars) {
  return { issue: localize(key, vars).en, issue_key: key, issue_vars: vars ?? {} }
}

export const MESSAGE_KEYS = Object.keys(CATALOGUE)
export { CATALOGUE as _CATALOGUE_FOR_TESTS }
