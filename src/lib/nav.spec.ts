import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { navItems, normalise } from './nav.ts';

const links = (items: ReturnType<typeof navItems>) => items.map(({ label, href }) => [label, href]);
const currentOf = (pathname: string) =>
	navItems({ pathname })
		.filter((i) => i.current === 'page')
		.map((i) => i.label);

/** The page file SvelteKit serves for a static href: '/' -> src/routes/+page.svelte. */
const pageFileFor = (href: string) =>
	fileURLToPath(new URL(`../routes${href.replace(/\/$/, '')}/+page.svelte`, import.meta.url));

describe('items', () => {
	it('Watchlist and Alerts, in that order, and nothing else', () => {
		expect(links(navItems({ pathname: '/' }))).toStrictEqual([
			['Watchlist', '/'],
			['Alerts', '/account/alerts']
		]);
	});

	it('every nav link resolves to a route', () => {
		const items = navItems({ pathname: '/' });
		expect(items.length).toBeGreaterThan(0);
		for (const { href } of items) {
			expect(existsSync(pageFileFor(href)), `${href} -> ${pageFileFor(href)}`).toBe(true);
		}
	});

	it('the route check catches a link with no page (e.g. the removed /account/password)', () => {
		expect(existsSync(pageFileFor('/account/nonexistent'))).toBe(false);
		expect(existsSync(pageFileFor('/'))).toBe(true);
	});
});

describe('current link', () => {
	it.each([
		['/', 'Watchlist'],
		['/account/alerts', 'Alerts'],
		['/account/alerts/', 'Alerts'],
		['/account/alerts//', 'Alerts']
	])('%s marks only %s', (pathname, label) => {
		expect(currentOf(pathname)).toStrictEqual([label]);
	});

	it('/account/alerts does not mark Watchlist (no prefix matching)', () => {
		const items = navItems({ pathname: '/account/alerts' });
		expect(items.find((i) => i.label === 'Watchlist')?.current).toBeUndefined();
	});

	it.each([
		'/watches/abc',
		'/account',
		'/account/password',
		'/admin/users',
		'/login',
		'/accounts/alerts'
	])('%s marks nothing (exact match only)', (pathname) => {
		expect(currentOf(pathname)).toStrictEqual([]);
	});

	it('no path ever marks two items', () => {
		for (const pathname of ['/', '//', '/account/alerts', '/x']) {
			expect(currentOf(pathname).length, pathname).toBeLessThanOrEqual(1);
		}
	});
});

describe('normalise', () => {
	it('same output', () => {
		// Computed once from the old pathname.replace(/\/+$/, '') || '/'.
		const table: [string, string][] = [
			['', '/'],
			['/', '/'],
			['//', '/'],
			['///', '/'],
			['/a', '/a'],
			['/a/', '/a'],
			['/a//', '/a'],
			['/account/alerts', '/account/alerts'],
			['/account/alerts/', '/account/alerts'],
			['/account/alerts///', '/account/alerts'],
			['/account//alerts/', '/account//alerts'],
			['/a//b/', '/a//b'],
			['a/', 'a']
		];
		for (const [input, output] of table)
			expect(normalise(input), JSON.stringify(input)).toBe(output);
	});

	it('linear on slash runs', () => {
		const run = '/'.repeat(16384);
		for (const input of ['/a' + run + 'x', run]) {
			let best = Infinity;
			for (let i = 0; i < 5; i++) {
				const start = performance.now();
				normalise(input);
				best = Math.min(best, performance.now() - start);
			}
			expect(best, `${input.length} chars`).toBeLessThan(10);
		}
		expect(normalise('/a' + run + 'x')).toBe('/a' + run + 'x');
		expect(normalise(run)).toBe('/');
	});
});
