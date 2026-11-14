// Running in the background (spec c-5..c-8): real Electron, each test on its own temp
// userData through e2e/desktop/launch.ts.
//
// - Closing the only window keeps the process and its server alive, and the
//   scheduler keeps working: an OS resume (powerMonitor 'resume', emitted in the main
//   process; the machine never sleeps) runs a pass at once that re-checks every
//   watch that came due while "asleep".
// - A second launch on the same userData exits 0 without a server of its own, and
//   the running app shows exactly one window on its original port, also after its
//   window was closed.
// - A '--login-launch' start is tray-only, and a relaunch after it opens the window.
//
// The scheduler runs only in the resume test, in the harness's 'unsupported-only'
// mode: every watch is on a .invalid host no shop adapter claims, so each check
// records an 'unsupported' failure without any network (r-01).
//
// Start at login is only read, never toggled: an unpackaged run registers nothing
// (decision login_start, and login-item.ts's setEnabled is a no-op unpackaged), and a
// test that clicked the tray toggle would risk registering the bare electron binary
// on the machine running it.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { LOGIN_LAUNCH_ARG, MARKER_FILE_NAME } from '../../src/desktop/login-item.ts';
import {
	ageLastChecks as ageLastChecksTo,
	insertWatches,
	launchDesktop,
	makeTempDir,
	rawRequest,
	spawnSecondInstance,
	type DesktopApp,
	type SecondInstance
} from './launch.ts';

/** URLs no shop adapter claims, so a check never fetches (r-01). */
const WATCHES = [
	{
		id: 'e2e-bg-watch-1',
		shop: 'e2e',
		productId: 'bg-1',
		canonicalUrl: 'https://shop.e2e.invalid/item/bg-1',
		title: 'E2E Background Kettle'
	},
	{
		id: 'e2e-bg-watch-2',
		shop: 'e2e',
		productId: 'bg-2',
		canonicalUrl: 'https://shop.e2e.invalid/item/bg-2',
		title: 'E2E Background Toaster'
	}
];

const DAY_MS = 24 * 60 * 60 * 1000;
const RESUME_PASS_TIMEOUT_MS = 10_000;
const SECOND_INSTANCE_EXIT_MS = 15_000;
const WINDOW_TIMEOUT_MS = 10_000;
const LISTENING_LINE = /\[desktop\] listening on/;

type WindowInfo = { visible: boolean; url: string };

/**
 * Every live BrowserWindow in the main process. getAllWindows can still list a window
 * that a close (or the single-instance flow) has already destroyed, and any call on it
 * throws 'Object has been destroyed', so destroyed windows count as gone. The filter
 * and the reads run in one synchronous main-process step, so nothing is destroyed
 * between them.
 */
const windows = (desktop: DesktopApp): Promise<WindowInfo[]> =>
	desktop.app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()
			.filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
			.map((window) => ({
				visible: window.isVisible(),
				url: window.webContents.getURL()
			}))
	);

/** Waits until the app has exactly one window, visible, on its original origin. */
async function expectOneWindow(desktop: DesktopApp): Promise<void> {
	await expect
		.poll(() => windows(desktop), { timeout: WINDOW_TIMEOUT_MS })
		.toEqual([{ visible: true, url: `${desktop.origin}/` }]);
}

/** Closes every window the way a user would (BrowserWindow.close) and waits until none is left. */
async function closeWindows(desktop: DesktopApp): Promise<void> {
	await desktop.app.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) window.close();
		}
	});
	await expect.poll(() => windows(desktop), { timeout: WINDOW_TIMEOUT_MS }).toEqual([]);
}

const isRunning = (desktop: DesktopApp) => {
	const child = desktop.app.process();
	return child.exitCode === null && child.signalCode === null;
};

const health = (desktop: DesktopApp) =>
	rawRequest(desktop.port, { path: '/health', headers: { host: `127.0.0.1:${desktop.port}` } });

/** The failed-check rows /watches/<id> shows for one watch. */
async function failureRows(desktop: DesktopApp, id: string): Promise<number> {
	const page = await rawRequest(desktop.port, {
		path: `/watches/${id}`,
		headers: { host: `127.0.0.1:${desktop.port}` }
	});
	expect(page.status, `/watches/${id}`).toBe(200);
	return page.body.match(/<td class="failure\b[^"]*">Failed: /g)?.length ?? 0;
}

const failureCounts = (desktop: DesktopApp) =>
	Promise.all(WATCHES.map(({ id }) => failureRows(desktop, id)));

// The DB writes below run in a child process (launch.ts), so this one never holds
// the DB open and can remove the temp userData on Windows too.

/** A migrated DB in `userData` holding WATCHES, never checked. */
const seedWatches = (userData: string) => insertWatches(userData, WATCHES, { migrate: true });

