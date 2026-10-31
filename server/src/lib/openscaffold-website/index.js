/**
 * @openscaffold/website — libraries only (OpenChurch OC-WEB-1).
 *
 * Upstream: Open-Scaffold-Labs/openscaffold-website @ 8a42e47073d910d2e8edee4600b5ce0c965c6885
 * Package: @openscaffold/website 2.0.0
 *
 * Consumed as vendored source (same pattern as openscaffold-schedule).
 * OpenChurch does NOT call createWebsiteSchema or mount Dale's admin/public
 * routers — persistence, auth, and the /p/:slug gate stay OC-native.
 */

const v2 = require('./v2');
const { contrast, textOn, publicationState } = require('./a11y');

module.exports = {
  ...v2,
  contrast,
  textOn,
  publicationState,
  UPSTREAM: Object.freeze({
    name: '@openscaffold/website',
    version: '2.0.0',
    commit: '8a42e47073d910d2e8edee4600b5ce0c965c6885',
    surface: 'v2-libraries-only',
  }),
};
