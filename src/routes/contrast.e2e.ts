import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb } from '../lib/server/db/client.ts';
import { user } from '../lib/server/db/schema.ts';
import { contrastRatio, parseColour, parseTokens, schemeTokens } from '../lib/styles/tokens.ts';
import { controlBorderContrast, expectTextContrast, type Scheme } from '../../e2e/a11y.ts';
import {
	E2E_DATABASE_URL,
	SEEDED_ADMIN,
	SEEDED_DESIGN,
	SEEDED_DESIGN_TOPIC_URL,
	SEEDED_LONG_ACCOUNT,
	SEEDED_MEMBER,
	SEEDED_WATCHES,
	signIn,
	submitLogin,
	uniqueEmail,
	type Credentials
} from '../../e2e/accounts.ts';

// c-5 / c-6: every page, in every message state reachable without a live fetch,
// renders the scheme's tokens and passes AA text and control-border contrast.
// r-01: Check now is clicked only on layoutCooldown (refused by the cooldown),
// Send test is clicked only for a topic on https://127.0.0.1:1/ (a closed loopback
// port, refused with no DNS lookup), *.invalid requests are aborted and
// every request the browser makes must stay on localhost or *.invalid.

const tokens = parseTokens(
	readFileSync(new URL('../lib/styles/tokens.css', import.meta.url), 'utf8')
);
const { layoutCooldown, layoutAtTarget, layoutLong, chartFull, cardFresh } = SEEDED_WATCHES;
const schemes: Scheme[] = ['light', 'dark'];

async function longAccountId() {
	const db = createDb(E2E_DATABASE_URL);
	try {
		const [row] = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, SEEDED_LONG_ACCOUNT.email));
		return row.id;
	} finally {
		db.$client.close();
	}
}

/** A fresh context in `scheme`, signed in as `as` (or not), recording every request host. */
async function withPage(
	browser: Browser,
	scheme: Scheme,
	as: Credentials | null,
	run: (page: Page) => Promise<void>
) {
	const context = await browser.newContext({ colorScheme: scheme });
	const hosts = new Set<string>();
	context.on('request', (request) => hosts.add(new URL(request.url()).hostname));
	await context.route(
		(url) => url.hostname.endsWith('.invalid'),
		(route) => route.abort()
	);
	try {
		const page = await context.newPage();
		if (as) await signIn(page, as);
		await run(page);
	} finally {
		await context.close();
	}
	const foreign = [...hosts].filter((h) => h !== 'localhost' && !h.endsWith('.invalid'));
	expect(foreign, 'no live fetch: requests left localhost / *.invalid').toEqual([]);
}

type ColourCheck = { what: string; got: string; token: string };

/** Body and the page's own controls render exactly the scheme's tokens. */
async function expectTokens(page: Page, scheme: Scheme, where: string) {
	const t = schemeTokens(tokens, scheme);
	const computed = await page.evaluate(() => {
		const style = (el: Element | null) => (el ? getComputedStyle(el) : null);
		const body = style(document.body)!;
		const button = style(document.querySelector('main button'));
		const input = style(
			document.querySelector('main input:not([type="checkbox"], [type="radio"], [type="hidden"])')
		);
		return {
			bodyBg: body.backgroundColor,
			bodyText: body.color,
			button: button && { bg: button.backgroundColor, text: button.color },
			input: input && { bg: input.backgroundColor, text: input.color, border: input.borderTopColor }
		};
	});

	const same = (a: string, b: string) => {
		const pa = parseColour(a);
		const pb = parseColour(b);
		return JSON.stringify(pa) === JSON.stringify(pb);
	};
	const check = (checks: ColourCheck[], label: string) => {
		const wrong = checks
			.filter((c) => !same(c.got, t[c.token]))
			.map((c) => `${c.what} is ${c.got}, want ${c.token} ${t[c.token]}`);
		expect(wrong, `${label} ${where} (${scheme})`).toEqual([]);
	};

	check(
		[
			{ what: 'body background', got: computed.bodyBg, token: '--bg' },
			{ what: 'body text', got: computed.bodyText, token: '--text' }
		],
		'scheme'
	);

	expect(computed.button, `${where}: no button in main`).not.toBeNull();
	expect(computed.input, `${where}: no text input in main`).not.toBeNull();
	check(
		[
			{ what: 'button background', got: computed.button!.bg, token: '--accent' },
			{ what: 'button text', got: computed.button!.text, token: '--accent-text' },
			{ what: 'input background', got: computed.input!.bg, token: '--surface' },
			{ what: 'input text', got: computed.input!.text, token: '--text' },
			{ what: 'input border', got: computed.input!.border, token: '--border' }
		],
		'controls use tokens'
	);
}

/** The full check for one page state: tokens, then AA text and control borders. */
async function expectState(page: Page, scheme: Scheme, where: string) {
	await expectTokens(page, scheme, where);
	await test.step(`contrast ${where} ${scheme}`, () => expectTextContrast(page));
	await test.step(`control borders ${where} ${scheme}`, () => controlBorderContrast(page));
}

