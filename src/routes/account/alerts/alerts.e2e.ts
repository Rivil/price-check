import { expect, test, type Page } from '@playwright/test';
import {
	SEEDED_DESIGN,
	SEEDED_DESIGN_TOPIC_URL,
	SEEDED_MEMBER,
	signIn
} from '../../../../e2e/accounts.ts';

// Send test is clicked here, but only for a topic on https://127.0.0.1:1/ — a closed
// loopback port, refused at once with no DNS lookup — so it never reaches a real
// ntfy server. Other saved topics never get a test send. Resend's Send test is never
// clicked: its endpoint is fixed to api.resend.com (decision resend_endpoint), so it
// would be a live call; its outcomes are pinned in the page server and component specs.
// SMTP's Send test goes only to 127.0.0.1 port 1, likewise closed: no live mail server.

const REFUSED_TOPIC = 'https://127.0.0.1:1/e2e-member';

async function openAlerts(page: Page) {
	await page.goto('/account/alerts');
	await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible();
}

const ntfyCard = (page: Page) => page.getByTestId('channel-ntfy');
const resendCard = (page: Page) => page.getByTestId('channel-resend');
const smtpCard = (page: Page) => page.getByTestId('channel-smtp');

/**
 * The member starts each test with no channel saved: a card of either type left by
 * an earlier or retried test is removed first.
 */
async function asFreshMember(page: Page) {
	await signIn(page, SEEDED_MEMBER);
	await openAlerts(page);
	for (const card of [ntfyCard(page), resendCard(page), smtpCard(page)]) {
		const remove = card.getByRole('button', { name: 'Remove' });
		if ((await remove.count()) > 0) {
			await remove.click();
			await expect(card.getByRole('status')).toHaveText('Channel removed.');
			await page.reload();
		}
	}
	await expect(ntfyCard(page).getByTestId('current-topic')).toHaveText(
		'No topic saved: you will not get alerts here.'
	);
	await expect(resendCard(page).getByTestId('current-email')).toHaveText(
		'No email settings saved: you will not get alerts here.'
	);
	await expect(smtpCard(page).getByTestId('current-smtp')).toHaveText(
		'No SMTP settings saved: you will not get alerts here.'
	);
}

async function saveTopic(page: Page, topic: string, token?: string) {
	await ntfyCard(page).getByLabel('ntfy topic link').fill(topic);
	if (token !== undefined)
		await ntfyCard(page)
			.getByLabel(/Access token/)
			.fill(token);
	await ntfyCard(page).getByRole('button', { name: 'Save topic' }).click();
	// Wait for the enhanced POST to land before reloading, or the reload can abort it.
	await expect(ntfyCard(page).getByRole('status')).toHaveText('Saved.');
}

test('upgraded', async ({ page }) => {
	// The design user's channel was seeded in the legacy plaintext table and moved
	// across at startup: it shows as before, with nothing to re-enter.
	await signIn(page, SEEDED_DESIGN);
	await openAlerts(page);
	await expect(ntfyCard(page).locator('code').first()).toHaveText(SEEDED_DESIGN_TOPIC_URL);
	await expect(ntfyCard(page).getByTestId('channel-state')).toContainText('Enabled');
	await expect(ntfyCard(page).getByLabel('Price drops')).toBeChecked();
	await expect(ntfyCard(page).getByLabel('Failed checks')).toBeChecked();
	await expect(ntfyCard(page).getByTestId('token-state')).toHaveText('Access token: set.');
});

test('send test', async ({ page }) => {
	await asFreshMember(page);
	await expect(ntfyCard(page).getByRole('button', { name: 'Send test' })).toHaveCount(0);

	// An invalid link is refused and nothing is saved.
	await ntfyCard(page).getByLabel('ntfy topic link').fill('http://ntfy.sh/not-https');
	await ntfyCard(page).getByRole('button', { name: 'Save topic' }).click();
	await expect(ntfyCard(page).getByRole('alert')).toContainText('ntfy topic link');
	await page.reload();
	await expect(ntfyCard(page).getByRole('button', { name: 'Send test' })).toHaveCount(0);

	await saveTopic(page, REFUSED_TOPIC);
	await page.reload();
	await ntfyCard(page).getByRole('button', { name: 'Send test' }).click();
	await expect(ntfyCard(page).getByRole('alert')).toHaveText('Not delivered: unreachable.');
});

