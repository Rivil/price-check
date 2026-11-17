// The packaged update test (05-release c-5, c-6; decision update_flow), Windows and
// Linux only: macOS updates need two notarised builds and are device UAT. Runs when
// PRICE_CHECK_UPDATE_FEED_DIR names a dir holding build B's artefacts, and skips
// otherwise.
//
//   build A = package.json's version, packaged with --feed-url
//             http://127.0.0.1:UPDATE_FEED_PORT/ (PRICE_CHECK_PACKAGED_EXE: the
//             installed exe on Windows, the AppImage on Linux);
//   build B = the next patch, packaged into PRICE_CHECK_UPDATE_FEED_DIR with its
//             latest*.yml, which scripts/update-feed.ts serves on that port.
//
// A watch is seeded into A's userData (a .invalid host no shop adapter claims,
// r-01), the feed starts over B, and A is launched: it must fetch the update file
// at launch, download B within DOWNLOAD_MS, never restart by itself, and notify once
// per version however often it checks.
//
// Windows: 'Restart to update' hands B to the NSIS installer, which relaunches the
// app. The relaunch is found by install path (Get-Process) and its port
// (Get-NetTCPConnection): it must have started after A's process exited (c-6) and
// serve the seeded watch. Linux: Quit installs B over the AppImage at its own path
// and does not relaunch; then a fresh copy of A takes 'Restart to update', and B,
// started by the updater while A is still exiting, must wait out its predecessor
// and run. Both end with a Playwright relaunch that reports version B and lists the
// watch, an intact DB (PRAGMA integrity_check) and no 'database is locked' in what
// the Playwright launches printed once attached (their startup lines are not
// captured; see PackagedApp.output) up to their quit.
//
// The Linux run launches a copy of A at an unversioned file name: electron-updater
// replaces an AppImage in place only when its name carries no version, and writes
// B beside a versioned one (price-check-0.1.5-… becomes price-check-0.1.6-…).
//
// The tests share one run and run in order: each picks up where the previous left.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
	expectedArtefacts,
	isPackagedPlatform,
	UPDATE_FILE,
	type PackagedPlatform
} from '../../scripts/packaged-app.ts';
import { servingInstance } from '../../scripts/process-probe.ts';
import { startUpdateFeed, type UpdateFeed } from '../../scripts/update-feed.ts';
import { insertWatches, makeTempDir, rawRequest, REPO_ROOT } from '../desktop/launch.ts';
import {
	appInstances,
	claimUserData,
	createPackagedRun,
	integrityCheck,
	launchPackaged,
	packagedExe,
	pollFor,
	stopInstance,
	updaterCheckNow,
	updaterRestart,
	updaterStatus,
	type PackagedApp,
	type PackagedRun
} from './launch-packaged.ts';

const UPDATE_FEED_DIR_ENV = 'PRICE_CHECK_UPDATE_FEED_DIR';

/** A URL no shop adapter claims, so nothing could ever fetch it (r-01). */
const WATCH = {
	id: 'e2e-update-watch',
	shop: 'e2e',
	productId: 'update-1',
	canonicalUrl: 'https://shop.e2e.invalid/item/update-1',
	title: 'E2E Update Kettle'
};

/** The launch-time check must have asked the feed by then. */
const LAUNCH_CHECK_MS = 30_000;
/** From A's launch until status() reports B downloaded. */
const DOWNLOAD_MS = 180_000;
/** How long A must keep running once B is downloaded: it never restarts by itself. */
const NO_FORCED_RESTART_MS = 30_000;
/**
 * After the forced second check: how long status() must keep notified == [B]. The
 * cached B is re-validated (a sha512 over the local file) well inside this.
 */
const NOTIFY_SETTLE_MS = 15_000;
const NOTIFY_POLL_MS = 500;
/** From 'Restart to update' or Quit until A's process has exited. */
const EXIT_MS = 30_000;
/** Windows: from A's exit until the installer's relaunch serves on its port. */
const WINDOWS_RELAUNCH_MS = 180_000;
/** Linux: from A's exit until B, past its predecessor wait, serves on its port. */
const LINUX_RELAUNCH_MS = 30_000;

const feedDir = process.env[UPDATE_FEED_DIR_ENV]?.trim();
const platform: PackagedPlatform | null = isPackagedPlatform(process.platform)
	? process.platform
	: null;

/** MAJOR.MINOR.(PATCH + 1) of a MAJOR.MINOR.PATCH version. */
function nextPatch(version: string): string {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (match === null) throw new Error(`package.json version is not MAJOR.MINOR.PATCH: ${version}`);
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function packageVersion(): string {
	const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
		version?: unknown;
	};
	if (typeof pkg.version !== 'string') throw new Error('package.json has no version');
	return pkg.version;
}

