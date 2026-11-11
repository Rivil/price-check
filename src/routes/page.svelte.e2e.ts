import { expect, test } from '@playwright/test';

// Replaces the stale scaffold h1 check. Also keeps the e2e suite non-empty until
// the seeded-DB harness lands (Playwright exits 1 when it finds no tests).
test('demo sign-up page is gone', async ({ page }) => {
	await page.goto('/demo/better-auth/login');

	await expect(page.getByRole('button', { name: /register|sign up/i })).toHaveCount(0);
	await expect(page.locator('input[name="name"]')).toHaveCount(0);
});
