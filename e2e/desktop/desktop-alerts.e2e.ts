// The Desktop card in the real app (spec c-4, c-5): real Electron, the real built
// server, and the window's own forms for every card change.
//
// Settings (c-4): unticking Failed checks, or turning the card off, stops those
// notifications, and the choice survives app.quit() and a relaunch on the same
// userData: the startup seed only creates a missing row, never re-enables one. The
// e2e notification seam (src/desktop/notify-seam.ts) records what is shown, so a
// silent check is a record count that did not move. Alerts come from 'Check now'
// on never-checked watches seeded on https://shop.e2e.invalid/...: no adapter
// claims that host, so the check fails before any fetch (r-01), and checkNow awaits
// the alert hook, so the count is final once the page shows the failed check. Each
// 'Check now' uses a fresh watch: a checked one is in its 15-minute cooldown. A
// control check with Failed checks ticked shows the same setup does notify.
//
// Send test (c-5): a launch with notify 'unsupported' must report the failure and
// show nothing. One test uses Electron's real Notification class on each OS and reads
// Notification.isSupported() from main: Linux under xvfb has no D-Bus session, so it
// may be false there. The card's message must agree with it either way, and must
// never be 'unreachable' (the driver caught a throw from the real Electron API).
//
// Accessibility: the Desktop card renders only under Electron, so the web contrast
// and focus specs never see it. Here axe checks the card and a Tab walk reaches each
// of its controls with a visible outline, in both schemes. axe runs in legacy mode:
// its default finishRun opens a blank page, which an Electron context cannot.
import { rmSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { tabWalk, useScheme, type Scheme } from '../a11y.ts';
import {
	dbSnapshot,
	hasNotificationRecorder,
	insertWatches,
	launchDesktop,
	makeTempDir,
	recordedNotifications,
	type DesktopApp,
	type SeedWatch
} from './launch.ts';

const CARD_SELECTOR = '[data-testid="channel-desktop"]';
const DISABLED_STATE = 'Status: Disabled — no alerts are sent here until you enable it.';
const UNSUPPORTED_MESSAGE = 'Not delivered: notifications not supported.';
const CHECK_FAILED = 'Checked just now — the check failed.';
/** The Desktop card's Tab stops while it is enabled, in page order. */
const CARD_STOPS = [
	'Price drops',
	'Failed checks',
	'Save desktop settings',
	'Disable',
	'Send test'
];
/** Over the notifier's 4 s settle: a real notification that never reports 'show' waits it out. */
const REAL_SEND_TIMEOUT_MS = 15_000;

/** Never-checked watches on a .invalid host (r-01), one per 'Check now'. */
const WATCHES = {
	untick: { title: 'E2E Untick Kettle', productId: 'untick' },
	control: { title: 'E2E Control Kettle', productId: 'control' },
	off: { title: 'E2E Off Kettle', productId: 'off' }
} as const;
type WatchName = keyof typeof WATCHES;

const seedRows: SeedWatch[] = Object.entries(WATCHES).map(([id, { title, productId }]) => ({
	id,
	shop: 'e2e',
	productId,
	canonicalUrl: `https://shop.e2e.invalid/item/${productId}`,
	title
}));

const desktopCard = (page: Page) => page.getByTestId('channel-desktop');
const recordCount = async (app: ElectronApplication) => (await recordedNotifications(app)).length;

async function openAlerts(page: Page, origin: string): Promise<Locator> {
	const response = await page.goto(`${origin}/account/alerts`);
	expect(response?.status()).toBe(200);
	const card = desktopCard(page);
	await expect(card).toBeVisible();
	return card;
}

/**
 * Opens the alerts page, sets both ticks through the card's form and saves. Waits for
 * this save's own response (a 'Saved.' left by an earlier save would pass at once),
 * then reloads the page: the stored ticks, not the ones just set, must match.
 */
async function saveTicks(
	page: Page,
	origin: string,
	ticks: { priceDrops: boolean; checkFailures: boolean }
): Promise<Locator> {
	const card = await openAlerts(page, origin);
	await card.getByLabel('Price drops').setChecked(ticks.priceDrops);
	await card.getByLabel('Failed checks').setChecked(ticks.checkFailures);
	const saved = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST' && new URL(response.url()).search === '?/save'
	);
	await card.getByRole('button', { name: 'Save desktop settings' }).click();
	expect((await saved).status()).toBe(200);
	await expect(card.getByRole('status')).toHaveText('Saved.');

	const reloaded = await openAlerts(page, origin);
	await expectTicks(reloaded, ticks);
	return reloaded;
}