for (const scheme of schemes) {
	test.describe(scheme, () => {
		test(`login ${scheme}`, async ({ browser }) => {
			await withPage(browser, scheme, null, async (page) => {
				await page.goto('/login');
				await expectState(page, scheme, '/login');

				// Exactly one failed sign-in per scheme, with an email no account has,
				// so the shared per-IP limiter (20 / 15 min) is never reached.
				await submitLogin(page, { email: uniqueEmail('contrast'), password: 'wrong-password-1' });
				const alert = page.getByRole('alert');
				await expect(alert, 'login alert').toHaveText('Incorrect email or password.');
				await expectState(page, scheme, '/login (failed sign-in)');
			});
		});

		test(`watchlist ${scheme}`, async ({ browser }) => {
			await withPage(browser, scheme, SEEDED_DESIGN, async (page) => {
				await page.goto('/');
				const item = (id: string) => page.locator(`li[data-watch-id="${id}"]`);
				await expect(item(layoutLong.id).locator('.failure')).toBeVisible();
				await expect(item(layoutAtTarget.id).getByText('at or below target')).toBeVisible();
				await expectState(page, scheme, '/');

				// Rejected offline (unsupported host) before any request is made.
				await page.getByLabel('Product link').fill('https://www.amazon.com/dp/B000000000');
				await page.getByRole('button', { name: 'Add to watchlist' }).click();
				await expect(page.getByRole('alert')).toHaveText('unsupported URL');
				await expectState(page, scheme, '/ (rejected link)');
			});
		});

		test(`watch page ${scheme}`, async ({ browser }) => {
			await withPage(browser, scheme, SEEDED_DESIGN, async (page) => {
				await page.goto(`/watches/${layoutLong.id}`);
				await expect(page.locator('dd.failure')).toBeVisible();
				await expectState(page, scheme, '/watches/layoutLong');

				await page.goto(`/watches/${layoutCooldown.id}`);
				// Last checked one day after seeding: refused, never a live check (r-01).
				await page.getByRole('button', { name: 'Check now' }).click();
				await expect(page.getByRole('alert')).toBeVisible();
				await expectState(page, scheme, '/watches/layoutCooldown (Check now refused)');

				// Its target is already empty: saving empty again changes nothing.
				await page.goto(`/watches/${layoutCooldown.id}`);
				await page.getByLabel('New target').fill('');
				await page.getByRole('button', { name: 'Save target' }).click();
				await expect(page.getByRole('status')).toHaveText('Target saved.');
				await expectState(page, scheme, '/watches/layoutCooldown (target saved)');
			});
		});

		// axe doesn't measure SVG strokes, so the graphics get their own 3:1 check.
		test(`chart marks contrast ${scheme}`, async ({ browser }) => {
			await withPage(browser, scheme, SEEDED_MEMBER, async (page) => {
				await page.goto(`/watches/${chartFull.id}`);
				const ground = await page
					.locator('.chart')
					.evaluate((el) => getComputedStyle(el).backgroundColor);
				const paints = [
					['line', '.chart .lines .line', 'stroke'],
					['target line', '.chart .lines .target', 'stroke'],
					['failure mark', '.chart .mark .cross', 'stroke'],
					['price mark', '.chart .mark .dot', 'fill']
				] as const;
				for (const [what, selector, paint] of paints) {
					const colour = await page
						.locator(selector)
						.first()
						.evaluate((el, prop) => getComputedStyle(el)[prop], paint);
					expect(contrastRatio(colour, ground), `${what} on the chart`).toBeGreaterThanOrEqual(3);
				}
			});
		});

		test(`tooltip contrast ${scheme}`, async ({ browser }) => {
			await withPage(browser, scheme, SEEDED_MEMBER, async (page) => {
				await page.goto(`/watches/${chartFull.id}`);
				// Focus does nothing until hydration, and there's no signal to wait on. The blur
				// matters: focusing the element that already has focus fires no event.
				const mark = page.locator('.chart .mark').first();
				await expect(async () => {
					await mark.blur();
					await mark.focus();
					await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 200 });
				}).toPass();
				await expectTextContrast(page);
			});
		});

		test(`sparkline contrast ${scheme}`, async ({ browser }) => {
			await withPage(browser, scheme, SEEDED_MEMBER, async (page) => {
				await page.goto('/');
				const card = page.locator(`li[data-watch-id="${cardFresh.id}"]`);
				const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
				for (const selector of ['.sparkline .line', '.sparkline .dot']) {
					const stroke = await card.locator(selector).evaluate((el) => getComputedStyle(el).stroke);
					expect(contrastRatio(stroke, ground), `${selector} on the card`).toBeGreaterThanOrEqual(
						3
					);
				}
			});
		});

		test(`alerts ${scheme}`, async ({ browser }) => {
			await withPage(browser, scheme, SEEDED_DESIGN, async (page) => {
				await page.goto('/account/alerts');
				const topic = page.getByTestId('channel-ntfy').getByLabel('ntfy topic link');
				await expect(topic).toHaveValue(SEEDED_DESIGN_TOPIC_URL);
				// Resubmit the seeded topic unchanged: 'Saved' without changing it.
				await page.getByTestId('channel-ntfy').getByRole('button', { name: 'Save topic' }).click();
				await expect(page.getByTestId('channel-ntfy').getByRole('status')).toHaveText('Saved.');
				await expectState(page, scheme, '/account/alerts (saved)');

				await topic.fill('not a topic link');
				await page.getByTestId('channel-ntfy').getByRole('button', { name: 'Save topic' }).click();
				await expect(page.getByTestId('channel-ntfy').getByRole('alert')).toBeVisible();
				await expectState(page, scheme, '/account/alerts (invalid topic)');

				await page.goto('/account/alerts');
				await expect(
					page.getByTestId('channel-ntfy').locator('code').first(),
					'topic preserved'
				).toHaveText(SEEDED_DESIGN_TOPIC_URL);
				await expect(page.getByTestId('channel-ntfy').getByTestId('channel-state')).toContainText(
					'Enabled'
				);

				// Disabled state; the shared design user's channel is re-enabled whatever happens.
				try {
					await page.getByTestId('channel-ntfy').getByRole('button', { name: 'Disable' }).click();
					await expect(page.getByTestId('channel-ntfy').getByTestId('channel-state')).toContainText(
						'Disabled'
					);
					await expectState(page, scheme, '/account/alerts (disabled)');
				} finally {
					await page.goto('/account/alerts');
					const enable = page.getByTestId('channel-ntfy').getByRole('button', { name: 'Enable' });
					if ((await enable.count()) > 0) {
						await enable.click();
						await expect(
							page.getByTestId('channel-ntfy').getByTestId('channel-state')
						).toContainText('Enabled');
					}
				}
			});

			// The send-test failure message, on the member's refused loopback topic.
			await withPage(browser, scheme, SEEDED_MEMBER, async (page) => {
				await page.goto('/account/alerts');
				try {
					await page
						.getByTestId('channel-ntfy')
						.getByLabel('ntfy topic link')
						.fill('https://127.0.0.1:1/e2e-contrast');
					await page
						.getByTestId('channel-ntfy')
						.getByRole('button', { name: 'Save topic' })
						.click();
					await expect(page.getByTestId('channel-ntfy').getByRole('status')).toHaveText('Saved.');
					await page.getByTestId('channel-ntfy').getByRole('button', { name: 'Send test' }).click();
					await expect(page.getByTestId('channel-ntfy').getByRole('alert')).toHaveText(
						'Not delivered: unreachable.'
					);
					await expectState(page, scheme, '/account/alerts (send test failed)');
				} finally {
					await page.goto('/account/alerts');
					const remove = page.getByTestId('channel-ntfy').getByRole('button', { name: 'Remove' });
					if ((await remove.count()) > 0) {
						await remove.click();
						await expect(page.getByTestId('channel-ntfy').getByRole('status')).toHaveText(
							'Channel removed.'
						);
					}
				}
			});
		});

		test(`account ${scheme}`, async ({ browser }) => {
			await withPage(browser, scheme, SEEDED_DESIGN, async (page) => {
				await page.goto('/account/password');
				await expectState(page, scheme, '/account/password');

				await page.getByLabel('Current password').fill('not-the-current-password');
				await page.getByLabel('New password').fill('a-new-password-that-is-long');
				await page.getByRole('button', { name: 'Change password' }).click();
				await expect(page.getByRole('alert')).toBeVisible();
				await expectState(page, scheme, '/account/password (wrong current password)');
			});
		});

		test(`admin ${scheme}`, async ({ browser }) => {
			await withPage(browser, scheme, SEEDED_ADMIN, async (page) => {
				const create = async (email: string) => {
					await page.getByLabel('Name').fill('Contrast Check');
					await page.getByLabel('Email').fill(email);
					await page.getByLabel('Initial password').fill('contrast-initial-password');
					await page.getByRole('button', { name: 'Create account' }).click();
				};

				await page.goto('/admin/users');
				await expectState(page, scheme, '/admin/users');

				await create(SEEDED_MEMBER.email);
				await expect(page.getByRole('alert')).toBeVisible();
				await expectState(page, scheme, '/admin/users (duplicate email)');

				await page.goto('/admin/users');
				await create(uniqueEmail(`contrast-${scheme}`));
				await expect(page.getByRole('status')).toContainText('Created');
				await expectState(page, scheme, '/admin/users (created)');
			});
		});

		test(`reset ${scheme}`, async ({ browser }) => {
			const path = `/admin/users/${await longAccountId()}/password`;
			await withPage(browser, scheme, SEEDED_ADMIN, async (page) => {
				await page.goto(path);
				await expectState(page, scheme, 'reset page');

				// Too short: refused by validation, so the long account keeps its password.
				await page.getByLabel('New password').fill('short');
				await page.getByRole('button', { name: 'Reset password' }).click();
				await expect(page.getByRole('alert')).toBeVisible();
				await expectState(page, scheme, 'reset page (validation error)');
			});
		});
	});
}
