import { defineConfig, devices } from '@playwright/test';

// Serves the repo root (one level up) with Python's stdlib server so the e2e
// layer needs no extra runtime deps beyond Playwright itself. Flow tests hit
// the real DOM the way a browser would.
export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'python3 -m http.server 4173 --directory ..',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