function sha256(file: string): string {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

test.describe.serial('packaged update', () => {
	test.skip(platform === 'darwin', 'macOS updates are device UAT (two notarised builds)');
	test.skip(!feedDir, `${UPDATE_FEED_DIR_ENV} is not set: no build B to update to`);

	const versionA = packageVersion();
	const versionB = nextPatch(versionA);

	let run: PackagedRun;
	let feed: UpdateFeed | undefined;
	/** Linux: where A's AppImage is copied to and run from (see the header). */
	let appImageDir: string | undefined;
	let current: PackagedApp | undefined;
	/**
	 * What each Playwright launch printed once attached (startup lines excluded, see
	 * PackagedApp.output), for the 'database is locked' check.
	 */
	const outputs: (() => string)[] = [];

	const launch = async (fresh = false) => {
		current = await launchPackaged(run, { fresh });
		outputs.push(current.output);
		return current;
	};

	const quitCleanly = async () => {
		const app = current;
		if (!app) throw new Error('no app is running');
		const exit = await app.quit();
		current = undefined;
		expect(exit, `quit:\n${app.output()}`).toEqual({ code: 0, signal: null });
	};

	/** A copy of build A at run.exe (Linux), executable, replacing whatever is there. */
	const placeBuildA = (source: string) => {
		copyFileSync(source, run.exe);
		chmodSync(run.exe, 0o755);
	};

	/** Waits for A to download B, as status() reports it. */
	const expectDownloaded = async (app: PackagedApp) => {
		const deadline = app.launchedAt + DOWNLOAD_MS;
		await expect
			.poll(() => updaterStatus(app.app).then(({ state, version }) => ({ state, version })), {
				message: `update ${versionB} downloaded within ${DOWNLOAD_MS}ms`,
				timeout: Math.max(deadline - Date.now(), 1)
			})
			.toEqual({ state: 'downloaded', version: versionB });
	};

	/** 'Restart to update' on `app`; resolves with the time A's process was seen exiting. */
	const restartToUpdate = async (app: PackagedApp): Promise<number> => {
		const callError = await updaterRestart(app.app);
		const exit = await Promise.race([
			app.exited(),
			new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), EXIT_MS))
		]);
		const exitedAt = app.exitedAt();
		if (exit === 'timeout' || exitedAt === null) {
			throw new Error(
				`A did not exit within ${EXIT_MS}ms of 'Restart to update'${callError === undefined ? '' : ` (call failed: ${String(callError)})`}:\n${app.output()}`
			);
		}
		current = undefined;
		return exitedAt;
	};

	test.beforeAll(async () => {
		if (!feedDir || platform === null) return;
		const updateFile = join(feedDir, UPDATE_FILE[platform]);
		const feedVersion = /^version:\s*(\S+)\s*$/m.exec(readFileSync(updateFile, 'utf8'))?.[1];
		if (feedVersion !== versionB) {
			throw new Error(`${updateFile} serves version ${feedVersion}, expected B = ${versionB}`);
		}
		run = createPackagedRun();
		if (platform === 'linux') {
			appImageDir = makeTempDir('update-appimage');
			run.exe = join(appImageDir, 'price-check.AppImage');
			placeBuildA(packagedExe());
		}
		feed = await startUpdateFeed({ dir: feedDir });
	});

	test.afterAll(async () => {
		try {
			await current?.quit();
		} finally {
			try {
				// An instance the installer started has no Playwright handle: end it before
				// userData goes (on Windows its open DB would make the removal fail).
				if (run && platform !== null && platform !== 'darwin') {
					for (const { pid } of await appInstances(platform, run.exe)) {
						await stopInstance(platform, pid);
					}
				}
			} finally {
				await feed?.close();
				run?.dispose();
				if (appImageDir) rmSync(appImageDir, { recursive: true, force: true });
			}
		}
	});

	test('check at launch', async () => {
		if (!feed) throw new Error('the feed did not start');
		// Seeded before A ever runs, into the userData the run claims for it.
		claimUserData(run);
		await insertWatches(run.userData, [WATCH], { migrate: true });

		const app = await launch();
		expect(await app.app.evaluate(({ app: electronApp }) => electronApp.getVersion())).toBe(
			versionA
		);
		const updatePath = `/${UPDATE_FILE[platform as PackagedPlatform]}`;
		const started = feed;
		await expect
			.poll(() => started.requests(), {
				message: `A fetched ${updatePath} at launch`,
				timeout: Math.max(app.launchedAt + LAUNCH_CHECK_MS - Date.now(), 1)
			})
			.toContain(updatePath);
	});

	test('downloaded, never a forced restart', async () => {
		test.setTimeout(DOWNLOAD_MS + NO_FORCED_RESTART_MS + 60_000);
		const app = current;
		if (!app) throw new Error('A is not running');
		await expectDownloaded(app);

		const exit = await Promise.race([
			app.exited(),
			new Promise<'running'>((done) => setTimeout(() => done('running'), NO_FORCED_RESTART_MS))
		]);
		expect(exit, `A exited on its own after the download:\n${app.output()}`).toBe('running');
	});

	test('one notification per version', async () => {
		const app = current;
		if (!app) throw new Error('A is not running');
		const before = feed?.requests().length ?? 0;
		await updaterCheckNow(app.app);
		// The second check reached the feed, so its result is what status() reports.
		expect(feed?.requests().length ?? 0).toBeGreaterThan(before);
		// checkNow settles with checkForUpdates, before electron-updater has re-validated
		// the cached B and emitted update-downloaded again. That second emit has no
		// observable marker, so status() is read throughout a settle window: a duplicate
		// notification would show up in any read after it lands.
		const settleUntil = Date.now() + NOTIFY_SETTLE_MS;
		for (;;) {
			const status = await updaterStatus(app.app);
			expect(status.notified).toEqual([versionB]);
			expect(status).toMatchObject({ state: 'downloaded', version: versionB });
			if (Date.now() >= settleUntil) break;
			await new Promise((done) => setTimeout(done, NOTIFY_POLL_MS));
		}
	});

	test('relaunch after exit', async () => {
		test.skip(platform !== 'win32', 'the NSIS installer relaunch is Windows only');
		test.setTimeout(EXIT_MS + WINDOWS_RELAUNCH_MS + 60_000);
		const app = current;
		if (!app) throw new Error('A is not running');
		const pidA = app.pid;
		const exitedAt = await restartToUpdate(app);

		const relaunched = await pollFor(
			async () => servingInstance(await appInstances('win32', run.exe)),
			WINDOWS_RELAUNCH_MS
		);
		if (relaunched === null || relaunched.port === null) {
			throw new Error(`no relaunch served from ${run.exe} within ${WINDOWS_RELAUNCH_MS}ms`);
		}
		try {
			expect(relaunched.pid).not.toBe(pidA);
			expect(relaunched.startTime, 'the relaunch has no StartTime').not.toBeNull();
			// c-6: the new version starts only once the old process has gone.
			expect(
				relaunched.startTime?.getTime(),
				`relaunch started ${relaunched.startTime?.toISOString()}, A exited ${new Date(exitedAt).toISOString()}`
			).toBeGreaterThan(exitedAt);
			const response = await rawRequest(relaunched.port);
			expect(response.status).toBe(200);
			expect(response.body).toContain(WATCH.title);
		} finally {
			await stopInstance('win32', relaunched.pid);
		}
	});

	test('quit installs in place', async () => {
		test.skip(platform !== 'linux', 'the AppImage update is Linux only');
		if (!feedDir) throw new Error(`${UPDATE_FEED_DIR_ENV} is not set`);
		const buildB = join(feedDir, expectedArtefacts('linux', versionB)[0]);
		// Quit (the tray's Quit, app.quit()) installs the downloaded update, no relaunch.
		await quitCleanly();
		expect(existsSync(run.exe), `no AppImage left at ${run.exe}`).toBe(true);
		expect(sha256(run.exe), `the AppImage at ${run.exe} is not B`).toBe(sha256(buildB));

		const relaunched = await launch();
		expect(await relaunched.app.evaluate(({ app: electronApp }) => electronApp.getVersion())).toBe(
			versionB
		);
		await expect(relaunched.page.locator(`li[data-watch-id="${WATCH.id}"]`)).toContainText(
			WATCH.title
		);
		await quitCleanly();
	});

	test('restart through the predecessor wait', async () => {
		test.skip(platform !== 'linux', 'the AppImage update is Linux only');
		test.setTimeout(DOWNLOAD_MS + EXIT_MS + LINUX_RELAUNCH_MS + 120_000);
		if (!feedDir) throw new Error(`${UPDATE_FEED_DIR_ENV} is not set`);
		const buildB = join(feedDir, expectedArtefacts('linux', versionB)[0]);
		placeBuildA(packagedExe());

		const app = await launch();
		expect(await app.app.evaluate(({ app: electronApp }) => electronApp.getVersion())).toBe(
			versionA
		);
		await expectDownloaded(app);
		const pidA = app.pid;
		// B is started while A is still on its way out, so it first loses the lock.
		const exitedAt = await restartToUpdate(app);

		const relaunched = await pollFor(
			async () => servingInstance(await appInstances('linux', run.exe)),
			Math.max(exitedAt + LINUX_RELAUNCH_MS - Date.now(), 1)
		);
		if (relaunched === null || relaunched.port === null) {
			throw new Error(
				`no B process served from ${run.exe} within ${LINUX_RELAUNCH_MS}ms of A's exit (the relaunch lost the single-instance lock?)`
			);
		}
		try {
			expect(relaunched.pid).not.toBe(pidA);
			expect(sha256(run.exe), `the AppImage at ${run.exe} is not B`).toBe(sha256(buildB));
			const response = await rawRequest(relaunched.port);
			expect(response.status).toBe(200);
			expect(response.body).toContain(WATCH.title);
		} finally {
			await stopInstance('linux', relaunched.pid);
		}
	});

	test('relaunch is B with its data', async () => {
		const app = await launch();
		expect(await app.app.evaluate(({ app: electronApp }) => electronApp.getVersion())).toBe(
			versionB
		);
		await expect(app.page.locator(`li[data-watch-id="${WATCH.id}"]`)).toContainText(WATCH.title);
		await quitCleanly();

		expect(await integrityCheck(run.userData)).toEqual(['ok']);
		for (const output of outputs) expect(output()).not.toMatch(/database is locked/i);
	});
});
