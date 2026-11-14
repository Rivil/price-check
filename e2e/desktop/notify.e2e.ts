// Desktop notifications in the real app (spec c-1, c-2, c-4, c-5): real Electron,
// the real built server, and the e2e notification seam (src/desktop/notify-seam.ts)
// in place of Electron's Notification class. The seam takes the same path on macOS,
// Windows and Linux under xvfb, so delivery and clicks need no notification daemon
// and no OS permission prompt: a shown notification is a record, and clicking one
// emits the 'click' the OS would.
//
// Alerts come from Send test and from 'Check now' on never-checked watches seeded on
// https://shop.e2e.invalid/...: no adapter claims that host, so the check fails
// before any fetch (r-01). Each 'Check now' uses a fresh watch: a checked one is in
// its 15-minute cooldown. The scheduler stays off throughout.
//
// Minimising is asserted on macOS and Windows only: xvfb has no window manager, so on
// Linux minimize() does nothing observable, and window.spec (t-3) owns restore.
import { rmSync } from 'node:fs';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
	clickNotification,
	hasNotificationRecorder,
	insertWatches,
	launchDesktop,
	makeTempDir,
	recordedNotifications,
	type DesktopApp
} from './launch.ts';

const HAS_WM = process.platform !== 'linux';

type WindowState = { visible: boolean; minimized: boolean; url: string };

/** Every live app window as the main process sees it. */
const windowStates = (app: ElectronApplication): Promise<WindowState[]> =>
	app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()
			.filter((window) => !window.isDestroyed())
			.map((window) => ({
				visible: window.isVisible(),
				minimized: window.isMinimized(),
				url: window.webContents.getURL()
			}))
	);

const recordCount = async (app: ElectronApplication) => (await recordedNotifications(app)).length;

/** Waits until exactly one more notification than `before` has been recorded; returns its index. */
async function nextRecord(app: ElectronApplication, before: number): Promise<number> {
	await expect.poll(() => recordCount(app)).toBe(before + 1);
	return before;
}

const desktopCard = (page: Page) => page.getByTestId('channel-desktop');

test.describe.serial('fresh install', () => {
	let desktop: DesktopApp;
	let page: Page;
	let testRecord: number;

	test.beforeAll(async () => {
		test.setTimeout(60_000);
		desktop = await launchDesktop({ notify: 'record' });
		page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
	});
	test.afterAll(async () => {
		await desktop?.close();
	});

	test('fresh install shows the Desktop card on, price drops only, not removable', async () => {
		expect(await hasNotificationRecorder(desktop.app)).toBe(true);
		const res = await page.goto(`${desktop.origin}/account/alerts`);
		expect(res?.status()).toBe(200);

		const card = desktopCard(page);
		await expect(card).toBeVisible();
		await expect(card.getByTestId('channel-state')).toHaveText('Status: Enabled.');
		await expect(card.getByLabel('Price drops')).toBeChecked();
		await expect(card.getByLabel('Failed checks')).not.toBeChecked();
		await expect(card.getByRole('button', { name: 'Remove' })).toHaveCount(0);
		// Control: the buttons the card does have are there.
		await expect(card.getByRole('button', { name: 'Send test' })).toBeVisible();
	});

	test('Send test shows exactly one notification', async () => {
		const before = await recordCount(desktop.app);
		const card = desktopCard(page);
		await card.getByRole('button', { name: 'Send test' }).click();
		await expect(card.getByRole('status')).toHaveText('Test alert sent.');
		testRecord = await nextRecord(desktop.app, before);
		expect(await recordCount(desktop.app)).toBe(before + 1);
	});

	test('clicking it with every window closed opens one window on the alerts page', async () => {
		await desktop.app.evaluate(({ BrowserWindow }) => {
			for (const window of BrowserWindow.getAllWindows()) window.close();
		});
		await expect.poll(() => windowStates(desktop.app)).toEqual([]);

		await clickNotification(desktop.app, testRecord);
		await expect
			.poll(() => windowStates(desktop.app))
			.toEqual([{ visible: true, minimized: false, url: `${desktop.origin}/account/alerts` }]);
	});
});

