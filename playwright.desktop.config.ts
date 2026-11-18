// The desktop e2e suite (spec c-1, c-5, c-8): real Electron through Playwright's
// _electron, launched per test by e2e/desktop/launch.ts. Run it with
// `pnpm test:e2e:desktop`, which builds the web and desktop bundles first.
//
// No webServer: each test's app runs its own server on a per-launch port. Only
// e2e/desktop is collected, and the default config (playwright.config.ts) ignores it.
import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './e2e/desktop',
	testMatch: '**/*.e2e.ts',
	// Electron windows and single-instance locks: one app at a time.
	workers: 1,
	fullyParallel: false,
	// In CI a stray test.only must fail the run, and a flaky test must not pass on retry.
	forbidOnly: !!process.env.CI,
	retries: 0,
	// A test may launch the app more than once, and each launch boots a server.
	timeout: 90_000,
	outputDir: 'test-results/desktop'
});
