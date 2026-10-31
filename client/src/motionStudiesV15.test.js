// V1.5 motion studies, guarded at the source (App.chrome style):
//   #7  setLocale fades the app around a language switch, and only when
//       motion is welcome;
//   #8  the just-assigned intention glows in its Mass's list;
//   #11 shared dialogs rise from the bottom on phones (useDialogMotion);
//   #12 search results arrive with a capped 30ms stagger.
// #13 (back online) is covered behaviourally in OfflineBanner.test.jsx.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(HERE, p), 'utf8')

describe('V1.5 motion studies', () => {
  it('#7 language switch fades only when motion is welcome', () => {
    const i18n = read('i18n/index.jsx')
    expect(i18n).toMatch(/if \(\(l \|\| ''\) === override \|\| !localeFadeWelcome\(\)\) return apply\(\)/)
    expect(i18n).toMatch(/prefers-reduced-motion: reduce/)
    expect(read('index.css')).toMatch(/html\[data-locale-swap\] #root/)
  })

  it('#8 the just-assigned intention glows in the Mass list only', () => {
    const src = read('components/MassIntentionAssign.jsx')
    expect(src.match(/slot-glow/g)).toHaveLength(1)
    expect(src).toMatch(/if \(path === 'assign'\) \{\s*setJustAssignedId\(intentionId\)/)
  })

  it('#11 shared dialogs use the phone-aware panel motion', () => {
    for (const f of ['components/ConfirmProvider.jsx', 'components/FeedbackModal.jsx']) {
      expect(read(f), f).toMatch(/const panelMotion = useDialogMotion\(\)/)
    }
    expect(read('utils/motion.js')).toMatch(/export const sheetRiseMotion = \{\s*initial: \{ opacity: 1, y: '100%' \}/)
  })

  it('#12 search results stagger, capped', () => {
    expect(read('components/GlobalSearchPalette.jsx')).toMatch(/className="row-arrive" style=\{\{ animationDelay: `\$\{Math\.min\(order\+\+, 8\) \* 30\}ms` \}\}/)
  })
})
