// Vercel serverless entry point.
//
// Vercel automatically routes any request matching /api/* into this
// catch-all file. We delegate straight to the Express app — the routes
// defined inside app.js (`/api/clients`, `/api/auth/login`, etc.) handle
// the request as they would in a standalone server.
//
// The app is imported once per cold-start and reused across warm
// invocations, so request latency stays low on subsequent hits.

import app from '../server/src/app.js'

export default app
