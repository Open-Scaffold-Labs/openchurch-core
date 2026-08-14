import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// PWA config (Sprint PWA / PWA.1a, expanded in PWA.4b).
//
// Strategy: 'injectManifest' — we own client/src/sw.js so we can wire
// our own push + notificationclick listeners. Workbox still handles
// the precache-manifest injection (self.__WB_MANIFEST) and the runtime
// caching strategies live inside sw.js (which is built like any other
// Vite entry, so the workbox-* imports tree-shake into the final SW).
//
// Why we left generateSW: that mode owns the SW file and exposes only
// declarative knobs. Push API listeners need procedural code, so we
// switched to injectManifest and moved the runtime caching from this
// config into sw.js where the listeners live.
//
// Branding deliberately generic at the manifest level so per-parish
// deploys can override name + theme color via a customization layer
// later. Theme color matches the Parchment & Brass palette
// (church-600 burgundy as primary, parchment-50 as background).

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      // 'prompt' (PWA.6) — installed users opt into a new bundle via
      // <UpdatePrompt>'s Refresh button instead of having the SW silently
      // swap mid-task. The plugin's updateSW() helper sends a
      // SKIP_WAITING message; sw.js listens for it.
      registerType: 'prompt',
      strategies:   'injectManifest',
      srcDir:       'src',
      filename:     'sw.js',
      includeAssets: ['favicon.ico', 'icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'OpenChurch',
        short_name: 'OpenChurch',
        description: 'A liturgical-first church operating system.',
        theme_color: '#7B2D26',       // church-600 burgundy
        background_color: '#FBF8F2',  // parchment-50
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          // SVG icon — modern PWA installers (Android / Chrome) accept
          // SVG via purpose: 'any'. iOS still expects PNG via the
          // apple-touch-icon <link>, which is wired in index.html.
          // Replace this and add PNG variants (192, 512, maskable) per
          // your parish branding before public launch.
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // Static app shell — pre-cached at install so the SPA boots
        // offline. Built output is fingerprinted, so Workbox can
        // safely cache it indefinitely; the manifest gets a new
        // entry per build and old caches are purged.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Bump above the 2 MiB default. The bundled SW is well under
        // that today; leave headroom for additional handlers without
        // forcing a config-tweak commit later.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        // Service worker is DISABLED in `npm run dev`. With it on, the
        // SW precaches the app shell and serves stale bundles on
        // reload — code edits silently don't appear, which is a
        // miserable dev loop. To smoke-test PWA behavior (install /
        // offline / push) run a production-like build instead:
        //   npm run build && npm run preview
        // The SW is fully active in that path and in every deploy.
        enabled: false,
        type: 'module',
      },
    }),
  ],
  server: {
    port: 5202,
    proxy: {
      '/api': 'http://localhost:3034',
    },
  },
  // Same proxy for `vite preview`, so the production bundle can be exercised
  // against the local API. Some bugs only appear in the prod build — the
  // ConfirmProvider overlay that never unmounted was invisible in dev.
  preview: {
    port: 4173,
    proxy: {
      '/api': 'http://localhost:3034',
    },
  },
}))
