import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { parseColour, parseTokens, schemeTokens } from '../lib/styles/tokens.ts';
import { SEEDED_DESIGN, SEEDED_WATCHES, signIn } from '../../e2e/accounts.ts';

// Read-only on SEEDED_DESIGN's seeded watches: nothing here checks or edits a
// watch, so it never reaches amazon.co.uk (r-01).

const { layoutAtTarget, layoutLong, layoutCooldown } = SEEDED_WATCHES;
const LABEL = 'at or below target';
const tokens = parseTokens(
	readFileSync(new URL('../lib/styles/tokens.css', import.meta.url), 'utf8')
);

const item = (page: Page, id: string) => page.locator(`li[data-watch-id="${id}"]`);
const priceOnPage = (page: Page) =>
	page
		.locator('dt', { hasText: /price$/ })
		.first()
		.locator('xpath=following-sibling::dd[1]');

async function expectLabels(page: Page) {
	await page.goto('/');
	await expect(item(page, layoutAtTarget.id).getByText(LABEL)).toBeVisible();
	await expect(item(page, layoutLong.id).getByText(LABEL)).toHaveCount(0);
	await expect(item(page, layoutCooldown.id).getByText(LABEL)).toHaveCount(0);

	await page.goto(`/watches/${layoutAtTarget.id}`);
	await expect(priceOnPage(page)).toContainText(LABEL);
	await expect(page.getByText(LABEL)).toHaveCount(1);

	// A failed latest check never shows the label, even with a kept price.
	await page.goto(`/watches/${layoutLong.id}`);
	await expect(page.getByText(LABEL)).toHaveCount(0);
}

async function withPage(
	browser: Browser,
	options: Parameters<Browser['newContext']>[0],
	run: (page: Page) => Promise<void>
) {
	const context = await browser.newContext(options);
	try {
		const page = await context.newPage();
		await signIn(page, SEEDED_DESIGN);
		await run(page);
	} finally {
		await context.close();
	}
}

test('label', async ({ browser }) => {
	await withPage(browser, {}, expectLabels);
});

test('label ssr', async ({ browser }) => {
	// JavaScript off: the label must be in the server-rendered HTML.
	await withPage(browser, { javaScriptEnabled: false }, expectLabels);
});

test('ok colour', async ({ browser }) => {
	const seen: Record<string, string> = {};
	for (const scheme of ['light', 'dark'] as const) {
		await withPage(browser, { colorScheme: scheme }, async (page) => {
			const expected = parseColour(schemeTokens(tokens, scheme)['--ok']);

			await page.goto('/');
			const listPrice = item(page, layoutAtTarget.id).locator('.price');
			const listColour = await listPrice.evaluate((el) => getComputedStyle(el).color);
			expect(parseColour(listColour), `watchlist price, ${scheme}`).toStrictEqual(expected);

			await page.goto(`/watches/${layoutAtTarget.id}`);
			const pageColour = await priceOnPage(page).evaluate((el) => getComputedStyle(el).color);
			expect(parseColour(pageColour), `watch page price, ${scheme}`).toStrictEqual(expected);

			seen[scheme] = listColour;
		});
	}
	// The two schemes really rendered different palettes.
	expect(seen.light).not.toBe(seen.dark);
});