/** Moves every watch's last check `ms` into the past. */
const ageLastChecks = (userData: string, ms: number) =>
	ageLastChecksTo(
		userData,
		WATCHES.map(({ id }) => id),
		new Date(Date.now() - ms)
	);

/** Resolves with the second instance's exit, or 'timeout' after SECOND_INSTANCE_EXIT_MS. */
async function exitOf(second: SecondInstance) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<'timeout'>((done) => {
		timer = setTimeout(() => done('timeout'), SECOND_INSTANCE_EXIT_MS);
	});
	const outcome = await Promise.race([second.exit, deadline]);
	clearTimeout(timer);
	return outcome;
}

/** Launches a second instance on `first`'s userData and expects it to exit 0 with no server. */
async function relaunch(first: DesktopApp, args: string[] = []): Promise<void> {
	const second = spawnSecondInstance(first, args);
	try {
		const exit = await exitOf(second);
		expect(exit, `second instance:\n${second.output()}`).toEqual({ code: 0, signal: null });
		expect(second.output()).not.toMatch(LISTENING_LINE);
	} finally {
		await second.kill();
	}
}

test('close keeps serving, checks keep running, resume catches up', async () => {
	const userData = makeTempDir('background-userdata');
	let desktop: DesktopApp | undefined;
	try {
		await seedWatches(userData);
		desktop = await launchDesktop({ userData, scheduler: 'unsupported-only' });
		const running = desktop;
		await expectOneWindow(running);

		// The startup pass checks both never-checked watches: one failure row each.
		await expect
			.poll(() => failureCounts(running), { timeout: RESUME_PASS_TIMEOUT_MS })
			.toEqual([1, 1]);

		// Closing the only window leaves the process and its server running.
		await closeWindows(desktop);
		await new Promise((done) => setTimeout(done, 2_000));
		expect(isRunning(desktop), `after close:\n${desktop.output()}`).toBe(true);
		expect((await health(desktop)).status).toBe(200);

		// Both watches came due "during sleep"; nothing checks them until the resume.
		await ageLastChecks(userData, 2 * DAY_MS);
		expect(await failureCounts(desktop)).toEqual([1, 1]);

		await desktop.app.evaluate(({ powerMonitor }) => {
			powerMonitor.emit('resume');
		});
		await expect
			.poll(() => failureCounts(running), { timeout: RESUME_PASS_TIMEOUT_MS })
			.toEqual([2, 2]);

		// Still windowless and serving after the pass.
		expect(await windows(desktop)).toEqual([]);
		expect((await health(desktop)).status).toBe(200);
	} finally {
		await desktop?.close();
		rmSync(userData, { recursive: true, force: true });
	}
});

test('single instance', async () => {
	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop();
		await expectOneWindow(desktop);

		// With the window open: no second process stays up, and no second window.
		await relaunch(desktop);
		await expectOneWindow(desktop);

		// With the window closed: the relaunch reopens it, on the original port.
		await closeWindows(desktop);
		await relaunch(desktop);
		await expectOneWindow(desktop);

		expect(isRunning(desktop)).toBe(true);
		expect((await health(desktop)).status).toBe(200);
		expect(desktop.output().match(new RegExp(LISTENING_LINE, 'g'))).toHaveLength(1);
	} finally {
		await desktop?.close();
	}
});

test('login launch is tray-only', async () => {
	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop({ args: [LOGIN_LAUNCH_ARG] });
		const { app } = desktop;
		expect((await health(desktop)).status).toBe(200);

		// The lifecycle attaches its 'activate' listener in the same synchronous step as
		// its open-the-window decision, so once it is there that decision has been made.
		await expect
			.poll(() => app.evaluate(({ app }) => app.listenerCount('activate')), {
				timeout: WINDOW_TIMEOUT_MS
			})
			.toBe(1);
		expect(await windows(desktop)).toEqual([]);

		// Registering nothing, unpackaged (decision login_start): only read here, never toggled.
		expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(false);
		if (process.platform === 'linux') {
			const autostart = join(desktop.env.XDG_CONFIG_HOME, 'autostart');
			expect(existsSync(autostart) ? readdirSync(autostart) : []).toEqual([]);
		} else {
			const openAtLogin = await app.evaluate(
				({ app }, { platform, arg }) =>
					app.getLoginItemSettings(platform === 'win32' ? { args: [arg] } : {}).openAtLogin,
				{ platform: process.platform, arg: LOGIN_LAUNCH_ARG }
			);
			expect(openAtLogin).toBe(false);
		}
		expect(existsSync(join(desktop.userData, MARKER_FILE_NAME))).toBe(false);

		// Launching it again, as a user would, opens the window.
		await relaunch(desktop);
		await expectOneWindow(desktop);
	} finally {
		await desktop?.close();
	}
});