async function expectTicks(
	card: Locator,
	{ priceDrops, checkFailures }: { priceDrops: boolean; checkFailures: boolean }
): Promise<void> {
	if (priceDrops) await expect(card.getByLabel('Price drops')).toBeChecked();
	else await expect(card.getByLabel('Price drops')).not.toBeChecked();
	if (checkFailures) await expect(card.getByLabel('Failed checks')).toBeChecked();
	else await expect(card.getByLabel('Failed checks')).not.toBeChecked();
}

/**
 * Clicks 'Check now' on a fresh watch and returns how many notifications it added,
 * read once the page shows the failed check (checkNow awaited the alert hook).
 */
async function checkNow(desktop: DesktopApp, page: Page, name: WatchName): Promise<number> {
	await page.goto(`${desktop.origin}/watches/${name}`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(WATCHES[name].title);
	const before = await recordCount(desktop.app);
	await page.getByRole('button', { name: 'Check now' }).click();
	await expect(page.getByText(CHECK_FAILED)).toBeVisible();
	return (await recordCount(desktop.app)) - before;
}

/** Quits through Electron's app.quit() and waits for the process to exit. */
async function quitThroughApp(desktop: DesktopApp): Promise<void> {
	// Captured first: after the exit, app.process() may throw on Windows.
	const child = desktop.app.process();
	const exited = new Promise<void>((done) => {
		if (child.exitCode !== null || child.signalCode !== null) done();
		else child.once('exit', () => done());
	});
	await desktop.app.evaluate(({ app }) => app.quit());
	await exited;
	await desktop.close();
}

/** axe's WCAG A/AA rules over the Desktop card only; nothing may fail or go unmeasured. */
async function expectCardAxeClean(page: Page, scheme: Scheme): Promise<void> {
	const results = await new AxeBuilder({ page })
		.setLegacyMode(true)
		.include(CARD_SELECTOR)
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	const problems = [
		...results.violations.map((rule) => `${rule.id} violation (${rule.nodes.length})`),
		...results.incomplete.map((rule) => `${rule.id} incomplete (${rule.nodes.length})`)
	];
	expect(problems, `axe on the Desktop card, ${scheme}`).toEqual([]);
	// Not vacuous: axe measured the card's text and named its controls.
	const passed = results.passes.map((rule) => rule.id);
	expect(passed).toEqual(expect.arrayContaining(['color-contrast', 'button-name', 'label']));
}

test.describe.serial('Desktop card settings', () => {
	let desktop: DesktopApp;
	let page: Page;
	let userData: string;

	test.beforeAll(async () => {
		test.setTimeout(60_000);
		userData = makeTempDir('desktop-alerts');
		await insertWatches(userData, seedRows, { migrate: true });
		desktop = await launchDesktop({ userData, notify: 'record' });
		page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
	});
	test.afterAll(async () => {
		await desktop?.close();
		if (userData) rmSync(userData, { recursive: true, force: true });
	});

	test('the Desktop card passes axe and a keyboard focus walk in both schemes', async () => {
		for (const scheme of ['light', 'dark'] as const) {
			await useScheme(page, scheme, `${desktop.origin}/account/alerts`);
			await expect(desktopCard(page)).toBeVisible();
			// Not vacuous: the Electron window really renders in this scheme.
			expect(
				await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
				`emulated ${scheme}`
			).toBe(scheme === 'dark');
			await expectCardAxeClean(page, scheme);

			// tabWalk fails on any stop without a >= 2px, >= 3:1 outline, or any element it missed.
			const stops = await tabWalk(page);
			const inCard = await page.evaluate(
				(selector) => window.__a11yProbe!.visited.map((el) => el.closest(selector) !== null),
				CARD_SELECTOR
			);
			const cardStops = stops.filter((_, i) => inCard[i]);
			expect(
				cardStops.map((stop) => CARD_STOPS.find((name) => stop.label.includes(name))),
				`Desktop card Tab order, ${scheme}`
			).toEqual(CARD_STOPS);
			expect(cardStops.every((stop) => stop.focusVisible)).toBe(true);
		}
	});

	test('unticking Failed checks stops failed-check notifications', async () => {
		await saveTicks(page, desktop.origin, { priceDrops: true, checkFailures: true });
		const card = await saveTicks(page, desktop.origin, { priceDrops: true, checkFailures: false });
		await expect(card.getByTestId('channel-state')).toHaveText('Status: Enabled.');

		expect(await checkNow(desktop, page, 'untick')).toBe(0);
	});

	test('control: with Failed checks ticked the same check notifies', async () => {
		await saveTicks(page, desktop.origin, { priceDrops: true, checkFailures: true });

		expect(await checkNow(desktop, page, 'control')).toBe(1);
		const records = await recordedNotifications(desktop.app);
		expect(records.at(-1)?.title).toContain(WATCHES.control.title);
	});

	test('a disabled card sends nothing, even with Failed checks ticked', async () => {
		const card = await openAlerts(page, desktop.origin);
		await card.getByRole('button', { name: 'Disable' }).click();
		await expect(card.getByTestId('channel-state')).toHaveText(DISABLED_STATE);
		await expect(card.getByRole('button', { name: 'Enable' })).toBeVisible();
		await expectTicks(card, { priceDrops: true, checkFailures: true });

		expect(await checkNow(desktop, page, 'off')).toBe(0);
	});

	test('the choices survive a relaunch, and the seed does not re-enable the card', async () => {
		const card = await saveTicks(page, desktop.origin, { priceDrops: false, checkFailures: true });
		await expect(card.getByTestId('channel-state')).toHaveText(DISABLED_STATE);

		await quitThroughApp(desktop);
		desktop = await launchDesktop({ userData, notify: 'record' });
		page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });

		const relaunched = await openAlerts(page, desktop.origin);
		await expect(relaunched.getByTestId('channel-state')).toHaveText(DISABLED_STATE);
		await expect(relaunched.getByRole('button', { name: 'Enable' })).toBeVisible();
		await expectTicks(relaunched, { priceDrops: false, checkFailures: true });

		const { channels } = await dbSnapshot(userData);
		const rows = channels.filter((row) => row.kind === 'desktop');
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ enabled: false, priceDrops: false, checkFailures: true });
	});
});

