import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { auth } from '#lib/server/auth.ts';
import { loginLimiter, tooManyAttemptsMessage } from '#lib/server/login-limiter.ts';

// One message for every failure, so the response never reveals whether an email exists (c-5).
const LOGIN_FAILED = 'Incorrect email or password.';

export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '').trim();
		const password = String(data.get('password') ?? '');
		const ip = getClientAddress();

		// Checked before the password: over the limit, even the right one is refused.
		const limit = loginLimiter.check(email, ip);
		if (!limit.ok) {
			return fail(429, { email, message: tooManyAttemptsMessage(limit.retryAfterSeconds) });
		}

		try {
			// sveltekitCookies (last plugin in auth.ts) sets the session cookie on this event.
			await auth.api.signInEmail({ body: { email, password }, headers: request.headers });
		} catch {
			loginLimiter.recordFailure(email, ip);
			return fail(400, { email, message: LOGIN_FAILED });
		}

		loginLimiter.recordSuccess(email);
		redirect(303, '/');
	}
};
