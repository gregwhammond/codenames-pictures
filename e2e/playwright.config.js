'use strict';
// Four-phone end-to-end tests. See lib/table.js for the fixture.
//
//   E2E_PORT=8791   port for the server under test (never 8080)
//   WATCH=1         headed, slowed down, four windows side by side (Chromium)
//   E2E_SEED=n      replay a bot run (the seed is printed when a test fails)
//   E2E_WORKERS=n   parallel workers (each test opens four browser contexts)
//   E2E_STRICT_RACES=1  fail on data races listed as known in lib/server.js
//   E2E_STRICT=1    turn every known-issue switch off (races, table.known)
//   E2E_SHOW_BUGS=1 report known app bugs as ordinary failures (lib/known-bug.js)
//   E2E_RACE_HUNT=1 include tests/race-hunt.spec.js (opt-in; see that file)
//   E2E_TRACE=0 / E2E_VIDEO=0  do not record a trace / video per phone

const { defineConfig, devices } = require('@playwright/test');
const server = require('./lib/server');

const WATCH = process.env.WATCH === '1';
const LAYOUT_ONLY = /layout\.spec\.js$/;

/** One phone-shaped project. `browser` is 'chromium' or 'webkit'. */
function phone(name, browser, width, height, extra = {}) {
  const base = browser === 'webkit' ? devices['iPhone 14'] : devices['Pixel 7'];
  return {
    name,
    use: {
      ...base,
      viewport: { width, height },
      // Phones report 3x; 2x keeps screenshots and video small.
      deviceScaleFactor: 2,
    },
    ...extra,
  };
}

module.exports = defineConfig({
  testDir: './tests',
  // The race hunt provokes timing-dependent behaviour on purpose; it runs only when asked for.
  testIgnore: process.env.E2E_RACE_HUNT === '1' ? [] : [/race-hunt\.spec\.js$/],
  outputDir: server.OUTPUT_DIR,
  globalTeardown: require.resolve('./lib/global-teardown.js'),

  // No retries: a flaky test must show up as a failure.
  retries: 0,
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  workers: WATCH ? 1 : Number(process.env.E2E_WORKERS || 3),

  timeout: WATCH ? 0 : 120_000,
  expect: { timeout: 7_000 },

  reporter: [
    ['list'],
    ['html', { outputFolder: server.REPORT_DIR, open: 'never' }],
  ],

  use: {
    baseURL: server.BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    // Trace and video are recorded per phone by the table fixture (lib/table.js)
    // and kept on failure. The runner's own options stay off: its trace merge
    // hangs on Node 26 with this Playwright version, and its video option does
    // not cover contexts a fixture opens itself. E2E_TRACE=0 / E2E_VIDEO=0
    // turn the fixture's recording off.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    headless: !WATCH,
    launchOptions: WATCH ? { slowMo: Number(process.env.E2E_SLOWMO || 250) } : {},
  },

  projects: [
    // These two run every spec.
    phone('android-chromium', 'chromium', 360, 780),
    phone('iphone-webkit', 'webkit', 390, 844),

    // Layout-only projects: other sizes and phones held sideways. They run
    // tests/layout.spec.js and nothing else (the two above run it as well).
    // Landscape matters because style.css switches the game screen to a
    // side-by-side grid under `(orientation: landscape) and (max-height: 540px)`.
    phone('large-chromium', 'chromium', 430, 932, { testMatch: LAYOUT_ONLY }),
    phone('large-webkit', 'webkit', 430, 932, { testMatch: LAYOUT_ONLY }),
    phone('landscape-chromium', 'chromium', 780, 360, { testMatch: LAYOUT_ONLY }),
    phone('landscape-webkit', 'webkit', 844, 390, { testMatch: LAYOUT_ONLY }),
    phone('landscape-large-webkit', 'webkit', 932, 430, { testMatch: LAYOUT_ONLY }),
  ],

  webServer: {
    // The real server, built with the race detector, started from the repo
    // root. Output goes to server.LOG_PATH; lib/global-teardown.js scans it.
    command: server.serverCommand(),
    cwd: server.REPO_ROOT,
    url: server.HEALTH_URL,
    reuseExistingServer: false,
    // The first -race build compiles the standard library with instrumentation.
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 2_000 },
  },
});
