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

/** The desktop row as installDesktop seeds it: on, price drops only (c-4). */
const seededDesktop = { enabled: true, priceDrops: true, checkFailures: false };
const DESKTOP_DEFAULTS = { priceDrops: true, checkFailures: false };

type Props = Parameters<typeof render<typeof Page>>[1];
/** desktop left out: no 'desktop' key at all, as load returns outside Electron. */
const props = (
	ntfy: typeof saved | null,
	form: unknown = null,
	resend: typeof savedResend | null = null,
	smtp: typeof savedSmtp | null = null,
	desktop?: typeof seededDesktop | null
) =>
	({
		data:
			desktop === undefined
				? { channels: { ntfy, resend, smtp }, defaults: DEFAULTS }
				: {
						channels: { ntfy, resend, smtp, desktop },
						defaults: { ...DEFAULTS, desktop: DESKTOP_DEFAULTS }
					},
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

describe('desktop card', () => {
	const desktopCard = () => page.getByTestId('channel-desktop');
	/** Every saved channel, desktop included. */
	const allSaved = (form: unknown = null, desktop = seededDesktop) =>
		props(saved, form, savedResend, savedSmtp, desktop);

	it('no desktop key', async () => {
		render(Page, props(saved, null, savedResend, savedSmtp));
		await expect.element(ntfyCard()).toBeVisible();
		expect(desktopCard().elements()).toHaveLength(0);
		expect(document.querySelectorAll('[data-testid="channel-desktop"]')).toHaveLength(0);
		expect(page.getByRole('heading', { name: 'Desktop' }).elements()).toHaveLength(0);
	});

	it('seeded desktop', async () => {
		render(Page, allSaved());
		const card = desktopCard();
		await expect.element(card.getByTestId('channel-state')).toHaveTextContent('Status: Enabled');
		await expect.element(card.getByLabelText('Price drops')).toBeChecked();
		await expect.element(card.getByLabelText('Failed checks')).not.toBeChecked();
		await expect.element(card.getByRole('button', { name: 'Disable' })).toBeVisible();
		await expect.element(card.getByRole('button', { name: 'Send test' })).toBeVisible();
		// First on the page.
		const first = document.querySelector('main section.channel');
		expect(first?.getAttribute('data-testid')).toBe('channel-desktop');
	});

	it('disabled desktop', async () => {
		render(Page, allSaved(null, { ...seededDesktop, enabled: false }));
		const card = desktopCard();
		await expect.element(card.getByTestId('channel-state')).toHaveTextContent('Disabled');
		await expect.element(card.getByRole('button', { name: 'Enable' })).toBeVisible();
		await expect.element(card.getByRole('button', { name: 'Send test' })).toBeVisible();
	});

	it('no remove, no fields', async () => {
		render(Page, allSaved());
		await expect.element(desktopCard()).toBeVisible();
		const card = desktopCard().element();
		expect(desktopCard().getByRole('button', { name: 'Remove' }).elements()).toHaveLength(0);
		expect(card.querySelector('form[action="?/remove"]')).toBeNull();
		// Hidden kind inputs and the two ticks only: nothing to type into.
		const inputs = [...card.querySelectorAll('input')].map((input) => input.type);
		expect(inputs.filter((type) => type !== 'hidden' && type !== 'checkbox')).toEqual([]);
		expect(desktopCard().getByRole('textbox').elements()).toHaveLength(0);
		// The other saved cards keep their Remove.
		for (const other of Object.values(cards)) {
			await expect.element(other().getByRole('button', { name: 'Remove' })).toBeVisible();
		}
	});

	it('desktop messages', async () => {
		const unsupported = 'Not delivered: notifications not supported.';
		const failed = render(Page, allSaved({ testKind: 'desktop', testMessage: unsupported }));
		await expect.element(desktopCard().getByRole('alert')).toHaveTextContent(unsupported);
		expect(page.getByRole('alert').elements()).toHaveLength(1);
		for (const other of Object.values(cards)) {
			expect(other().getByRole('alert').elements()).toHaveLength(0);
		}
		failed.unmount();

		const sent = render(Page, allSaved({ tested: 'desktop' }));
		await expect.element(desktopCard().getByRole('status')).toHaveTextContent('Test alert sent.');
		for (const other of Object.values(cards)) {
			expect(other().getByRole('status').elements()).toHaveLength(0);
		}
		sent.unmount();

		// A refused removal shows in the desktop card only.
		render(
			Page,
			allSaved({
				kind: 'desktop',
				message: "The desktop channel can't be removed; disable it instead."
			})
		);
		await expect.element(desktopCard().getByRole('alert')).toHaveTextContent('disable it instead');
		for (const other of Object.values(cards)) {
			expect(other().getByRole('alert').elements()).toHaveLength(0);
		}
	});

	it('desktop save form', async () => {
		render(Page, allSaved());
		const card = desktopCard();
		await expect.element(card.getByRole('button', { name: 'Save desktop settings' })).toBeVisible();
		const form = card.element().querySelector<HTMLFormElement>('form[action="?/save"]')!;
		expect([...new FormData(form)]).toEqual([
			['kind', 'desktop'],
			['price_drops', 'on']
		]);

		await card.getByLabelText('Price drops').click();
		await card.getByLabelText('Failed checks').click();
		expect([...new FormData(form)]).toEqual([
			['kind', 'desktop'],
			['check_failures', 'on']
		]);
	});
});
