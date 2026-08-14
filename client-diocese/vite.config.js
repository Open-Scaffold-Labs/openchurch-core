import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// OpenDiocese chancery app (DIO.2). Port 5204 — 5202 is the parish
// client, 3034 the shared API. Same API origin, same auth; deployed as
// its own Vercel project (diocese.openchurch.app) when the team account
// lands. No PWA layer yet: this is a desk tool, not a parking-lot app.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5204,
    proxy: {
      '/api': 'http://localhost:3034',
    },
  },
})
