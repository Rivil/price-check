import { defineConfig } from '@playwright/test';
import { E2E_ALERTS_KEY, E2E_DATABASE_URL, E2E_ORIGIN } from './e2e/accounts.ts';

export default defineConfig({
	// Every e2e file shares the one seeded database, so run them serially.
	workers: 1,
	// In CI a stray test.only must fail the run, and a flaky test must not pass on retry.
	forbidOnly: !!process.env.CI,
	retries: 0,
	fullyParallel: false,
	use: { baseURL: E2E_ORIGIN },
	webServer: {
		// Seed first, so the server never starts against a stale or unmigrated DB.
		command: 'node e2e/seed.ts && pnpm build && pnpm preview',
		port: 4173,
		// Seed and build alone take close to the 60s default on a busy machine.
		timeout: 180_000,
		env: {
			// Only what the server requires (c-2): no auth secret, and no ORIGIN, which the
			// preview server derives from the request.
			DATABASE_URL: E2E_DATABASE_URL,
			// Without it the preview server refuses to start (decision encryption_key).
			ALERTS_ENCRYPTION_KEY: E2E_ALERTS_KEY,
			// The preview server must never re-check watches: that would be a live fetch (r-01).
			SCHEDULER_DISABLED: '1'
		}
	},
	// e2e specs live across the repo; CI caches browsers inside the checkout, so skip that.
	testIgnore: ['**/.playwright-browsers/**'],
	testMatch: '**/*.e2e.{ts,js}'
});
