import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { MIN_PASSWORD_LENGTH } from './auth-factory.ts';
import { session, user } from './db/schema.ts';
import { createAuthHarness, type AuthHarness } from './testing/auth-harness.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

async function userCount(h: AuthHarness) {
	const [row] = await h.db.select({ n: count() }).from(user);
	return row.n;
}

async function roleOf(h: AuthHarness, id: string) {
	const [row] = await h.db.select({ role: user.role }).from(user).where(eq(user.id, id));
	return row?.role;
}

describe('createAuth', () => {
	let h: AuthHarness;

	beforeEach(async () => {
		h = await createAuthHarness();
	});

	afterEach(() => {
		vi.useRealTimers();
		h.cleanup();
	});

	it('sign-up disabled', async () => {
		const res = await h.request('/api/auth/sign-up/email', {
			method: 'POST',
			body: { email: 'new@example.com', password: 'long-enough-pw', name: 'New' }
		});

		expect(res.ok).toBe(false);
		expect(await userCount(h)).toBe(0);
	});

	it('admin endpoints forbid non-admin', async () => {
		const member = await h.createUser({ email: 'member@example.com', role: 'user' });
		const { cookie } = await h.signIn('member@example.com');

		const create = await h.request('/api/auth/admin/create-user', {
			method: 'POST',
			cookie,
			body: { email: 'x@example.com', password: 'long-enough-pw', name: 'X' }
		});
		const setPassword = await h.request('/api/auth/admin/set-user-password', {
			method: 'POST',
			cookie,
			body: { userId: member.id, newPassword: 'another-long-pw' }
		});
		const list = await h.request('/api/auth/admin/list-users', { cookie });

		expect(create.status).toBe(403);
		expect(setPassword.status).toBe(403);
		expect(list.status).toBe(403);
	});

	it('no self-promotion', async () => {
		const member = await h.createUser({ email: 'member@example.com', role: 'user' });
		const { cookie } = await h.signIn('member@example.com');

		await h.request('/api/auth/update-user', { method: 'POST', cookie, body: { role: 'admin' } });

		expect(await roleOf(h, member.id)).toBe('user');
	});

	it('session lifetime', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t0 = new Date('2026-06-01T12:00:00Z').getTime();
		vi.setSystemTime(t0);

		await h.createUser({ email: 'member@example.com' });
		const { headers, token } = await h.signIn('member@example.com');
		const sessionRow = async () =>
			(await h.db.select().from(session).where(eq(session.token, token)))[0];

		expect(Math.abs((await sessionRow()).expiresAt.getTime() - (t0 + 30 * DAY_MS))).toBeLessThan(
			60_000
		);

		const t1 = t0 + 2 * DAY_MS;
		vi.setSystemTime(t1);
		const current = await h.auth.api.getSession({ headers });

		expect(current?.user.email).toBe('member@example.com');
		expect(Math.abs((await sessionRow()).expiresAt.getTime() - (t1 + 30 * DAY_MS))).toBeLessThan(
			60_000
		);
	});

	it('password policy', async () => {
		expect(MIN_PASSWORD_LENGTH).toBe(8);

		await h.createUser({ email: 'admin@example.com', role: 'admin' });
		const target = await h.createUser({ email: 'member@example.com' });
		const { headers } = await h.signIn('admin@example.com');

		await expect(
			h.auth.api.setUserPassword({
				body: { userId: target.id, newPassword: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) },
				headers
			})
		).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_SHORT' } });

		await expect(
			h.auth.api.setUserPassword({
				body: { userId: target.id, newPassword: 'a'.repeat(MIN_PASSWORD_LENGTH) },
				headers
			})
		).resolves.toMatchObject({ status: true });
	});

	it('harness role column', async () => {
		const admin = await h.createUser({ email: 'admin@example.com', role: 'admin' });

		expect(await roleOf(h, admin.id)).toBe('admin');
	});

	it('harness isolation', async () => {
		const other = await createAuthHarness();
		try {
			await h.createUser({ email: 'only-here@example.com' });

			expect(await userCount(h)).toBe(1);
			expect(await userCount(other)).toBe(0);
		} finally {
			other.cleanup();
		}
	});

	it('harness transactions', async () => {
		expect(h.url.startsWith('file:')).toBe(true);
		expect(h.url).not.toContain(':memory:');

		const created = await h.createUser({ email: 'tx@example.com' });
		const rows = await h.db.select().from(user).where(eq(user.email, 'tx@example.com'));

		expect(rows.map((r) => r.id)).toEqual([created.id]);
	});
});
