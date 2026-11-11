import { expect, test, type Browser, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb } from '../lib/server/db/client.ts';
import { user } from '../lib/server/db/schema.ts';
import {
	E2E_DATABASE_URL,
	SEEDED_ADMIN,
	SEEDED_DESIGN,
	SEEDED_LONG_ACCOUNT,
	SEEDED_MEMBER,
	SEEDED_WATCHES,
	signIn,
	submitLogin,
	type Credentials
} from '../../e2e/accounts.ts';

// Read-only: these tests only navigate and sign in/out, so they never touch a
// watch or reach amazon.co.uk (r-01).

const watchPath = `/watches/${SEEDED_WATCHES.layoutAtTarget.id}`;

async function resetPath() {
	const db = createDb(E2E_DATABASE_URL);
	try {
		const [row] = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, SEEDED_LONG_ACCOUNT.email));
		return `/admin/users/${row.id}/password`;
	} finally {
		db.$client.close();
	}
}

/** Signed-in pages, who can see them, and which header link each marks current. */
async function pages(): Promise<{ path: string; as: Credentials; current: string | null }[]> {
	return [
		{ path: '/', as: SEEDED_DESIGN, current: 'Watchlist' },
		{ path: watchPath, as: SEEDED_DESIGN, current: null },
		{ path: '/account/alerts', as: SEEDED_DESIGN, current: 'Alerts' },
		{ path: '/account/password', as: SEEDED_DESIGN, current: 'Account' },
		{ path: '/admin/users', as: SEEDED_ADMIN, current: 'Admin' },
		{ path: await resetPath(), as: SEEDED_ADMIN, current: null }
	];
}

const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** A signed-in page per user, in its own context (optionally with JavaScript off). */
async function signedIn(browser: Browser, as: Credentials, javaScriptEnabled = true) {
	const context = await browser.newContext({ javaScriptEnabled });
	const page = await context.newPage();
	await signIn(page, as);
	return { page, close: () => context.close() };
}

test('nav on every page', async ({ browser }) => {
	for (const { path, as } of await pages()) {
		const { page, close } = await signedIn(browser, as);
		try {
			await page.goto(path);
			const nav = mainNav(page);
			for (const name of ['Watchlist', 'Alerts', 'Account']) {
				// exact: 'Household accounts' (the reset page's breadcrumb) contains 'Account'.
				await expect(page.getByRole('link', { name, exact: true }), `${path} ${name}`).toHaveCount(
					1
				);
				await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(1);
			}
			await expect(page.getByRole('button', { name: 'Sign out' }), path).toHaveCount(1);
			await expect(nav.getByRole('button', { name: 'Sign out' })).toHaveCount(1);
		} finally {
			await close();
		}
	}
});

test('current link', async ({ browser }) => {
	// JavaScript off: aria-current must be in the server-rendered HTML, not added on hydration.
	for (const { path, as, current } of await pages()) {
		const { page, close } = await signedIn(browser, as, false);
		try {
			await page.goto(path);
			const marked = mainNav(page).locator('[aria-current="page"]');
			if (current === null) {
				await expect(marked, path).toHaveCount(0);
			} else {
				await expect(marked, path).toHaveCount(1);
				await expect(marked, path).toHaveText(current);
			}
			await expect(page.locator('[aria-current]'), path).toHaveCount(current === null ? 0 : 1);
		} finally {
			await close();
		}
	}
});

test('no nav on sign-in', async ({ page }) => {
	await page.goto('/login');
	await expect(page.locator('header')).toHaveCount(0);
	await expect(page.getByRole('navigation')).toHaveCount(0);

	await signIn(page, SEEDED_DESIGN);
	await expect(mainNav(page)).toBeVisible();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.waitForURL((url) => url.pathname === '/login');
	await expect(page.locator('header')).toHaveCount(0);
	await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('admin link', async ({ browser }) => {
	const member = await signedIn(browser, SEEDED_MEMBER);
	try {
		await expect(
			mainNav(member.page).getByRole('link', { name: 'Account', exact: true })
		).toBeVisible();
		await expect(member.page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
	} finally {
		await member.close();
	}

	const admin = await signedIn(browser, SEEDED_ADMIN);
	try {
		const link = mainNav(admin.page).getByRole('link', { name: 'Admin', exact: true });
		await expect(link).toHaveAttribute('href', '/admin/users');
	} finally {
		await admin.close();
	}
});

test('sign out is POST', async ({ page }) => {
	await signIn(page, SEEDED_DESIGN);
	const button = mainNav(page).locator('form[method="post"][action="/logout"] button');
	await expect(button).toHaveCount(1);
	await expect(button).toHaveText('Sign out');
	await expect(mainNav(page).locator('a[href*="logout"]')).toHaveCount(0);

	await button.click();
	await page.waitForURL((url) => url.pathname === '/login');
});

test('no toggle', async ({ page }) => {
	await signIn(page, SEEDED_ADMIN);
	// The only button is Sign out: links wrap, nothing is hidden behind a menu (phone_nav).
	await expect(mainNav(page).getByRole('button')).toHaveCount(1);
	await expect(mainNav(page).getByRole('link')).toHaveCount(4);
});

test('nav after sign-in', async ({ page }) => {
	// The enhanced form signs in client-side and follows the redirect; the layout load
	// must re-run so the header appears with no page.reload() (none is called here).
	await submitLogin(page, SEEDED_DESIGN);
	await page.waitForURL((url) => url.pathname === '/');
	await expect(mainNav(page)).toBeVisible();
	await expect(mainNav(page).getByRole('link', { name: 'Watchlist', exact: true })).toHaveAttribute(
		'aria-current',
		'page'
	);
});
