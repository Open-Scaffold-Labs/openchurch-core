// Vitest-only stand-in for vite-plugin-pwa's `virtual:pwa-register/react`.
// Production still imports the virtual module. vitest.config.js aliases
// that specifier here so UpdatePrompt can render under jsdom without
// building a service worker. Not a policy change.

export const pwaRegisterHarness = {
  needRefresh: false,
  setNeedRefresh(value) {
    pwaRegisterHarness.needRefresh = value
  },
  updateServiceWorker() {},
}

export function useRegisterSW() {
  return {
    needRefresh: [pwaRegisterHarness.needRefresh, pwaRegisterHarness.setNeedRefresh],
    updateServiceWorker: (...args) => pwaRegisterHarness.updateServiceWorker(...args),
  }
}