test('Send test where notifications are unsupported reports it and shows nothing', async () => {
	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop({ notify: 'unsupported' });
		const page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
		// Not vacuous: the recorder is in place, so a shown notification would be counted.
		expect(await hasNotificationRecorder(desktop.app)).toBe(true);

		const card = await openAlerts(page, desktop.origin);
		await card.getByRole('button', { name: 'Send test' }).click();
		await expect(card.getByRole('alert')).toHaveText(UNSUPPORTED_MESSAGE);
		await expect(card.getByText('Test alert sent.')).toHaveCount(0);
		expect(await recordedNotifications(desktop.app)).toEqual([]);
	} finally {
		await desktop?.close();
	}
});

test("Send test with the real Notification class agrees with the OS's isSupported()", async () => {
	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop();
		const page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
		expect(await hasNotificationRecorder(desktop.app)).toBe(false);
		const supported = await desktop.app.evaluate(({ Notification }) => Notification.isSupported());
		test.info().annotations.push({
			type: 'Notification.isSupported',
			description: `${process.platform}: ${supported}`
		});

		const card = await openAlerts(page, desktop.origin);
		await card.getByRole('button', { name: 'Send test' }).click();
		const outcome = card.getByRole('alert').or(card.getByRole('status'));
		await expect(outcome).toHaveCount(1, { timeout: REAL_SEND_TIMEOUT_MS });
		const message = (await outcome.textContent())?.trim();
		console.log(`[desktop-alerts] ${process.platform} isSupported=${supported}: ${message}`);

		expect(message).not.toBe('Not delivered: unreachable.');
		if (supported) {
			expect(['Test alert sent.', 'Not delivered: refused.']).toContain(message);
		} else {
			expect(message).toBe(UNSUPPORTED_MESSAGE);
		}
	} finally {
		await desktop?.close();
	}
});
