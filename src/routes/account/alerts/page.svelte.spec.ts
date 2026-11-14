import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../lib/styles/tokens.css';
import Page from './+page.svelte';

const saved = {
	topic: 'https://ntfy.sh/alice-own',
	tokenSet: true,
	enabled: true,
	priceDrops: true,
	checkFailures: false
};

const savedResend = {
	from: 'alerts@example.test',
	to: 'inbox@example.test',
	keySet: true,
	enabled: true,
	priceDrops: true,
	checkFailures: true
};

const savedSmtp = {
	host: 'smtp.example.test',
	port: '465',
	username: 'alice-login',
	from: 'alerts@example.test',
	to: 'mail@example.test',
	passwordSet: true,
	enabled: true,
	priceDrops: true,
	checkFailures: false
};

const DEFAULTS = {
	ntfy: { priceDrops: true, checkFailures: true },
	resend: { priceDrops: true, checkFailures: false },
	smtp: { priceDrops: true, checkFailures: false }
};

type Props = Parameters<typeof render<typeof Page>>[1];
const props = (
	ntfy: typeof saved | null,
	form: unknown = null,
	resend: typeof savedResend | null = null,
	smtp: typeof savedSmtp | null = null
) =>
	({
		data: { channels: { ntfy, resend, smtp }, defaults: DEFAULTS },
		form,
		params: {}
	}) as unknown as Props;

const ntfyCard = () => page.getByTestId('channel-ntfy');
const resendCard = () => page.getByTestId('channel-resend');
const smtpCard = () => page.getByTestId('channel-smtp');
const cards = { ntfy: ntfyCard, resend: resendCard, smtp: smtpCard };
type Kind = keyof typeof cards;
const others = (kind: Kind) =>
	(Object.keys(cards) as Kind[]).filter((k) => k !== kind).map((k) => cards[k]());