test('settings', async ({ page }) => {
	await asFreshMember(page);
	await saveTopic(page, 'https://ntfy.e2e.invalid/e2e-member-settings');

	await ntfyCard(page).getByLabel('Failed checks').uncheck();
	await ntfyCard(page).getByRole('button', { name: 'Save topic' }).click();
	await expect(ntfyCard(page).getByRole('status')).toHaveText('Saved.');
	await page.reload();
	await expect(ntfyCard(page).getByLabel('Price drops')).toBeChecked();
	await expect(ntfyCard(page).getByLabel('Failed checks')).not.toBeChecked();

	// Neither kind ticked is refused.
	await ntfyCard(page).getByLabel('Price drops').uncheck();
	await ntfyCard(page).getByRole('button', { name: 'Save topic' }).click();
	await expect(ntfyCard(page).getByRole('alert')).toBeVisible();
	await page.reload();
	await expect(ntfyCard(page).getByLabel('Price drops')).toBeChecked();

	await ntfyCard(page).getByRole('button', { name: 'Disable' }).click();
	await expect(ntfyCard(page).getByTestId('channel-state')).toContainText('Disabled');
	await page.reload();
	await expect(ntfyCard(page).getByTestId('channel-state')).toContainText('Disabled');
	await expect(ntfyCard(page).locator('code').first()).toHaveText(
		'https://ntfy.e2e.invalid/e2e-member-settings'
	);
	await expect(ntfyCard(page).getByLabel('Failed checks')).not.toBeChecked();

	await ntfyCard(page).getByRole('button', { name: 'Enable' }).click();
	await expect(ntfyCard(page).getByTestId('channel-state')).toContainText('Enabled');
	await page.reload();
	await expect(ntfyCard(page).getByTestId('channel-state')).toContainText('Enabled');
	await expect(ntfyCard(page).locator('code').first()).toHaveText(
		'https://ntfy.e2e.invalid/e2e-member-settings'
	);
});

test('credential', async ({ page }) => {
	const token = 'tk_e2eMemberToken0123456789abcdef'; // token-shaped, test-only
	await asFreshMember(page);
	await saveTopic(page, 'https://ntfy.e2e.invalid/e2e-member-credential', token);
	expect(await page.content()).not.toContain(token);

	await page.reload();
	expect(await page.content()).not.toContain(token);
	await expect(ntfyCard(page).getByLabel(/Access token/)).toHaveValue('');
	await expect(ntfyCard(page).getByTestId('token-state')).toHaveText('Access token: set.');
});

test('remove', async ({ page }) => {
	await asFreshMember(page);
	await saveTopic(page, 'https://ntfy.e2e.invalid/e2e-member-remove');
	await page.reload();
	await expect(ntfyCard(page).locator('code')).toHaveCount(1);

	await ntfyCard(page).getByRole('button', { name: 'Remove' }).click();
	await expect(ntfyCard(page).getByRole('status')).toHaveText('Channel removed.');
	await page.reload();
	await expect(ntfyCard(page).locator('code')).toHaveCount(0);
	await expect(ntfyCard(page).getByTestId('channel-state')).toHaveCount(0);
	await expect(ntfyCard(page).getByRole('button', { name: 'Send test' })).toHaveCount(0);
});

