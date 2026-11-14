import { expect, test, type Page } from '@playwright/test';
import { SEEDED_WATCHES } from '../../e2e/accounts.ts';

// Read-only: these tests only navigate and GET the header's own links, so they
// never touch a watch or reach amazon.co.uk (r-01).

const SOURCE_URL = 'https://github.com/Rivil/price-check';

/** Every page shape, the status it answers with, and which header link it marks current. */
const PAGES: { path: string; status: number; current: string | null }[] = [
	{ path: '/', status: 200, current: 'Watchlist' },
	{ path: `/watches/${SEEDED_WATCHES.layoutAtTarget.id}`, status: 200, current: null },
	{ path: '/account/alerts', status: 200, current: 'Alerts' },
	// The 404 page renders inside the root layout, so it carries the header and footer too.
	{ path: '/no-such-page', status: 404, current: null }
];

const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

async function open(page: Page, path: string, status: number) {
	const response = await page.goto(path);
	expect(response?.status(), path).toBe(status);
}

test('nav on every page', async ({ page }) => {
	for (const { path, status } of PAGES) {
		await open(page, path, status);
		const nav = mainNav(page);
		for (const name of ['Watchlist', 'Alerts']) {
			await expect(page.getByRole('link', { name, exact: true }), `${path} ${name}`).toHaveCount(1);
			await expect(nav.getByRole('link', { name, exact: true }), `${path} ${name}`).toHaveCount(1);
		}
	}
});

test('no auth chrome', async ({ page }) => {
	// c-4: single user, no sign-in: nothing to sign out of, no admin, no account page.
	for (const { path, status } of PAGES) {
		await open(page, path, status);
		await expect(page.getByRole('button', { name: /sign out/i }), path).toHaveCount(0);
		await expect(page.getByRole('link', { name: /sign out/i }), path).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Admin' }), path).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Account' }), path).toHaveCount(0);
		await expect(page.locator('form[action*="logout"], a[href*="logout"]'), path).toHaveCount(0);
	}
});

test('source link on every page', async ({ page }) => {
	// c-4 (AGPL-3.0 §13): exactly one footer 'Source' link to the public repo.
	for (const { path, status } of PAGES) {
		await open(page, path, status);
		const source = page.getByRole('link', { name: 'Source', exact: true });
		await expect(source, path).toHaveCount(1);
		await expect(source, path).toHaveAttribute('href', SOURCE_URL);
		await expect(
			page.getByRole('contentinfo').getByRole('link', { name: 'Source' }),
			path
		).toHaveCount(1);
		await expect(source, path).toBeVisible();
	}
});

test('nav links resolve', async ({ page, request }) => {
	await open(page, '/', 200);
	const hrefs = await mainNav(page)
		.getByRole('link')
		.evaluateAll((links) => links.map((a) => a.getAttribute('href')));
	expect(hrefs.length, 'header has links').toBeGreaterThan(0);
	for (const href of hrefs) {
		expect(href, 'every header link has an href').not.toBeNull();
		const res = await request.get(href!, { maxRedirects: 0 });
		expect(res.status(), href!).toBe(200);
	}
});

test('current link', async ({ browser }) => {
	// JavaScript off: aria-current must be in the server-rendered HTML, not added on hydration.
	const context = await browser.newContext({ javaScriptEnabled: false });
	try {
		const page = await context.newPage();
		for (const { path, status, current } of PAGES) {
			await open(page, path, status);
			const marked = mainNav(page).locator('[aria-current="page"]');
			if (current === null) {
				await expect(marked, path).toHaveCount(0);
			} else {
				await expect(marked, path).toHaveCount(1);
				await expect(marked, path).toHaveText(current);
			}
			await expect(page.locator('[aria-current]'), path).toHaveCount(current === null ? 0 : 1);
		}
	} finally {
		await context.close();
	}
});

test('no toggle', async ({ page }) => {
	await open(page, '/', 200);
	// No buttons at all: links wrap, nothing is hidden behind a menu (phone_nav).
	await expect(mainNav(page).getByRole('button')).toHaveCount(0);
	await expect(mainNav(page).getByRole('link')).toHaveCount(2);
});
