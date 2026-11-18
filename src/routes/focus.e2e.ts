import { expect, test, type Browser } from '@playwright/test';
import { contrastRatio } from '../lib/styles/tokens.ts';
import { tabWalk, type Scheme } from '../../e2e/a11y.ts';
import { SEEDED_WATCHES } from '../../e2e/accounts.ts';

// c-7: every link, button, input and checkbox shows a >= 2px, >= 3:1 focus-visible
// outline when reached by Tab, in both schemes. Only Tab is pressed — nothing is
// activated, so no form submits and nothing reaches Amazon (r-01); *.invalid
// image requests are aborted.

const schemes: Scheme[] = ['light', 'dark'];
const SOURCE_URL = 'https://github.com/Rivil/price-check';

const PAGES: { name: string; path: string; status: number }[] = [
	{ name: '/', path: '/', status: 200 },
	{ name: '/watches/layoutLong', path: `/watches/${SEEDED_WATCHES.layoutLong.id}`, status: 200 },
	{ name: '/account/alerts', path: '/account/alerts', status: 200 },
	{ name: '404 page', path: '/no-such-page', status: 404 }
];

async function open(browser: Browser, scheme: Scheme) {
	const context = await browser.newContext({ colorScheme: scheme });
	await context.route(
		(url) => url.hostname.endsWith('.invalid'),
		(route) => route.abort()
	);
	const page = await context.newPage();
	return { page, close: () => context.close() };
}

for (const scheme of schemes) {
	for (const { name, path, status } of PAGES) {
		test(`focus ${name} ${scheme}`, async ({ browser }) => {
			const { page, close } = await open(browser, scheme);
			try {
				const response = await page.goto(path);
				expect(response?.status(), path).toBe(status);
				// tabWalk fails on any stop without a visible >= 2px, >= 3:1 outline, and
				// when the walk misses an element or its count differs from the tabbable count.
				const stops = await tabWalk(page);
				expect(stops.length, 'focus reachable: something to tab to').toBeGreaterThan(0);
				expect(stops.every((s) => s.focusVisible)).toBe(true);

				// c-4: the footer Source link is a stop of its own, after every main-content control.
				const order = await page.evaluate(
					(source) =>
						window.__a11yProbe!.visited.map((el) =>
							el.matches(`footer a[href="${source}"]`)
								? 'source'
								: el.closest('main')
									? 'main'
									: 'other'
						),
					SOURCE_URL
				);
				const sourceAt = order.indexOf('source');
				expect(sourceAt, 'Source link is reached by Tab').toBeGreaterThanOrEqual(0);
				expect(order.lastIndexOf('source'), 'Source link is one stop').toBe(sourceAt);
				expect(order.lastIndexOf('main'), 'Source comes after the last main control').toBeLessThan(
					sourceAt
				);
				if (status === 200) {
					expect(order.includes('main'), 'not vacuous: main has controls').toBe(true);
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
		const { page, close } = await open(browser, scheme);
		try {
			await page.goto('/');
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
