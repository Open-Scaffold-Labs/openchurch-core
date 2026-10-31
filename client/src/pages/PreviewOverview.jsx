import { useEffect } from 'react'
import OpenMark from '../components/OpenMark'
import { useLocale } from '../i18n'

// Stage 11 protected preview (DRAFT, not for publication).
// - Rendered only when the build sets VITE_OC_PREVIEW=1 (see App.jsx). A
//   normal build, including any Vercel preview or production build where the
//   variable is unset, does not register the route at all.
// - noindex meta + X-Robots-Tag (vercel.json) on /preview/*.
// - Every capability line maps to a DRAFT row in the private claims
//   register (withheld from the public snapshot). No price, no tracking, no
//   third-party assets. The call to action is disabled on purpose.
// Strings stay local to this file so the shared i18n table (owned by #334's
// lane) is not edited.
export const PREVIEW_COPY = {
  en: {
    banner: 'Private preview — not published, not for distribution. Wording is draft and unapproved.',
    title: 'OpenChurch',
    tagline: 'Stewardship. Order. Worship.',
    intro: 'Parish administration software built around the work a parish office already does.',
    capsHeading: 'What the software does today',
    caps: [
      ['C1', 'A sacramental register with printable certificates.'],
      ['C2', 'Mass intentions with a printable sacristy sheet for the week, Saturday vigil through Friday by default.'],
      ['C3', 'Children’s check-in where new check-out audit records do not store the pickup code.'],
      ['C4', 'Most screens are available in English and Spanish; some settings text is still English only.'],
      ['C6', 'A signed-in person can close their own login from Preferences.'],
    ],
    imageAlt: 'Decorative synthetic illustration: brass lines on parchment.',
    cta: 'Sign-up is not open in this preview',
    ctaNote: 'This button is disabled. Pricing and availability are not announced.',
    lang: 'Language',
    skip: 'Skip to content',
  },
  es: {
    banner: 'Vista previa privada: no publicada ni para distribución. El texto es un borrador sin aprobar.',
    title: 'OpenChurch',
    tagline: 'Administración. Orden. Culto.',
    intro: 'Software de administración parroquial construido en torno al trabajo que ya hace la oficina parroquial.',
    capsHeading: 'Lo que hace el software hoy',
    caps: [
      ['C1', 'Un registro sacramental con certificados imprimibles.'],
      ['C2', 'Intenciones de misa con una hoja imprimible para la sacristía de la semana, de la vigilia del sábado al viernes por defecto.'],
      ['C3', 'Registro de entrada de niños en el que los nuevos registros de auditoría de salida no guardan el código de recogida.'],
      ['C4', 'La mayoría de las pantallas están en inglés y español; parte del texto de configuración sigue solo en inglés.'],
      ['C6', 'Una persona con sesión iniciada puede cerrar su propio acceso desde Preferencias.'],
    ],
    imageAlt: 'Ilustración sintética decorativa: líneas de latón sobre pergamino.',
    cta: 'El registro no está abierto en esta vista previa',
    ctaNote: 'Este botón está desactivado. No se han anunciado precios ni disponibilidad.',
    lang: 'Idioma',
    skip: 'Saltar al contenido',
  },
}

function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    return () => { meta.remove() }
  }, [])
}

export default function PreviewOverview() {
  useNoIndex()
  const { locale, setLocale } = useLocale()
  const c = PREVIEW_COPY[locale] ?? PREVIEW_COPY.en
  return (
    <div lang={locale === 'es' ? 'es' : 'en'} className="min-h-screen bg-parchment-50 text-ink-800 dark:bg-ink-950 dark:text-parchment-100">
      <a href="#preview-main" className="sr-only focus:not-sr-only focus:absolute focus:p-2 focus:bg-parchment-100">{c.skip}</a>
      <p role="note" className="bg-brass-100 text-ink-900 text-sm px-4 py-2 text-center border-b border-brass-300">{c.banner}</p>
      <header className="max-w-3xl mx-auto px-6 pt-10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <OpenMark className="w-8 h-12 text-church-800 dark:text-brass-300" />
          <span className="font-serif text-2xl">{c.title}</span>
        </div>
        <nav aria-label={c.lang} className="text-sm flex gap-2">
          <button type="button" onClick={() => setLocale('en')} aria-pressed={locale !== 'es'} className="underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass-500 px-1">English</button>
          <button type="button" onClick={() => setLocale('es')} aria-pressed={locale === 'es'} className="underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass-500 px-1">Español</button>
        </nav>
      </header>
      <main id="preview-main" className="max-w-3xl mx-auto px-6 py-10">
        <p className="text-brass-700 dark:text-brass-300 tracking-wide uppercase text-sm">{c.tagline}</p>
        <h1 className="font-serif text-4xl mt-2">{c.intro}</h1>
        <svg role="img" aria-label={c.imageAlt} viewBox="0 0 600 80" className="w-full my-8 text-brass-500">
          <path d="M0 40 H600 M40 10 V70 M560 10 V70 M300 5 L320 40 L300 75 L280 40 Z" stroke="currentColor" fill="none" strokeWidth="2" />
        </svg>
        <h2 className="font-serif text-2xl mb-4">{c.capsHeading}</h2>
        <ul className="space-y-3 list-none">
          {c.caps.map(([id, text]) => (
            <li key={id} data-claim={id} className="border-l-2 border-brass-400 pl-3">{text}</li>
          ))}
        </ul>
        <div className="mt-10">
          <button type="button" disabled aria-disabled="true" className="px-5 py-3 rounded bg-ink-300 text-ink-700 cursor-not-allowed">{c.cta}</button>
          <p className="text-sm mt-2 text-ink-600 dark:text-parchment-300">{c.ctaNote}</p>
        </div>
      </main>
    </div>
  )
}
