import { expect, test, type Browser } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb } from '../lib/server/db/client.ts';
import { user } from '../lib/server/db/schema.ts';
import { contrastRatio } from '../lib/styles/tokens.ts';
import { tabWalk, type Scheme } from '../../e2e/a11y.ts';
import {
	E2E_DATABASE_URL,
	SEEDED_ADMIN,
	SEEDED_DESIGN,
	SEEDED_LONG_ACCOUNT,
	SEEDED_WATCHES,
	signIn,
	type Credentials
} from '../../e2e/accounts.ts';

// c-7: every link, button, input and checkbox shows a >= 2px, >= 3:1 focus-visible
// outline when reached by Tab, in both schemes. Only Tab is pressed — nothing is
// activated, so no form submits and nothing reaches Amazon (r-01); *.invalid
// image requests are aborted.

const schemes: Scheme[] = ['light', 'dark'];

async function longAccountId() {
	const db = createDb(E2E_DATABASE_URL);
	try {
		const [row] = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, SEEDED_LONG_ACCOUNT.email));
		return row.id;
	} finally {
		db.$client.close();
	}
}

const PAGES: { name: string; path: () => Promise<string>; as: Credentials | null }[] = [
	{ name: '/login', path: async () => '/login', as: null },
	{ name: '/', path: async () => '/', as: SEEDED_DESIGN },
	{
		name: '/watches/layoutLong',
		path: async () => `/watches/${SEEDED_WATCHES.layoutLong.id}`,
		as: SEEDED_DESIGN
	},
	{ name: '/account/alerts', path: async () => '/account/alerts', as: SEEDED_DESIGN },
	{ name: '/account/password', path: async () => '/account/password', as: SEEDED_DESIGN },
	{ name: '/admin/users', path: async () => '/admin/users', as: SEEDED_ADMIN },
	{
		name: 'reset page',
		path: async () => `/admin/users/${await longAccountId()}/password`,
		as: SEEDED_ADMIN
	}
];

async function open(browser: Browser, scheme: Scheme, as: Credentials | null) {
	const context = await browser.newContext({ colorScheme: scheme });
	await context.route(
		(url) => url.hostname.endsWith('.invalid'),
		(route) => route.abort()
	);
	const page = await context.newPage();
	if (as) await signIn(page, as);
	return { page, close: () => context.close() };
}

for (const scheme of schemes) {
	for (const { name, path, as } of PAGES) {
		test(`focus ${name} ${scheme}`, async ({ browser }) => {
			const { page, close } = await open(browser, scheme, as);
			try {
				await page.goto(await path());
				// tabWalk fails on any stop without a visible >= 2px, >= 3:1 outline, and
				// when the walk misses an element or its count differs from the tabbable count.
				const stops = await tabWalk(page);
				expect(stops.length, 'focus reachable: something to tab to').toBeGreaterThan(0);
				expect(stops.every((s) => s.focusVisible)).toBe(true);
				if (as !== null) {
					// The link-styled Sign out button keeps its outline like every other control.
					expect(
						stops.some((s) => /Sign out/.test(s.label)),
						'Sign out is reached by Tab'
					).toBe(true);
				}
				if (name === '/watches/layoutLong') {
					// Every mark is a button, but only the roving one is a stop.
					expect(await page.locator('.chart .mark').count()).toBeGreaterThan(1);
					const labels = stops.map((stop) => stop.label);
					for (const range of ['30 days', '90 days', 'All time']) {
						expect(labels.filter((label) => label.includes(range))).toHaveLength(1);
					}
					const chartStops = await page.evaluate(
						() => window.__a11yProbe!.visited.filter((el) => el.closest('.chart')).length
					);
					expect(chartStops, 'three range buttons and one mark').toBe(4);
				}
			} finally {
				await close();
			}
		});
	}

	test(`focus contrast ${scheme}`, async ({ browser }) => {
		const { page, close } = await open(browser, scheme, null);
		try {
			await page.goto('/login');
			const t = await page.evaluate(() => {
				const root = getComputedStyle(document.documentElement);
				const v = (name: string) => root.getPropertyValue(name).trim();
				return {
					focus: v('--focus'),
					bg: v('--bg'),
					surface: v('--surface'),
					width: v('--focus-width')
				};
			});
			expect(parseFloat(t.width), '--focus-width').toBeGreaterThanOrEqual(2);
			for (const ground of ['bg', 'surface'] as const) {
				const ratio = contrastRatio(t.focus, t[ground]);
				expect(ratio, `--focus on --${ground} (${scheme})`).toBeGreaterThanOrEqual(3);
			}
		} finally {
			await close();
		}
	});
}
