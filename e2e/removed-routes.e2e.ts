import { expect, test, type APIResponse } from '@playwright/test';
import { E2E_ORIGIN } from './accounts.ts';

// c-3 over HTTP, on the built preview server: every URL of the deleted auth stack is
// a plain 404 (decision removed_routes) — no redirect to /, no cookie set — for a
// GET and for a same-origin form or JSON POST. Same origin, so Kit's CSRF check
// lets the POSTs through: a 403 here would mean the route was never reached.

const REMOVED_PATHS = [
	'/login',
	'/logout',
	'/account/password',
	'/admin/users',
	'/admin/users/x/password',
	'/api/auth',
	'/api/auth/get-session',
	'/api/auth/session',
	'/api/auth/sign-in/email',
	'/login/__data.json'
];

/** A sign-in shaped body: test-only values, sent only to the local preview server. */
const CREDENTIALS = { email: 'me@e2e.invalid', password: 'e2e-not-a-password' };

for (const path of REMOVED_PATHS) {
	test(`${path} is a plain 404`, async ({ request }) => {
		const responses: [string, APIResponse][] = [
			['GET', await request.get(path, { maxRedirects: 0 })],
			[
				'form POST',
				await request.post(path, {
					headers: { origin: E2E_ORIGIN },
					form: CREDENTIALS,
					maxRedirects: 0
				})
			],
			[
				'JSON POST',
				await request.post(path, {
					headers: { origin: E2E_ORIGIN },
					data: CREDENTIALS,
					maxRedirects: 0
				})
			]
		];
		for (const [what, res] of responses) {
			expect(res.status(), what).toBe(404);
			expect(res.headers()['location'], `${what} location`).toBeUndefined();
			expect(res.headers()['set-cookie'], `${what} set-cookie`).toBeUndefined();
		}
	});
}
