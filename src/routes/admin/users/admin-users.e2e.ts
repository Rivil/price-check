import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/server/db/client.ts';
import { user } from '../../../lib/server/db/schema.ts';
import {
	E2E_DATABASE_URL,
	E2E_ORIGIN,
	SEEDED_ADMIN,
	SEEDED_MEMBER,
	signIn,
	uniqueEmail
} from '../../../../e2e/accounts.ts';

async function userExists(email: string) {
	const db = createDb(E2E_DATABASE_URL);
	try {
		return (await db.select({ id: user.id }).from(user).where(eq(user.email, email))).length > 0;
	} finally {
		db.$client.close();
	}
}

test('create then sign in', async ({ page }) => {
	const email = uniqueEmail('created');
	const password = 'initial-password-1';

	await signIn(page, SEEDED_ADMIN);
	await page.goto('/admin/users');
	await page.getByLabel('Name').fill('Created Person');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Initial password').fill(password);
	await page.getByRole('button', { name: 'Create account' }).click();
	await expect(page.getByRole('cell', { name: email })).toBeVisible();

	await page.goto('/');
	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.waitForURL((url) => url.pathname === '/login');

	await signIn(page, { email, password });
	expect(new URL(page.url()).pathname).toBe('/');
});

test('non-admin 403', async ({ page, context, request }) => {
	await signIn(page, SEEDED_MEMBER);
	const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

	for (const path of ['/admin/users', '/%61dmin/users']) {
		const res = await request.get(path, { headers: { cookie }, maxRedirects: 0 });
		expect(res.status(), path).toBe(403);
	}

	const email = uniqueEmail('forbidden');
	const post = await request.post('/admin/users?/create', {
		// Same-origin, so SvelteKit's CSRF check passes and the hook is what refuses.
		headers: { cookie, Origin: E2E_ORIGIN },
		form: { name: 'Sneaky', email, password: 'sneaky-password-1', role: 'admin' },
		maxRedirects: 0
	});
	expect(post.status()).toBe(403);
	expect(await post.text()).not.toContain('Cross-site POST form submissions are forbidden');
	expect(await userExists(email)).toBe(false);
});
