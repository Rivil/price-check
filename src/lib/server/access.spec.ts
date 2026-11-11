import { describe, expect, it, vi } from 'vitest';
import { isHttpError, type RequestEvent } from '@sveltejs/kit';
import { createAccessHandle, decideAccess, isAdminRole, type AccessInput } from './access.ts';

const toLogin = { kind: 'redirect', location: '/login' };
const member = { role: 'user' };
const admin = { role: 'admin' };

// Every page route in the app, so routes added in later phases join the table automatically.
const routeIds = Object.keys(import.meta.glob('/src/routes/**/+page.svelte')).map(
	(key) => key.replace(/^\/src\/routes/, '').replace(/\/\+page\.svelte$/, '') || '/'
);

function decide(routeId: string | null, user: AccessInput['user'], pathname = routeId ?? '/x') {
	return decideAccess({ routeId, pathname, user });
}

describe('decideAccess', () => {
	it('route table', () => {
		expect(routeIds).toContain('/');

		for (const id of routeIds.filter((id) => id !== '/login')) {
			expect(decide(id, null), id).toEqual(toLogin);
		}
		expect(decide('/login', null)).toEqual({ kind: 'allow' });
	});

	it('boundaries', () => {
		for (const pathname of ['/loginx', '/login-foo', '/api/authx', '/api/other']) {
			expect(decide(null, null, pathname), pathname).toEqual(toLogin);
		}
		expect(decide('/loginx', null, '/loginx')).toEqual(toLogin);
		expect(decide(null, null, '/no-such-page')).toEqual(toLogin);
		expect(decide(null, null, '/api/auth/get-session')).toEqual({ kind: 'allow' });
		expect(decide(null, null, '/api/auth')).toEqual({ kind: 'allow' });
		// Never a self-redirect, even if /login matched no route.
		expect(decide(null, null, '/login')).toEqual({ kind: 'allow' });
		// The /login route itself is allowed whatever the pathname (e.g. a trailing slash).
		expect(decide('/login', null, '/login/')).toEqual({ kind: 'allow' });
		// A signed-in 404 (no route id) is not an admin route.
		expect(decide(null, member, '/no-such-page')).toEqual({ kind: 'allow' });
	});

	it('admin routes', () => {
		for (const id of ['/admin', '/admin/users', '/admin/users/[id]/password']) {
			expect(decide(id, member), id).toEqual({ kind: 'forbidden' });
			expect(decide(id, admin), id).toEqual({ kind: 'allow' });
			expect(decide(id, null), id).toEqual(toLogin);
		}
		// Prefix lookalikes are not admin routes.
		expect(decide('/administrator', member)).toEqual({ kind: 'allow' });
		// Encoded paths match the same route id, so the pathname can't dodge the check.
		expect(decide('/admin/users', member, '/%61dmin/users')).toEqual({ kind: 'forbidden' });
	});

	it('login when signed in', () => {
		expect(decide('/login', member)).toEqual({ kind: 'redirect', location: '/' });
		expect(decide('/', member)).toEqual({ kind: 'allow' });
	});
});

describe('admin role', () => {
	const admins = ['admin', 'admin,user', ' admin ', 'user, admin', 'user,admin'];
	const nonAdmins = ['user', null, undefined, '', 'administrator', 'admins', 'superadmin', 'user,'];

	it.each(admins)('%j is admin', (role) => {
		expect(isAdminRole(role)).toBe(true);
	});

	it.each(nonAdmins)('%j is not admin', (role) => {
		expect(isAdminRole(role)).toBe(false);
	});

	it('decideAccess agrees with isAdminRole on every role', () => {
		for (const role of [...admins, ...nonAdmins]) {
			const expected = isAdminRole(role) ? { kind: 'allow' } : { kind: 'forbidden' };
			expect(decide('/admin/users', { role }), String(role)).toEqual(expected);
		}
	});
});

describe('createAccessHandle', () => {
	function fakeEvent(method: string, path: string, routeId: string | null) {
		const url = new URL(path, 'http://localhost:4173');
		return {
			url,
			route: { id: routeId },
			request: new Request(url, { method }),
			locals: {}
		} as unknown as RequestEvent;
	}

	function sessionFor(role: string) {
		return async () =>
			({
				user: { id: 'u1', email: 'm@example.com', role },
				session: { id: 's1', userId: 'u1' }
			}) as unknown as Awaited<ReturnType<Parameters<typeof createAccessHandle>[0]>>;
	}

	it('hook blocks actions', async () => {
		const handle = createAccessHandle(sessionFor('user'));
		const resolve = vi.fn(async () => new Response('ok'));

		const outcome = await Promise.resolve(
			handle({ event: fakeEvent('POST', '/admin/users?/create', '/admin/users'), resolve })
		).catch((e: unknown) => e);

		expect(isHttpError(outcome, 403)).toBe(true);
		expect(outcome).toMatchObject({ body: { message: 'Forbidden' } });
		expect(resolve).not.toHaveBeenCalled();
	});

	it('hook resolves allowed requests with locals set', async () => {
		const handle = createAccessHandle(sessionFor('admin'));
		const event = fakeEvent('POST', '/admin/users?/create', '/admin/users');
		const resolve = vi.fn(async () => new Response('ok'));

		const res = await handle({ event, resolve });

		expect(res.status).toBe(200);
		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.user?.role).toBe('admin');
	});

	it('hook redirects signed-out requests', async () => {
		const handle = createAccessHandle(async () => null);
		const resolve = vi.fn(async () => new Response('ok'));

		const outcome = await Promise.resolve(
			handle({ event: fakeEvent('GET', '/', '/'), resolve })
		).catch((e: unknown) => e);

		expect(outcome).toMatchObject({ status: 303, location: '/login' });
		expect(resolve).not.toHaveBeenCalled();
	});

	it('health is public', async () => {
		const handle = createAccessHandle(async () => null);
		const resolve = vi.fn(async () => new Response('ok'));

		const res = await handle({ event: fakeEvent('GET', '/health', '/health'), resolve });

		expect(res.status).toBe(200);
		expect(resolve).toHaveBeenCalledOnce();
	});

	it('health skips session', async () => {
		const getSession = vi.fn(async () => {
			throw new Error('database is broken');
		});
		const handle = createAccessHandle(getSession);
		const resolve = vi.fn(async () => new Response('ok'));

		const res = await handle({ event: fakeEvent('GET', '/health', '/health'), resolve });

		expect(res.status).toBe(200);
		expect(resolve).toHaveBeenCalledOnce();
		expect(getSession).not.toHaveBeenCalled();
	});

	it('health look-alikes', async () => {
		for (const path of ['/healthx', '/health/anything']) {
			const getSession = vi.fn(async () => null);
			const handle = createAccessHandle(getSession);
			const resolve = vi.fn(async () => new Response('ok'));

			const outcome = await Promise.resolve(
				handle({ event: fakeEvent('GET', path, null), resolve })
			).catch((e: unknown) => e);

			expect(outcome, path).toMatchObject({ status: 303, location: '/login' });
			expect(resolve, path).not.toHaveBeenCalled();
			expect(getSession, path).toHaveBeenCalledOnce();
		}
	});
});