test.describe.serial('check alerts', () => {
	let desktop: DesktopApp;
	let page: Page;
	let userData: string;
	let kettleRecord: number;

	test.beforeAll(async () => {
		test.setTimeout(60_000);
		userData = makeTempDir('notify');
		// Never checked, so 'Check now' is not in its cooldown; .invalid hosts (r-01).
		await insertWatches(
			userData,
			[
				{
					id: 'w0',
					shop: 'e2e',
					productId: 'kettle',
					canonicalUrl: 'https://shop.e2e.invalid/item/kettle',
					title: 'E2E Kettle'
				},
				{
					id: 'w1',
					shop: 'e2e',
					productId: 'toaster',
					canonicalUrl: 'https://shop.e2e.invalid/item/toaster',
					title: 'E2E Toaster'
				}
			],
			{ migrate: true }
		);
		desktop = await launchDesktop({ userData, notify: 'record' });
		page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
	});
	test.afterAll(async () => {
		await desktop?.close();
		if (userData) rmSync(userData, { recursive: true, force: true });
	});

	test("a failed 'Check now' reaches the desktop as a notification", async () => {
		await page.goto(`${desktop.origin}/account/alerts`);
		const card = desktopCard(page);
		await card.getByLabel('Failed checks').check();
		await card.getByRole('button', { name: 'Save desktop settings' }).click();
		await expect(card.getByRole('status')).toHaveText('Saved.');

		await page.goto(`${desktop.origin}/watches/w0`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('E2E Kettle');
		const before = await recordCount(desktop.app);
		await page.getByRole('button', { name: 'Check now' }).click();
		await expect(page.getByText('Checked just now — the check failed.')).toBeVisible();
		kettleRecord = await nextRecord(desktop.app, before);
		const records = await recordedNotifications(desktop.app);
		expect(records).toHaveLength(before + 1);
		expect(records[kettleRecord].title).toContain('E2E Kettle');
	});

	test('clicking it brings the minimised window up on the watch', async () => {
		await page.goto(`${desktop.origin}/`);
		await expect(page).toHaveURL(`${desktop.origin}/`);
		await desktop.app.evaluate(({ BrowserWindow }) => {
			for (const window of BrowserWindow.getAllWindows()) window.minimize();
		});
		if (HAS_WM) {
			await expect
				.poll(async () => (await windowStates(desktop.app)).map((w) => w.minimized))
				.toEqual([true]);
		}

		await clickNotification(desktop.app, kettleRecord);
		await expect(page).toHaveURL(`${desktop.origin}/watches/w0`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('E2E Kettle');
		await expect
			.poll(async () =>
				(await windowStates(desktop.app)).map(({ visible, minimized, url }) =>
					HAS_WM ? { visible, minimized, url } : { visible, url }
				)
			)
			.toEqual([
				HAS_WM
					? { visible: true, minimized: false, url: `${desktop.origin}/watches/w0` }
					: { visible: true, url: `${desktop.origin}/watches/w0` }
			]);
	});

	test("a deleted watch's notification opens the watchlist", async () => {
		await page.goto(`${desktop.origin}/watches/w1`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('E2E Toaster');
		const before = await recordCount(desktop.app);
		await page.getByRole('button', { name: 'Check now' }).click();
		await expect(page.getByText('Checked just now — the check failed.')).toBeVisible();
		const toasterRecord = await nextRecord(desktop.app, before);
		expect((await recordedNotifications(desktop.app))[toasterRecord].title).toContain(
			'E2E Toaster'
		);

		await page.getByRole('button', { name: 'Delete this watch' }).click();
		await expect(page).toHaveURL(`${desktop.origin}/`);
		// Away from the watchlist, so landing back on it is the click's doing.
		await page.goto(`${desktop.origin}/account/alerts`);

		await clickNotification(desktop.app, toasterRecord);
		await expect(page).toHaveURL(`${desktop.origin}/`);
		await expect(page.getByRole('heading', { name: 'Your watchlist' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'E2E Kettle' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'E2E Toaster' })).toHaveCount(0);
		await expect
			.poll(async () => (await windowStates(desktop.app)).map((w) => [w.visible, w.url]))
			.toEqual([[true, `${desktop.origin}/`]]);
	});
});

test('a launch without the notify option uses the real Notification class', async () => {
	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop();
		expect(await hasNotificationRecorder(desktop.app)).toBe(false);
		await expect(recordedNotifications(desktop.app)).rejects.toThrow(
			/no e2e notification recorder/
		);
	} finally {
		await desktop?.close();
	}
});
