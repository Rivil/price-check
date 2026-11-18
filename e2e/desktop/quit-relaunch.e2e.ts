// Quit and relaunch (spec c-2, c-9): launch 1 saves an ntfy channel through the
// window's form and gets a watch inserted into its DB, then quits through
// app.quit(). Launch 2 starts the moment launch 1's process has exited (no sleep,
// Windows included) on the same userData, and must reuse the alerts key, open the
// same DB without 'database is locked', show the watch, read the saved topic and
// decrypt it for a test send.
//
// The topic is on a .invalid host (r-01): the send fails at the DNS lookup and is
// reported 'Not delivered', which proves the credential was decrypted and used. The
// watch is inserted straight into the DB, because adding one through the UI would
// fetch a shop. The key is never printed, only compared by hash.
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
	insertWatches,
	KEY_FILE_NAME,
	launchDesktop,
	makeTempDir,
	type DesktopApp
} from './launch.ts';

/** A test-only topic on a .invalid host (r-01): a send to it never leaves this machine. */
const TOPIC = 'https://ntfy.e2e.invalid/e2e-quit-relaunch-topic';

/** A URL no shop adapter claims, so nothing could ever fetch it (r-01). */
const WATCH = {
	id: 'e2e-relaunch-watch',
	shop: 'e2e',
	productId: 'relaunch-1',
	canonicalUrl: 'https://shop.e2e.invalid/item/relaunch-1',
	title: 'E2E Relaunch Kettle'
};

const QUIT_TIMEOUT_MS = 10_000;
const DB_LOCKED = /database is locked/i;

const keyHash = (userData: string) =>
	createHash('sha256')
		.update(readFileSync(join(userData, KEY_FILE_NAME)))
		.digest('hex');

type Exit = { code: number | null; signal: NodeJS.Signals | null } | 'timeout';

/** Quits through Electron's app.quit() and waits up to QUIT_TIMEOUT_MS for the process to end. */
async function quitThroughApp(desktop: DesktopApp): Promise<Exit> {
	const child = desktop.app.process();
	const exit = new Promise<Exit>((done) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			done({ code: child.exitCode, signal: child.signalCode });
		} else {
			child.once('exit', (code, signal) => done({ code, signal }));
		}
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<Exit>((done) => {
		timer = setTimeout(() => done('timeout'), QUIT_TIMEOUT_MS);
	});
	// The quit is asynchronous (before-quit runs the shutdown), so this returns first.
	await desktop.app.evaluate(({ app }) => app.quit());
	const outcome = await Promise.race([exit, deadline]);
	clearTimeout(timer);
	return outcome;
}

async function openAlerts(page: Page, origin: string) {
	const response = await page.goto(`${origin}/account/alerts`);
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible();
}

const ntfyCard = (page: Page) => page.getByTestId('channel-ntfy');

test('quit ends the process and a relaunch reuses the key and data', async () => {
	const userData = makeTempDir('relaunch-userdata');
	const cwd = makeTempDir('relaunch-cwd');
	let first: DesktopApp | undefined;
	let second: DesktopApp | undefined;
	try {
		// Launch 1: the first window is up, then a channel is saved through its form.
		first = await launchDesktop({ userData, cwd });
		const page = await first.app.firstWindow();
		await expect(page.getByText('Nothing on your watchlist yet.')).toBeVisible();
		await openAlerts(page, first.origin);
		await ntfyCard(page).getByLabel('ntfy topic link').fill(TOPIC);
		await ntfyCard(page).getByRole('button', { name: 'Save topic' }).click();
		await expect(ntfyCard(page).getByRole('status')).toHaveText('Saved.');
		const firstKey = keyHash(userData);

		// A watch in launch 1's DB, written while it runs, by a child process that has
		// exited before anything removes the userData (Windows EPERM).
		await insertWatches(userData, [WATCH]);

		// app.quit() ends the process, cleanly, within the deadline.
		const exit = await quitThroughApp(first);
		expect(exit, `quit:\n${first.output()}`).toEqual({ code: 0, signal: null });
		expect(first.output()).not.toMatch(DB_LOCKED);
		await first.close();
		first = undefined;

		// Launch 2, straight after the exit, on the same userData.
		second = await launchDesktop({ userData, cwd });
		expect(keyHash(userData) === firstKey, 'the alerts key changed on relaunch').toBe(true);

		const page2 = await second.app.firstWindow();
		await expect(page2.locator(`li[data-watch-id="${WATCH.id}"]`)).toContainText(WATCH.title);

		// The saved topic is readable, and its test send was attempted (decrypted), not refused.
		await openAlerts(page2, second.origin);
		await expect(ntfyCard(page2).getByTestId('current-topic').locator('code')).toHaveText(TOPIC);
		await ntfyCard(page2).getByRole('button', { name: 'Send test' }).click();
		await expect(ntfyCard(page2).getByRole('alert')).toHaveText(/^Not delivered: /);
		expect(second.output()).not.toMatch(DB_LOCKED);
	} finally {
		await first?.close();
		await second?.close();
		for (const dir of [userData, cwd]) rmSync(dir, { recursive: true, force: true });
	}
});
