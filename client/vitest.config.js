// Client test runner.
//
// Deliberately NOT an extension of vite.config.js. That config registers
// VitePWA, which builds a service worker — irrelevant under jsdom, slow, and
// a source of failures that have nothing to do with the code under test. The
// test environment should be the smallest thing that can run a component.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    // The parish client talks to :3034. Nothing in a unit test should reach
    // it; every test that involves the network stubs fetch explicitly, and a
    // test that forgets should fail loudly rather than hang.
    testTimeout: 10_000,
  },
})
