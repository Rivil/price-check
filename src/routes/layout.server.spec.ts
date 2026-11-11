import { describe, expect, it } from 'vitest';
import { isAdminRole } from '#lib/server/access.ts';
import { load } from './+layout.server.ts';

type Event = Parameters<typeof load>[0];

function run(user: { id: string; role?: string | null } | undefined) {
	return load({ locals: { user } } as unknown as Event);
}

describe('layout load', () => {
	it('signed out (e.g. /login): no nav', async () => {
		expect(await run(undefined)).toStrictEqual({ nav: null });
	});

	it.each([
		['admin', true],
		['user', false],
		['user, admin', true],
		[null, false]
	])('role %j: nav.isAdmin is %s', async (role, isAdmin) => {
		expect(await run({ id: 'u1', role })).toStrictEqual({ nav: { isAdmin } });
		expect(isAdmin).toBe(isAdminRole(role));
	});
});
