import { expect, test } from '@playwright/test';
import { SEEDED_ADMIN, signIn, submitLogin, uniqueEmail } from '../../../../../../e2e/accounts.ts';

test('reset via form', async ({ page: adminPage, browser }) => {
	const email = uniqueEmail('reset');
	const oldPassword = 'initial-password-1';
	const newPassword = 'admin-reset-password-2';

	// The admin creates the account through the UI.
	await signIn(adminPage, SEEDED_ADMIN);
	await adminPage.goto('/admin/users');
	await adminPage.getByLabel('Name').fill('Reset Target');
	await adminPage.getByLabel('Email').fill(email);
	await adminPage.getByLabel('Initial password').fill(oldPassword);
	await adminPage.getByRole('button', { name: 'Create account' }).click();
	await expect(adminPage.getByRole('cell', { name: email })).toBeVisible();

	// The target signs in on a second device.
	const userContext = await browser.newContext();
	try {
		const userPage = await userContext.newPage();
		await signIn(userPage, { email, password: oldPassword });

		// The admin resets the target's password from the list page's row link.
		await adminPage.goto('/admin/users');
		await adminPage
			.getByRole('row')
			.filter({ has: adminPage.getByRole('cell', { name: email, exact: true }) })
			.getByRole('link', { name: 'Reset password' })
			.click();
		await adminPage.waitForURL((url) => /^\/admin\/users\/[^/]+\/password$/.test(url.pathname));
		await expect(adminPage.getByRole('heading', { level: 1 })).toHaveText(
			'Reset password for Reset Target'
		);
		await adminPage.getByLabel('New password').fill(newPassword);
		await adminPage.getByRole('button', { name: 'Reset password' }).click();
		await expect(adminPage.getByRole('status')).toContainText('Password reset');

		// The target's next navigation is signed out.
		await userPage.goto('/');
		expect(new URL(userPage.url()).pathname).toBe('/login');

		await submitLogin(userPage, { email, password: oldPassword });
		await expect(userPage.getByRole('alert')).toHaveText('Incorrect email or password.');

		await signIn(userPage, { email, password: newPassword });
		expect(new URL(userPage.url()).pathname).toBe('/');
	} finally {
		await userContext.close();
	}
});
