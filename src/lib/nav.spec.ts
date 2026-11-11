import { describe, expect, it } from 'vitest';
import { navItems } from './nav.ts';

const links = (items: ReturnType<typeof navItems>) => items.map(({ label, href }) => [label, href]);
const currentOf = (pathname: string, isAdmin = true) =>
	navItems({ pathname, isAdmin })
		.filter((i) => i.current === 'page')
		.map((i) => i.label);

describe('items', () => {
	it('members get Watchlist, Alerts, Account in that order', () => {
		expect(links(navItems({ pathname: '/', isAdmin: false }))).toStrictEqual([
			['Watchlist', '/'],
			['Alerts', '/account/alerts'],
			['Account', '/account/password']
		]);
	});

	it('admins also get Admin -> /admin/users, last', () => {
		expect(links(navItems({ pathname: '/', isAdmin: true }))).toStrictEqual([
			['Watchlist', '/'],
			['Alerts', '/account/alerts'],
			['Account', '/account/password'],
			['Admin', '/admin/users']
		]);
	});
});

describe('current link', () => {
	it.each([
		['/', 'Watchlist'],
		['/account/alerts', 'Alerts'],
		['/account/alerts/', 'Alerts'],
		['/account/alerts//', 'Alerts'],
		['/account/password', 'Account'],
		['/account/password/', 'Account'],
		['/admin/users', 'Admin'],
		['/admin/users/', 'Admin']
	])('%s marks only %s', (pathname, label) => {
		expect(currentOf(pathname)).toStrictEqual([label]);
	});

	it('/account/alerts marks neither Watchlist nor Account (no prefix matching)', () => {
		const items = navItems({ pathname: '/account/alerts', isAdmin: false });
		expect(items.find((i) => i.label === 'Watchlist')?.current).toBeUndefined();
		expect(items.find((i) => i.label === 'Account')?.current).toBeUndefined();
	});

	it.each([
		'/watches/abc',
		'/admin/users/x/password',
		'/account',
		'/admin',
		'/login',
		'/accounts/alerts'
	])('%s marks nothing (exact match only)', (pathname) => {
		expect(currentOf(pathname)).toStrictEqual([]);
	});

	it('no path ever marks two items', () => {
		for (const pathname of [
			'/',
			'//',
			'/account/alerts',
			'/account/password',
			'/admin/users',
			'/x'
		]) {
			expect(currentOf(pathname).length, pathname).toBeLessThanOrEqual(1);
		}
	});

	it('a member on /admin/users has no Admin link to mark', () => {
		expect(currentOf('/admin/users', false)).toStrictEqual([]);
	});
});