describe('account alerts page', () => {
	it('test success', async () => {
		render(Page, props(saved, { tested: 'ntfy' }));
		await expect.element(ntfyCard().getByRole('status')).toHaveTextContent('Test alert sent.');
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});

	it('test failure', async () => {
		render(Page, props(saved, { testKind: 'ntfy', testMessage: 'Not delivered: refused.' }));
		await expect
			.element(ntfyCard().getByRole('alert'))
			.toHaveTextContent('Not delivered: refused.');
	});

	it('saved channel', async () => {
		render(Page, props(saved));
		const card = ntfyCard();
		await expect.element(card.getByTestId('current-topic')).toHaveTextContent(saved.topic);
		await expect.element(card.getByTestId('token-state')).toHaveTextContent('Access token: set.');
		await expect.element(card.getByTestId('channel-state')).toHaveTextContent('Enabled');
		await expect.element(card.getByLabelText('Price drops')).toBeChecked();
		await expect.element(card.getByLabelText('Failed checks')).not.toBeChecked();
		await expect.element(card.getByRole('button', { name: 'Send test' })).toBeVisible();
		await expect.element(card.getByRole('button', { name: 'Disable' })).toBeVisible();
		// The token itself is never on the page; its field starts empty.
		await expect.element(card.getByLabelText(/Access token/)).toHaveValue('');
	});

	it('disabled channel keeps its topic', async () => {
		render(Page, props({ ...saved, enabled: false }));
		const card = ntfyCard();
		await expect.element(card.getByTestId('channel-state')).toHaveTextContent('Disabled');
		await expect.element(card.getByTestId('current-topic')).toHaveTextContent(saved.topic);
		await expect.element(card.getByRole('button', { name: 'Enable' })).toBeVisible();
		// Every saved channel can be tested, disabled or not (c-6).
		await expect.element(card.getByRole('button', { name: 'Send test' })).toBeVisible();
	});

	it('unsaved channel', async () => {
		render(Page, props(null));
		const card = ntfyCard();
		await expect.element(card.getByTestId('token-state')).toHaveTextContent('Access token: none.');
		await expect.element(card.getByLabelText('Price drops')).toBeChecked();
		await expect.element(card.getByLabelText('Failed checks')).toBeChecked();
		expect(page.getByRole('button', { name: 'Send test' }).elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Remove' }).elements()).toHaveLength(0);
	});

	it('resend new', async () => {
		render(Page, props(saved));
		const card = resendCard();
		// Ticks come from load's resend defaults: drops only (c-3).
		await expect.element(card.getByLabelText('Price drops')).toBeChecked();
		await expect.element(card.getByLabelText('Failed checks')).not.toBeChecked();
		// No login email to start from: the recipient starts empty.
		await expect.element(card.getByLabelText('Recipient address')).toHaveValue('');
		await expect.element(card.getByLabelText('Sender address')).toHaveValue('');
		await expect.element(card.getByLabelText('Resend API key')).toHaveValue('');
		await expect
			.element(card.getByTestId('current-email'))
			.toHaveTextContent('No email settings saved');
		await expect.element(card.getByTestId('key-state')).toHaveTextContent('API key: none.');
		expect(card.getByRole('button', { name: 'Send test' }).elements()).toHaveLength(0);
		expect(card.getByTestId('channel-state').elements()).toHaveLength(0);
	});

	it('resend saved', async () => {
		render(Page, props(null, null, savedResend));
		const card = resendCard();
		await expect.element(card.getByTestId('key-state')).toHaveTextContent('API key: set.');
		await expect.element(card.getByLabelText('Resend API key')).toHaveValue('');
		await expect.element(card.getByLabelText('Sender address')).toHaveValue(savedResend.from);
		await expect.element(card.getByLabelText('Recipient address')).toHaveValue(savedResend.to);
		await expect.element(card.getByTestId('current-email')).toHaveTextContent(savedResend.from);
		await expect.element(card.getByTestId('current-email')).toHaveTextContent(savedResend.to);
		await expect.element(card.getByTestId('channel-state')).toHaveTextContent('Enabled');
		// Saved ticks win over the type's defaults.
		await expect.element(card.getByLabelText('Failed checks')).toBeChecked();
		await expect.element(card.getByRole('button', { name: 'Send test' })).toBeVisible();
	});

	it('smtp new', async () => {
		render(Page, props(saved, null, savedResend));
		const card = smtpCard();
		// Port 587 (decision port_default), drops only (c-3), recipient empty.
		await expect.element(card.getByLabelText('Port')).toHaveValue('587');
		await expect.element(card.getByLabelText('Price drops')).toBeChecked();
		await expect.element(card.getByLabelText('Failed checks')).not.toBeChecked();
		await expect.element(card.getByLabelText('Recipient address')).toHaveValue('');
		await expect.element(card.getByLabelText('SMTP server host')).toHaveValue('');
		await expect.element(card.getByLabelText('Password')).toHaveValue('');
		await expect.element(card.getByTestId('password-state')).toHaveTextContent('Password: none.');
		expect(card.getByRole('button', { name: 'Send test' }).elements()).toHaveLength(0);
		expect(card.getByTestId('channel-state').elements()).toHaveLength(0);
	});

	it('smtp saved', async () => {
		render(Page, props(null, null, null, savedSmtp));
		const card = smtpCard();
		await expect.element(card.getByTestId('password-state')).toHaveTextContent('Password: set.');
		// The password itself is never on the page; its field starts empty.
		await expect.element(card.getByLabelText('Password')).toHaveValue('');
		await expect.element(card.getByLabelText('SMTP server host')).toHaveValue(savedSmtp.host);
		await expect.element(card.getByLabelText('Port')).toHaveValue(savedSmtp.port);
		await expect.element(card.getByLabelText('Username')).toHaveValue(savedSmtp.username);
		await expect.element(card.getByLabelText('Sender address')).toHaveValue(savedSmtp.from);
		await expect.element(card.getByLabelText('Recipient address')).toHaveValue(savedSmtp.to);
		await expect.element(card.getByTestId('current-smtp')).toHaveTextContent(savedSmtp.host);
		await expect.element(card.getByTestId('channel-state')).toHaveTextContent('Enabled');
		await expect.element(card.getByRole('button', { name: 'Send test' })).toBeVisible();
	});

	it('scoped messages', async () => {
		const hint = "Not delivered: refused. Check the sender's domain is verified in Resend.";
		const appHint =
			'Not delivered: bad credentials. Gmail and most providers need an app password, not your account password.';
		const cases: [unknown, Kind, 'alert' | 'status', string][] = [
			[{ kind: 'resend', message: 'Enter your Resend API key.' }, 'resend', 'alert', 'API key'],
			[{ kind: 'ntfy', message: 'Enter your ntfy topic link.' }, 'ntfy', 'alert', 'topic link'],
			[{ kind: 'smtp', message: 'Enter the SMTP port.' }, 'smtp', 'alert', 'SMTP port'],
			[{ testKind: 'resend', testMessage: hint }, 'resend', 'alert', hint],
			[{ testKind: 'ntfy', testMessage: 'Not delivered: timeout.' }, 'ntfy', 'alert', 'timeout'],
			[{ testKind: 'smtp', testMessage: appHint }, 'smtp', 'alert', 'app password'],
			[{ saved: 'resend' }, 'resend', 'status', 'Saved.'],
			[{ saved: 'ntfy' }, 'ntfy', 'status', 'Saved.'],
			[{ saved: 'smtp' }, 'smtp', 'status', 'Saved.'],
			[{ tested: 'resend' }, 'resend', 'status', 'Test alert sent.'],
			[{ tested: 'ntfy' }, 'ntfy', 'status', 'Test alert sent.'],
			[{ tested: 'smtp' }, 'smtp', 'status', 'Test alert sent.']
		];
		for (const [form, kind, role, words] of cases) {
			const { unmount } = render(Page, props(saved, form, savedResend, savedSmtp));
			await expect.element(cards[kind]().getByRole(role)).toHaveTextContent(words);
			for (const other of others(kind)) {
				expect(other.getByRole(role).elements(), JSON.stringify(form)).toHaveLength(0);
			}
			unmount();
		}

		// A removal shows only in the card that was removed.
		for (const kind of ['ntfy', 'resend', 'smtp'] as const) {
			const { unmount } = render(
				Page,
				props(
					kind === 'ntfy' ? null : saved,
					{ removed: kind },
					kind === 'resend' ? null : savedResend,
					kind === 'smtp' ? null : savedSmtp
				)
			);
			await expect.element(cards[kind]().getByRole('status')).toHaveTextContent('Channel removed.');
			for (const other of others(kind)) {
				expect(other.getByRole('status').elements()).toHaveLength(0);
			}
			unmount();
		}
	});
});
