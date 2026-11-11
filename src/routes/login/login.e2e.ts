import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { E2E_ORIGIN, SEEDED_MEMBER, signIn } from '../../../e2e/accounts.ts';

async function cookieHeader(context: BrowserContext) {
	return (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Posts the login form as a no-JS browser would and returns status + rendered alert text. */
async function postLogin(request: APIRequestContext, email: string, password: string) {
	const res = await request.post('/login', {
		headers: { Origin: E2E_ORIGIN, Accept: 'text/html' },
		form: { email, password },
		maxRedirects: 0
	});
	const alert = /<p role="alert">([^<]*)<\/p>/.exec(await res.text())?.[1];
	return { status: res.status(), alert };
}

test('generic error', async ({ request, page }) => {
	const outcomes = [
		await postLogin(request, 'nobody@e2e.test', 'whatever-password'),
		await postLogin(request, SEEDED_MEMBER.email, 'wrong-password-123'),
		await postLogin(request, 'not-an-email', 'whatever-password'),
		await postLogin(request, SEEDED_MEMBER.email, '')
	];

	expect(outcomes[0].alert).toBeTruthy();
	for (const outcome of outcomes) {
		expect(outcome).toEqual({ status: 400, alert: outcomes[0].alert });
	}

	// And the browser shows that same text.
	await page.goto('/login');
	await page.getByLabel('Email').fill('nobody@e2e.test');
	await page.getByLabel('Password').fill('whatever-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toHaveText(outcomes[0].alert!);
});

test('email case', async ({ page }) => {
	await signIn(page, {
		email: SEEDED_MEMBER.email.toUpperCase(),
		password: SEEDED_MEMBER.password
	});

	expect(new URL(page.url()).pathname).toBe('/');
});

test('sign-out revokes', async ({ page, context, request }) => {
	await signIn(page, SEEDED_MEMBER);
	const oldCookie = await cookieHeader(context);
	expect(oldCookie).toContain('session_token');

	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.waitForURL((url) => url.pathname === '/login');

	// Replaying the pre-sign-out cookie must not work: the session was deleted server-side.
	const replay = await request.get('/', { headers: { cookie: oldCookie }, maxRedirects: 0 });
	expect(replay.status()).toBe(303);
	expect(replay.headers()['location']).toBe('/login');
});

test('logout is POST-only', async ({ page, context, request }) => {
	await signIn(page, SEEDED_MEMBER);
	const cookie = await cookieHeader(context);

	const get = await request.get('/logout', { headers: { cookie }, maxRedirects: 0 });
	expect([404, 405]).toContain(get.status());

	const session = await request.get('/api/auth/get-session', { headers: { cookie } });
	expect((await session.json())?.user?.email).toBe(SEEDED_MEMBER.email);
});

test('signed-out redirects', async ({ page, request }) => {
	await page.goto('/');
	expect(new URL(page.url()).pathname).toBe('/login');

	await page.goto('/no-such-page');
	expect(new URL(page.url()).pathname).toBe('/login');

	const session = await request.get('/api/auth/get-session');
	expect(session.status()).toBe(200);
});
