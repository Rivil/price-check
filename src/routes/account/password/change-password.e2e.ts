import { expect, test } from '@playwright/test';
import { createAuth } from '../../../lib/server/auth-factory.ts';
import { createDb } from '../../../lib/server/db/client.ts';
import {
	E2E_DATABASE_URL,
	E2E_ORIGIN,
	E2E_SECRET,
	signIn,
	submitLogin,
	uniqueEmail
} from '../../../../e2e/accounts.ts';

async function createFreshUser(email: string, password: string) {
	const db = createDb(E2E_DATABASE_URL);
	try {
		const auth = createAuth({ db, baseURL: E2E_ORIGIN, secret: E2E_SECRET });
		await auth.api.createUser({
			body: { email, name: 'Password Changer', password, role: 'user' }
		});
	} finally {
		db.$client.close();
	}
}

test('change via form', async ({ page }) => {
	const email = uniqueEmail('changer');
	const oldPassword = 'original-password-1';
	const newPassword = 'replacement-password-2';
	await createFreshUser(email, oldPassword);

	await signIn(page, { email, password: oldPassword });
	await page.goto('/account/password');
	await expect(page).toHaveTitle('Account · Amazon price check');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account');
	await expect(page.getByRole('heading', { level: 2, name: 'Change password' })).toBeVisible();
	await page.getByLabel('Current password').fill(oldPassword);
	await page.getByLabel('New password').fill(newPassword);
	await page.getByRole('button', { name: 'Change password' }).click();
	await expect(page.getByRole('status')).toContainText('Password changed');

	// Still signed in: the fresh session cookie reached the browser.
	await page.goto('/');
	expect(new URL(page.url()).pathname).toBe('/');

	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.waitForURL((url) => url.pathname === '/login');

	await submitLogin(page, { email, password: oldPassword });
	await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.');

	await signIn(page, { email, password: newPassword });
	expect(new URL(page.url()).pathname).toBe('/');
});