test('resend', async ({ page }) => {
	const key = 're_e2eMemberKey_0123456789abcdef'; // key-shaped, test-only
	const badKey = 're_bad key typed here';
	await asFreshMember(page);
	const card = resendCard(page);

	// A new card: drops only, recipient prefilled with the login email.
	await expect(card.getByLabel('Price drops')).toBeChecked();
	await expect(card.getByLabel('Failed checks')).not.toBeChecked();
	await expect(card.getByLabel('Recipient address')).toHaveValue(SEEDED_MEMBER.email);

	// A bad key is refused, and what was typed is nowhere in the page.
	await card.getByLabel('Resend API key').fill(badKey);
	await card.getByLabel('Sender address').fill('alerts@e2e.invalid');
	await card.getByRole('button', { name: 'Save email settings' }).click();
	await expect(card.getByRole('alert')).toContainText('API key');
	expect(await page.content()).not.toContain(badKey);
	await page.reload();
	await expect(card.getByTestId('key-state')).toHaveText('API key: none.');

	await card.getByLabel('Resend API key').fill(key);
	await card.getByLabel('Sender address').fill('alerts@e2e.invalid');
	await card.getByRole('button', { name: 'Save email settings' }).click();
	await expect(card.getByRole('status')).toHaveText('Saved.');
	expect(await page.content()).not.toContain(key);

	await page.reload();
	expect(await page.content()).not.toContain(key);
	await expect(card.getByTestId('key-state')).toHaveText('API key: set.');
	await expect(card.getByLabel('Resend API key')).toHaveValue('');
	await expect(card.getByLabel('Sender address')).toHaveValue('alerts@e2e.invalid');

	// Saving again with the key left blank keeps it.
	await card.getByLabel('Recipient address').fill('other@e2e.invalid');
	await card.getByRole('button', { name: 'Save email settings' }).click();
	await expect(card.getByRole('status')).toHaveText('Saved.');
	await page.reload();
	await expect(card.getByTestId('key-state')).toHaveText('API key: set.');
	await expect(card.getByLabel('Recipient address')).toHaveValue('other@e2e.invalid');
	// The ntfy card is untouched.
	await expect(ntfyCard(page).getByTestId('channel-state')).toHaveCount(0);
});

test('smtp', async ({ page }) => {
	const password = 'e2e-smtp-app-password-0123'; // test-only
	const refusedPassword = 'e2e-smtp-refused-password-9876'; // test-only
	await asFreshMember(page);
	const card = smtpCard(page);

	// A new card: port 587, drops only, recipient prefilled with the login email.
	await expect(card.getByLabel('Port')).toHaveValue('587');
	await expect(card.getByLabel('Price drops')).toBeChecked();
	await expect(card.getByLabel('Failed checks')).not.toBeChecked();
	await expect(card.getByLabel('Recipient address')).toHaveValue(SEEDED_MEMBER.email);

	// A refused save (port 0) names the field, and the typed password is nowhere in the page.
	await card.getByLabel('SMTP server host').fill('127.0.0.1');
	await card.getByLabel('Port').fill('0');
	await card.getByLabel('Username').fill('e2e-member');
	await card.getByLabel('Password').fill(refusedPassword);
	await card.getByLabel('Sender address').fill('alerts@e2e.invalid');
	await card.getByRole('button', { name: 'Save SMTP settings' }).click();
	await expect(card.getByRole('alert')).toContainText('SMTP port');
	expect(await page.content()).not.toContain(refusedPassword);
	await page.reload();
	await expect(card.getByTestId('password-state')).toHaveText('Password: none.');

	await card.getByLabel('SMTP server host').fill('127.0.0.1');
	await card.getByLabel('Port').fill('1');
	await card.getByLabel('Username').fill('e2e-member');
	await card.getByLabel('Password').fill(password);
	await card.getByLabel('Sender address').fill('alerts@e2e.invalid');
	await card.getByRole('button', { name: 'Save SMTP settings' }).click();
	await expect(card.getByRole('status')).toHaveText('Saved.');
	expect(await page.content()).not.toContain(password);

	await page.reload();
	expect(await page.content()).not.toContain(password);
	await expect(card.getByTestId('password-state')).toHaveText('Password: set.');
	await expect(card.getByLabel('Password')).toHaveValue('');
	await expect(card.getByLabel('SMTP server host')).toHaveValue('127.0.0.1');

	// Saving again with the password left blank keeps it.
	await card.getByLabel('Recipient address').fill('other@e2e.invalid');
	await card.getByRole('button', { name: 'Save SMTP settings' }).click();
	await expect(card.getByRole('status')).toHaveText('Saved.');
	await page.reload();
	await expect(card.getByTestId('password-state')).toHaveText('Password: set.');
	await expect(card.getByLabel('Recipient address')).toHaveValue('other@e2e.invalid');

	// Send test to a closed loopback port: unreachable, shown in the SMTP card only.
	await card.getByRole('button', { name: 'Send test' }).click();
	await expect(card.getByRole('alert')).toHaveText('Not delivered: unreachable.');
	await expect(ntfyCard(page).getByRole('alert')).toHaveCount(0);
	await expect(resendCard(page).getByRole('alert')).toHaveCount(0);
});
