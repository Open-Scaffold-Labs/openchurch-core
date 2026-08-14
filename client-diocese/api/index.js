// Vercel serverless entry point for the OpenDiocese (chancery) deployment.
//
// The chancery client is a separate Vercel project with Root Directory =
// client-diocese, so it can't reach the repo-root api/index.js the parish
// project uses. We re-export the SAME Express app here to keep /api/diocese/*
// (and /api/auth/*) same-origin with the chancery SPA — same code, same auth,
// same shared database. `openchurch-server` is wired in as a file: dependency
// (see package.json) so the server's own dependency tree resolves inside this
// isolated build root; there is no second copy of the server to maintain.
//
// app.js never calls listen() — it just exports the app — so it is safe to
// import once per cold-start and reuse across warm invocations. Migrations do
// NOT run here (only server/src/index.js boots them); the CI deploy job runs
// them against prod before either project ships.
import app from 'openchurch-server/src/app.js'

export default app
