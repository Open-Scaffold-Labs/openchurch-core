/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Body UI stays familiar & readable.
        sans:  ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        // Used for headlines, the wordmark, stat numerals, and anywhere we
        // want the app to feel liturgical rather than SaaS.
        serif: ['"Cormorant Garamond"', 'Georgia', 'Cambria', 'Times New Roman', 'serif'],
      },
      colors: {
        // `church` is now anchored in a deep burgundy — used for primary
        // actions, the brand mark, avatars, and accent text. Kept under the
        // same name so every existing `bg-church-900` / `text-church-700`
        // call lands on the new palette without a sweep.
        church: {
          50:  '#FBEEEE',
          100: '#F6D6D3',
          200: '#EAB0AB',
          300: '#D88480',
          400: '#BB5A56',
          500: '#9E3A33',
          600: '#7B2D26',  // core burgundy
          700: '#5E211B',
          800: '#3F1714',
          900: '#5A1E23',  // Church Burgundy — the brand anchor (docs/brand/openmark-construction-2025)
          950: '#160705',
        },
        // Background paper tones — app body, cards, modal surfaces.
        // Desaturated from the first pass so light mode reads as bone/ivory
        // rather than buttery cream.
        parchment: {
          50:  '#FBF8F2',
          100: '#F4EFE4',
          200: '#E7DFCD',
          300: '#D2C6B0',
          400: '#B8A988',
          500: '#998C6C',
          600: '#7C7154',
          700: '#5F573F',
          800: '#443E2D',
          900: '#29251C',
          950: '#15120D',
        },
        // Aged brass / gilt — softened from bright gold to an antique
        // muted tone so accents read as a quiet flourish, not a highlight
        // marker. Used for nav indicators, focus rings, subtle dividers.
        brass: {
          50:  '#F7F0DC',
          100: '#EDDFB3',
          200: '#DFC988',
          300: '#CBB066',
          400: '#B7994F',
          500: '#B08A43',  // Warm Brass — brand core gold (docs/brand/openmark-construction-2025)
          600: '#846A34',
          700: '#69542A',
          800: '#4E3F20',
          900: '#342A16',
          950: '#1B160B',
        },
        // Warm charcoal neutrals — text and UI chrome. Replaces our reliance
        // on Tailwind's cool `slate`/`gray` for narration and body copy.
        ink: {
          50:  '#F6F4F1',
          100: '#E8E4DD',
          200: '#CEC6BB',
          300: '#AFA395',
          400: '#8D8071',
          500: '#6C6054',  // nudged 2pts darker: #6E6256 missed AA on parchment-200 by 0.03
          600: '#564C42',
          700: '#413932',
          800: '#2F2A25',  // default body text
          900: '#1C1916',
          950: '#0E0C0A',  // dark-mode background
        },
      },
      boxShadow: {
        card:         '0 1px 4px 0 rgb(0 0 0 / 0.07), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        'card-hover': '0 10px 28px -5px rgb(0 0 0 / 0.1), 0 4px 8px -4px rgb(0 0 0 / 0.08)',
        // Warm-cast shadows — replace the old cold drop-shadow defaults for
        // surfaces sitting on parchment.
        warm:    '0 1px 3px 0 rgb(120 80 40 / 0.08), 0 1px 2px -1px rgb(120 80 40 / 0.06)',
        'warm-md': '0 4px 10px -2px rgb(120 80 40 / 0.12), 0 2px 4px -2px rgb(120 80 40 / 0.08)',
        'warm-lg': '0 10px 28px -8px rgb(120 80 40 / 0.18), 0 4px 8px -4px rgb(120 80 40 / 0.10)',
      },
    },
  },
  plugins: [],
}
