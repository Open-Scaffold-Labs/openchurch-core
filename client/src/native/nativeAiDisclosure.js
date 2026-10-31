// The agreement text this build can show, and the version that names it.
// Changing any string here without changing the version would let a person
// agree to words this screen does not display. The server records only a
// version that matches what it currently requires, and it refuses any other.

export const NATIVE_AI_DISCLOSURE_VERSION = 'draft-2026-10-24'

export const NATIVE_AI_DISCLOSURE = {
  version: NATIVE_AI_DISCLOSURE_VERSION,
  en: {
    draft: 'DRAFT — pending approval. This is not the privacy policy.',
    title: 'Before any AI help.',
    lead: 'This is the screen where you choose AI for your own login in this app. It is not the privacy policy. Nothing is sent until you agree. If you choose Not now, AI stays off.',
    parish: 'AI Studio, the assistant, and Improve on a note use your parish’s own Anthropic or OpenAI key. OpenChurch does not add a key for those. The text you submit — a draft prompt, an assistant question, or the note you ask to improve — goes to that provider.',
    triage: 'A problem report is still saved for a person either way. If you agree, the report’s description may also be sent to Anthropic on Open Scaffold Labs’ account for a first look.',
    later: 'You can withdraw this agreement in Preferences. Until you agree, AI in this app stays off.',
  },
  es: {
    draft: 'BORRADOR — pendiente de aprobación. Esto no es la política de privacidad.',
    title: 'Antes de cualquier ayuda con IA.',
    lead: 'En esta pantalla usted elige la IA para su propio acceso en esta aplicación. No es la política de privacidad. No se envía nada hasta que acepte. Si elige Ahora no, la IA permanece apagada.',
    parish: 'Estudio IA, el asistente y Mejorar en una nota usan la clave propia de su parroquia en Anthropic u OpenAI. OpenChurch no añade una clave para eso. El texto que usted envía — un borrador, una pregunta al asistente o la nota que pide mejorar — va a ese proveedor.',
    triage: 'Un informe de problema se guarda para una persona de todas formas. Si acepta, la descripción del informe también puede enviarse a Anthropic en la cuenta de Open Scaffold Labs para una primera mirada.',
    later: 'Puede retirar este acuerdo en Preferencias. Hasta que acepte, la IA en esta aplicación permanece apagada.',
  },
}
