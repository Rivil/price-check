import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeOwnPassword, OwnPasswordError } from './own-password.ts';
import { createAuthHarness, HARNESS_PASSWORD, type AuthHarness } from './testing/auth-harness.ts';

const EMAIL = 'member@example.com';
const NEW_PASSWORD = 'brand-new-password-1';

describe('changeOwnPassword', () => {
	let h: AuthHarness;

	beforeEach(async () => {
		h = await createAuthHarness();
		await h.createUser({ email: EMAIL });
	});

	afterEach(() => {
		h.cleanup();
	});

	async function canSignIn(password: string) {
		return h.signIn(EMAIL, password).then(
			() => true,
			() => false
		);
	}

	async function sessionUserEmail(cookie: string) {
		const session = await h.auth.api.getSession({ headers: new Headers({ cookie }) });
		return session?.user.email ?? null;
	}

	it('wrong current rejected', async () => {
		const { headers } = await h.signIn(EMAIL);

		await expect(
			changeOwnPassword(h.auth, headers, 'not-the-password', NEW_PASSWORD)
		).rejects.toMatchObject({ field: 'currentPassword', status: 400 });
		expect(await canSignIn(HARNESS_PASSWORD)).toBe(true);
		expect(await canSignIn(NEW_PASSWORD)).toBe(false);
	});

	it('old password stops working', async () => {
		const { headers } = await h.signIn(EMAIL);

		await changeOwnPassword(h.auth, headers, HARNESS_PASSWORD, NEW_PASSWORD);

		expect(await canSignIn(HARNESS_PASSWORD)).toBe(false);
		expect(await canSignIn(NEW_PASSWORD)).toBe(true);
	});

	it('sessions rotated', async () => {
		const other = await h.signIn(EMAIL);
		const changing = await h.signIn(EMAIL);

		const result = await changeOwnPassword(
			h.auth,
			changing.headers,
			HARNESS_PASSWORD,
			NEW_PASSWORD
		);

		expect(await sessionUserEmail(other.cookie)).toBeNull();
		expect(await sessionUserEmail(changing.cookie)).toBeNull();

		expect(result.token).toBeTruthy();
		expect(result.token).not.toBe(changing.token);
		const newCookie = result.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ');
		expect(newCookie).toContain(result.token!);
		expect(await sessionUserEmail(newCookie)).toBe(EMAIL);
	});

	it('new password policy', async () => {
		const { headers } = await h.signIn(EMAIL);

		const error = await changeOwnPassword(h.auth, headers, HARNESS_PASSWORD, 'x'.repeat(7)).catch(
			(e: unknown) => e
		);

		expect(error).toBeInstanceOf(OwnPasswordError);
		expect(error).toMatchObject({ field: 'newPassword', status: 400 });
		expect(await canSignIn(HARNESS_PASSWORD)).toBe(true);
	});
});
