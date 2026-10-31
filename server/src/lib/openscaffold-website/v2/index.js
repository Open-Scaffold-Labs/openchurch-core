// Vendored subset of @openscaffold/website v2 libraries for OpenChurch.
// OC-WEB-1 PR-C: blocks, connectors, looks, SEO helpers, settings contract.
// Deliberately omitted: mcpTools, vercelDomainManager (PR-K / out of scope),
// and the Day-1 schema/routers (OpenChurch owns persistence + auth).

const settingsContract = require('./settingsContract');
const designLookEngine = require('./designLookEngine');
const blocks = require('./blocks');
const seoAndLlms = require('./seoAndLlms');
const connectors = require('./connectors');

module.exports = {
  ...settingsContract,
  ...designLookEngine,
  ...blocks,
  ...seoAndLlms,
  ...connectors,
};
