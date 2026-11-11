import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { count } from 'drizzle-orm';
import { decideAccess } from './access.ts';
import {
	AccountInputError,
	AccountNotFoundError,
	createHouseholdAccount,
	listAccounts,
	resetAccountPassword,
	type ResetAuth
} from './accounts.ts';
import { account, user } from './db/schema.ts';
import { createAuthHarness, HARNESS_PASSWORD, type AuthHarness } from './testing/auth-harness.ts';

async function rowCounts(h: AuthHarness) {
	const [u] = await h.db.select({ n: count() }).from(user);
	const [a] = await h.db.select({ n: count() }).from(account);
	return { users: u.n, accounts: a.n };
}

const newcomer = { name: 'New Person', email: 'new@example.com', password: 'initial-pw-123' };

describe('accounts', () => {
	let h: AuthHarness;
	let adminHeaders: Headers;

	beforeEach(async () => {
		h = await createAuthHarness();
		await h.createUser({ email: 'admin@example.com', role: 'admin' });
		adminHeaders = (await h.signIn('admin@example.com')).headers;
	});

	afterEach(() => {
		h.cleanup();
	});

	it('create requires admin', async () => {
		await h.createUser({ email: 'member@example.com', role: 'user' });
		const { headers } = await h.signIn('member@example.com');
		const before = await rowCounts(h);

		await expect(createHouseholdAccount(h.auth, headers, newcomer)).rejects.toMatchObject({
			statusCode: 403
		});
		expect(await rowCounts(h)).toEqual(before);
	});

	it('creates a user-role account by default and lists it', async () => {
		const created = await createHouseholdAccount(h.auth, adminHeaders, newcomer);

		const listed = await listAccounts(h.db);
		expect(listed.find((a) => a.id === created.id)).toMatchObject({
			email: newcomer.email,
			name: newcomer.name,
			role: 'user'
		});
	});

	it('grant admin', async () => {
		const created = await createHouseholdAccount(h.auth, adminHeaders, {
			...newcomer,
			role: 'admin'
		});

		const row = (await listAccounts(h.db)).find((a) => a.id === created.id);
		expect(row?.role).toBe('admin');
		expect(decideAccess({ routeId: '/admin/users', pathname: '/admin/users', user: row })).toEqual({
			kind: 'allow'
		});
	});

	it('role whitelist', async () => {
		const before = await rowCounts(h);

		for (const role of ['superadmin', 'owner']) {
			await expect(
				createHouseholdAccount(h.auth, adminHeaders, { ...newcomer, role })
			).rejects.toMatchObject({ field: 'role', status: 400 });
		}
		expect(await rowCounts(h)).toEqual(before);
	});

	it('duplicate email', async () => {
		await createHouseholdAccount(h.auth, adminHeaders, newcomer);
		const before = await rowCounts(h);

		const error = await createHouseholdAccount(h.auth, adminHeaders, {
			...newcomer,
			email: newcomer.email.toUpperCase()
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AccountInputError);
		expect(error).toMatchObject({ field: 'email', status: 400 });
		expect((error as Error).message).toMatch(/already exists/);
		expect(await rowCounts(h)).toEqual(before);
	});

	it('create password policy', async () => {
		const before = await rowCounts(h);

		for (const password of ['x'.repeat(7), '']) {
			await expect(
				createHouseholdAccount(h.auth, adminHeaders, { ...newcomer, password })
			).rejects.toMatchObject({ field: 'password', status: 400 });
			expect(await rowCounts(h)).toEqual(before);
		}

		await createHouseholdAccount(h.auth, adminHeaders, { ...newcomer, password: 'x'.repeat(8) });
		const signedIn = await h.signIn(newcomer.email, 'x'.repeat(8));
		expect(signedIn.user.email).toBe(newcomer.email);
	});
});

describe('resetAccountPassword', () => {
	const NEW_PASSWORD = 'admin-chosen-pw-9';
	let h: AuthHarness;
	let admin: Awaited<ReturnType<AuthHarness['signIn']>>;
	let targetId: string;

	beforeEach(async () => {
		h = await createAuthHarness();
		await h.createUser({ email: 'admin@example.com', role: 'admin' });
		targetId = (await h.createUser({ email: 'target@example.com' })).id;
		admin = await h.signIn('admin@example.com');
	});

	afterEach(() => {
		h.cleanup();
	});

	async function canSignIn(password: string) {
		return h.signIn('target@example.com', password).then(
			() => true,
			() => false
		);
	}

	async function getSession(cookie: string) {
		return (await h.request('/api/auth/get-session', { cookie })).json();
	}

	it('reset revokes sessions', async () => {
		const target = await h.signIn('target@example.com');
		expect(await getSession(target.cookie)).not.toBeNull();

		expect(await resetAccountPassword(h.auth, admin.headers, targetId, NEW_PASSWORD)).toEqual({
			revoked: true
		});

		expect(await getSession(target.cookie)).toBeNull();
	});

	it('admin session survives', async () => {
		await resetAccountPassword(h.auth, admin.headers, targetId, NEW_PASSWORD);

		expect((await getSession(admin.cookie))?.user?.email).toBe('admin@example.com');
	});

	it('old password stops working', async () => {
		await resetAccountPassword(h.auth, admin.headers, targetId, NEW_PASSWORD);

		expect(await canSignIn(HARNESS_PASSWORD)).toBe(false);
		expect(await canSignIn(NEW_PASSWORD)).toBe(true);
	});

	it('reset requires admin', async () => {
		await h.createUser({ email: 'member@example.com' });
		const member = await h.signIn('member@example.com');

		await expect(
			resetAccountPassword(h.auth, member.headers, targetId, NEW_PASSWORD)
		).rejects.toMatchObject({ statusCode: 403 });
		expect(await canSignIn(HARNESS_PASSWORD)).toBe(true);
	});

	it('reset validates', async () => {
		await expect(
			resetAccountPassword(h.auth, admin.headers, targetId, 'x'.repeat(7))
		).rejects.toMatchObject({ field: 'password', status: 400 });
		expect(await canSignIn(HARNESS_PASSWORD)).toBe(true);
	});

	it('unknown user', async () => {
		const error = await resetAccountPassword(
			h.auth,
			admin.headers,
			'no-such-user-id',
			NEW_PASSWORD
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AccountNotFoundError);
		expect(error).toMatchObject({ status: 404 });
	});

	it('revoke failure surfaced', async () => {
		const stub: ResetAuth = {
			api: {
				setUserPassword: async () => ({ status: true }),
				revokeUserSessions: async () => {
					throw new Error('revoke failed');
				}
			}
		};

		const outcome = await resetAccountPassword(stub, admin.headers, targetId, NEW_PASSWORD);

		expect(outcome.revoked).toBe(false);
		expect(outcome).toMatchObject({ message: expect.stringMatching(/not signed out/) });
	});
});
