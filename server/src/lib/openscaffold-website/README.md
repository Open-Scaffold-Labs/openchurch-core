# @openscaffold/website (vendored, libraries only)

Pinned from `Open-Scaffold-Labs/openscaffold-website` commit
`8138724378c055de4f1c38bc2e3c55cc3f4987a3` (`@openscaffold/website` 2.0.0).

OpenChurch OC-WEB-1 (Atlas libraries-only plan + Dale #342 answers):

- **In:** `v2/blocks`, `v2/connectors`, `v2/designLookEngine`, `v2/seoAndLlms`,
  `v2/settingsContract`, `a11y`.
- **Out:** `createWebsiteSchema`, Dale admin/public routers, `siteImporter`
  auto-publish, `vercelDomainManager` (custom domains wait for PR-K).

Parish persistence lives in `ochr_site_documents` (migration 142). The
OpenChurch allowlist and bilingual field rules live in `server/src/website/`.
