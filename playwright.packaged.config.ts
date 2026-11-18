// The packaged smoke (05-release c-1, c-2): the app electron-builder made, launched
// from PRICE_CHECK_PACKAGED_EXE by e2e/packaged/launch-packaged.ts. Package it first
// (`pnpm package:desktop --version <v>`), set PRICE_CHECK_PACKAGED_EXE to the output
// of `node scripts/packaged-app.ts exe dist-packaged`, then `pnpm test:e2e:packaged`.
//
// No webServer: each launch runs its own server on a per-launch port. Only
// e2e/packaged is collected, and only its *.packaged.ts files, which neither the web
// nor the desktop config matches.
import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './e2e/packaged',
	testMatch: '**/*.packaged.ts',
	// One packaged app at a time: launches share the real per-OS userData location.
	workers: 1,
	fullyParallel: false,
	// In CI a stray test.only must fail the run, and a flaky test must not pass on retry.
	forbidOnly: !!process.env.CI,
	retries: 0,
	// A test may launch and quit the app more than once, and each launch boots a server.
	timeout: 120_000,
	outputDir: 'test-results/packaged'
});
