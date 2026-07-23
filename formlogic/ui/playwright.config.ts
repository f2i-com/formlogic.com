import { defineConfig, devices, type Project } from '@playwright/test';

// E2E tests run against the live WAMP-served app (no webServer is started here).
//
// PROJECTS (audit FL-29): the default run stays the system-Chrome desktop
// project (no browser download, matches the CI budget). Set PW_FULL_MATRIX=1
// to add the documented BROWSER_DEVICE_MATRIX engines — desktop Firefox,
// desktop WebKit (Safari's engine), and a phone viewport — for release runs:
//
//   npx playwright install firefox webkit   # one-time browser download
//   PW_FULL_MATRIX=1 npx playwright test
//
// The matrix projects reuse the same specs; anything genuinely device-manual
// (native pickers, PWA install, gestures) stays in docs/BROWSER_DEVICE_MATRIX.md.
const projects: Project[] = [
  {
    name: 'chrome-desktop',
    use: {
      channel: 'chrome',
      viewport: { width: 1440, height: 900 },
    },
  },
];

if (process.env.PW_FULL_MATRIX === '1') {
  projects.push(
    {
      name: 'firefox-desktop',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'webkit-desktop',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      // Phone-viewport pass (audit FL-26/FL-29): 390×844 is the audit's
      // reference iPhone-class viewport. Chromium-based so the matrix run
      // works without extra downloads beyond firefox/webkit.
      name: 'phone-viewport',
      use: {
        ...devices['iPhone 13'],
        channel: 'chrome',
      },
    }
  );
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://formlogic.local',
    headless: true,
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects,
});
