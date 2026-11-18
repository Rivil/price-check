import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { navItems } from './nav.ts';

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
