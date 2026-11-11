import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isActionFailure, isRedirect } from '@sveltejs/kit';
import { LOGIN_LIMITS, loginLimiter } from '#lib/server/login-limiter.ts';

// better-auth is replaced: signInEmail succeeds only for the right password. The
// limiter is the real server singleton, reset between tests.
const mocks = vi.hoisted(() => ({
	signInEmail: vi.fn(async ({ body }: { body: { email: string; password: string } }) => {
		if (body.password !== 'right-password') throw new Error('INVALID_EMAIL_OR_PASSWORD');
		return { token: 't' };
	})
}));
vi.mock('#lib/server/auth.ts', () => ({ auth: { api: { signInEmail: mocks.signInEmail } } }));

const { actions } = await import('./+page.server.ts');
type Event = Parameters<typeof actions.default>[0];

function event(email: string, password: string, ip = '203.0.113.7') {
	return {
		request: new Request('http://localhost/login', {
			method: 'POST',
			body: new URLSearchParams({ email, password })
		}),
		getClientAddress: () => ip
	} as unknown as Event;
}

async function login(email: string, password: string, ip?: string) {
	try {
		return await actions.default(event(email, password, ip));
	} catch (e) {
		if (isRedirect(e)) return { redirect: e.location, status: e.status };
		throw e;
	}
}

beforeEach(() => {
	vi.useFakeTimers({ now: new Date('2026-11-03T09:00:00Z'), toFake: ['Date'] });
	loginLimiter.reset();
	mocks.signInEmail.mockClear();
});
afterEach(() => {
	vi.useRealTimers();
	loginLimiter.reset();
});

describe('/login rate limit', () => {
	it('signs in with the right password', async () => {
		expect(await login('a@example.test', 'right-password')).toEqual({
			redirect: '/',
			status: 303
		});
	});

	it('trims the email before signing in', async () => {
		// Paste and autofill can pad the address; better-auth must get the bare one.
		expect(await login('  a@example.test  ', 'right-password')).toEqual({
			redirect: '/',
			status: 303
		});
		expect(mocks.signInEmail).toHaveBeenCalledWith(
			expect.objectContaining({ body: { email: 'a@example.test', password: 'right-password' } })
		);

		expect(await login('\tb@example.test ', 'wrong')).toMatchObject({
			status: 400,
			data: { email: 'b@example.test', message: 'Incorrect email or password.' }
		});
	});

	it('refuses the email after its limit, even with the right password, without asking auth', async () => {
		for (let i = 0; i < LOGIN_LIMITS.perEmail.max; i++) {
			// Different addresses: only the email limit applies.
			expect(await login('A@example.test', 'wrong', `198.51.100.${i}`)).toMatchObject({
				status: 400,
				data: { message: 'Incorrect email or password.' }
			});
		}
		mocks.signInEmail.mockClear();

		const blocked = await login('a@example.test', 'right-password', '192.0.2.1');
		expect(isActionFailure(blocked)).toBe(true);
		expect(blocked).toMatchObject({
			status: 429,
			data: {
				email: 'a@example.test',
				message: 'Too many sign-in attempts. Try again in 15 minutes.'
			}
		});
		expect(mocks.signInEmail).not.toHaveBeenCalled();

		// Another account is unaffected.
		expect(await login('b@example.test', 'right-password', '192.0.2.1')).toMatchObject({
			status: 303
		});

		// Once the window has passed, the right password works again.
		vi.setSystemTime(Date.now() + LOGIN_LIMITS.perEmail.windowMs);
		expect(await login('a@example.test', 'right-password', '192.0.2.1')).toMatchObject({
			status: 303
		});
	});

	it('refuses an address after its limit, across emails', async () => {
		for (let i = 0; i < LOGIN_LIMITS.perIp.max; i++) {
			await login(`user${i}@example.test`, 'wrong', '203.0.113.50');
		}
		mocks.signInEmail.mockClear();

		expect(await login('fresh@example.test', 'right-password', '203.0.113.50')).toMatchObject({
			status: 429
		});
		expect(mocks.signInEmail).not.toHaveBeenCalled();
		expect(await login('fresh@example.test', 'right-password', '203.0.113.51')).toMatchObject({
			status: 303
		});
	});

	it('a successful sign-in clears that email’s failures', async () => {
		for (let i = 0; i < LOGIN_LIMITS.perEmail.max - 1; i++) {
			await login('a@example.test', 'wrong', `198.51.100.${i}`);
		}
		await login('a@example.test', 'right-password', '192.0.2.9');

		for (let i = 0; i < LOGIN_LIMITS.perEmail.max - 1; i++) {
			await login('a@example.test', 'wrong', `198.51.100.${i + 50}`);
		}
		expect(await login('a@example.test', 'right-password', '192.0.2.9')).toMatchObject({
			status: 303
		});
	});
});
