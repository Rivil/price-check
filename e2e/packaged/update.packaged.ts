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
// and does not relaunch; then, once nothing runs from the AppImage's path, a fresh
// copy of A is renamed over it and takes 'Restart to update', and B,
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
//
// A relaunch step that fails says why: every request to the relaunch gives up after
// RESPONSE_MS (a server that accepts and never answers fails the step, not the test's
// timeout), and the failure attaches A's output, which carries electron-updater's
// Install/Executing lines, and what the OS shows while the relaunch still runs: on
// Linux each holder's State, wchan and cmdline, and every process of the AppImage
// (runtime and FUSE daemon included), listening or not, with its exe, ppid, State and
// wchan; on Windows every process of the install path, port or none, and any update
// installer still running. On Linux the failure also names the 127.0.0.1 ports A
// itself listened on just before 'Restart to update': a socket of A's that the
// updater's spawn passed down stays listening with nothing to accept on it.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
	expectedArtefacts,
	isPackagedPlatform,
	replaceExecutable,
	UPDATE_FILE,
	type PackagedPlatform
} from '../../scripts/packaged-app.ts';
import {
	describeHolders,
	describeInstances,
	parseProcesses,
	servingInstance,
	withProcState
} from '../../scripts/process-probe.ts';
import { startUpdateFeed, type UpdateFeed } from '../../scripts/update-feed.ts';
import { insertWatches, makeTempDir, rawRequest, REPO_ROOT } from '../desktop/launch.ts';
import {
	appInstances,
	claimUserData,
	createPackagedRun,
	integrityCheck,
	launchPackaged,
	linuxAppImageProcesses,
	linuxListenPorts,
	packagedExe,
	pollFor,
	stopInstance,
	updaterCheckNow,
	updaterRestart,
	updaterStatus,
	type AppInstance,
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
/** Linux: how long an instance from the previous test may take to be gone before A is placed. */
const IDLE_MS = 30_000;
/** How long the relaunch has to answer one request in full. */
const RESPONSE_MS = 15_000;
/**
 * What a failed relaunch step may spend recording the OS's state, all of it: its
 * probes run side by side, and one still running at the deadline is reported as such.
 * Each relaunch test's timeout adds this whole budget.
 */
const DIAGNOSIS_MS = 60_000;
/** electron-updater's NSIS installer, by process name: price-check-<version>-win-x64.exe. */
const INSTALLER_PROCESS = 'price-check-*-win-x64';

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

/** /proc/<pid>/<file>, or null when unreadable (gone, or withheld): a diagnosis reads what it can. */
function procFile(pid: number, file: string): string | null {
	try {
		return readFileSync(`/proc/${pid}/${file}`, 'utf8');
	} catch {
		return null;
	}
}

/**
 * Every running update installer as Get-Process JSON (empty output when there is
 * none). A wildcard name matching nothing is no error; were ObjectNotFound raised all
 * the same, it is that plain empty answer. Any other failure goes to stderr with exit
 * 1, so the probe rejects with the cmdlet's own message rather than read as 'none'.
 */
const INSTALLERS_SCRIPT = [
	'[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
	'try {',
	`  $rows = @(Get-Process -Name '${INSTALLER_PROCESS}' -ErrorAction Stop)`,
	'} catch {',
	"  if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
	'  $rows = @()',
	'}',
	'if ($rows.Count -gt 0) { $rows | Select-Object Id, Path, StartTime | ConvertTo-Json -Compress }'
].join('\n');

/** Every running update installer (win32), as Get-Process JSON; rejects on a failed probe. */
function windowsInstallersJson(): Promise<string> {
	return new Promise((done, fail) => {
		execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', INSTALLERS_SCRIPT],
			{ encoding: 'utf8', windowsHide: true, timeout: DIAGNOSIS_MS },
			(error, stdout, stderr) => {
				if (error) fail(new Error(`Get-Process ${INSTALLER_PROCESS}: ${error.message}\n${stderr}`));
				else done(stdout);
			}
		);
	});
}

/**
 * One titled section of the OS state: `work`'s text, or a line saying its probe failed
 * or gave no answer by `deadline` (a Date.now() time). Never rejects, and a failed
 * probe never reads as an empty answer.
 */
async function probeSection(
	title: string,
	deadline: number,
	work: () => Promise<string>
): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<string>((done) => {
		timer = setTimeout(
			() => done(`${title}: PROBE GAVE NO ANSWER within ${DIAGNOSIS_MS}ms`),
			Math.max(deadline - Date.now(), 0)
		);
	});
	try {
		return await Promise.race([
			work().then(
				(text) => `${title}:\n${text}`,
				(error: unknown) => `${title}: PROBE FAILED: ${String(error)}`
			),
			late
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * What the OS shows of the app at `exe`, and on win32 of any running update installer.
 * The probes run side by side under one DIAGNOSIS_MS budget, so this settles within it
 * whatever they do.
 */
async function osState(platform: 'win32' | 'linux', exe: string): Promise<string> {
	const deadline = Date.now() + DIAGNOSIS_MS;
	const instances = probeSection(`instances of ${exe}`, deadline, async () => {
		const found = await appInstances(platform, exe);
		if (platform === 'win32') return describeInstances(found);
		return describeInstances(
			found.map((instance) => ({
				...instance,
				processes: instance.processes.map((holder) => withProcState(holder, procFile))
			}))
		);
	});
	if (platform === 'linux') {
		const processes = probeSection(`processes of ${exe}`, deadline, async () => {
			const found = linuxAppImageProcesses(exe);
			if (found.length === 0) return 'none running';
			return found.map((detail) => describeHolders([withProcState(detail, procFile)])).join('\n');
		});
		return (await Promise.all([instances, processes])).join('\n');
	}
	const installers = probeSection(
		`update installers (${INSTALLER_PROCESS})`,
		deadline,
		async () => {
			const rows = parseProcesses(await windowsInstallersJson());
			if (rows.length === 0) return 'none running';
			return rows
				.map(
					({ pid, path, startTime }) =>
						`installer pid ${pid} started ${startTime?.toISOString() ?? 'unknown'} ${path ?? '<path unknown>'}`
				)
				.join('\n');
		}
	);
	return (await Promise.all([instances, installers])).join('\n');
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

	/**
	 * A copy of build A at run.exe (Linux), executable, replacing whatever is there by
	 * rename: a process still executing the old file (the AppImage runtime can outlive
	 * the app) would make an in-place copy fail with ETXTBSY.
	 */
	const placeBuildA = (source: string) => {
		replaceExecutable(source, run.exe);
	};

	/**
	 * Waits up to IDLE_MS until no instance runs from run.exe (Linux): one left over
	 * would hold the single-instance lock the next A needs. Throws naming what still runs.
	 */
	const expectNoInstance = async () => {
		let last: AppInstance[] = [];
		const idle = await pollFor(async () => {
			last = await appInstances('linux', run.exe);
			return last.length === 0 ? true : null;
		}, IDLE_MS);
		if (idle === null) {
			const running = describeInstances(
				last.map((instance) => ({
					...instance,
					processes: instance.processes.map((holder) => withProcState(holder, procFile))
				}))
			);
			throw new Error(`an instance still runs from ${run.exe} after ${IDLE_MS}ms:\n${running}`);
		}
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

	/**
	 * Runs a relaunch step of A. On its failure, before anything stops the relaunch,
	 * attaches A's output and the OS's state (see the header), then rethrows; with
	 * `note`, as an error whose message starts with the note's line.
	 */
	const diagnosed = async (
		app: PackagedApp,
		os: 'win32' | 'linux',
		step: () => Promise<void>,
		note?: () => string
	): Promise<void> => {
		try {
			await step();
		} catch (error) {
			const info = test.info();
			await info.attach('A output', {
				body: app.output() || '<A printed nothing once attached>',
				contentType: 'text/plain'
			});
			// Settles within DIAGNOSIS_MS and never rejects (see osState).
			const state = await osState(os, run.exe);
			await info.attach('OS state', { body: state, contentType: 'text/plain' });
			if (note === undefined) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${note()}\n${message}`, { cause: error });
		}
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
		test.setTimeout(EXIT_MS + WINDOWS_RELAUNCH_MS + RESPONSE_MS + DIAGNOSIS_MS + 60_000);
		const app = current;
		if (!app) throw new Error('A is not running');
		const pidA = app.pid;
		let relaunchedPid: number | undefined;
		try {
			await diagnosed(app, 'win32', async () => {
				const exitedAt = await restartToUpdate(app);

				const relaunched = await pollFor(
					async () => servingInstance(await appInstances('win32', run.exe)),
					WINDOWS_RELAUNCH_MS
				);
				if (relaunched === null || relaunched.port === null) {
					throw new Error(`no relaunch served from ${run.exe} within ${WINDOWS_RELAUNCH_MS}ms`);
				}
				relaunchedPid = relaunched.pid;
				expect(relaunched.pid).not.toBe(pidA);
				expect(relaunched.startTime, 'the relaunch has no StartTime').not.toBeNull();
				// c-6: the new version starts only once the old process has gone.
				expect(
					relaunched.startTime?.getTime(),
					`relaunch started ${relaunched.startTime?.toISOString()}, A exited ${new Date(exitedAt).toISOString()}`
				).toBeGreaterThan(exitedAt);
				const response = await rawRequest(relaunched.port, { timeoutMs: RESPONSE_MS });
				expect(response.status).toBe(200);
				expect(response.body).toContain(WATCH.title);
			});
		} finally {
			if (relaunchedPid !== undefined) await stopInstance('win32', relaunchedPid);
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
		test.setTimeout(
			IDLE_MS + DOWNLOAD_MS + EXIT_MS + LINUX_RELAUNCH_MS + RESPONSE_MS + DIAGNOSIS_MS + 120_000
		);
		if (!feedDir) throw new Error(`${UPDATE_FEED_DIR_ENV} is not set`);
		const buildB = join(feedDir, expectedArtefacts('linux', versionB)[0]);
		await expectNoInstance();
		placeBuildA(packagedExe());

		const app = await launch();
		expect(await app.app.evaluate(({ app: electronApp }) => electronApp.getVersion())).toBe(
			versionA
		);
		await expectDownloaded(app);
		const pidA = app.pid;
		let relaunchedPid: number | undefined;
		/** A's own 127.0.0.1 listen ports just before 'Restart to update' (see the header). */
		let portsA: number[] | undefined;
		const portsNote = () =>
			portsA === undefined
				? `A (pid ${pidA}) listen ports: not recorded`
				: `A (pid ${pidA}) listened on 127.0.0.1 ports: ${portsA.length === 0 ? 'none' : portsA.join(', ')}`;
		try {
			await diagnosed(
				app,
				'linux',
				async () => {
					portsA = await linuxListenPorts(pidA);
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
					relaunchedPid = relaunched.pid;
					expect(relaunched.pid).not.toBe(pidA);
					expect(sha256(run.exe), `the AppImage at ${run.exe} is not B`).toBe(sha256(buildB));
					const response = await rawRequest(relaunched.port, { timeoutMs: RESPONSE_MS });
					expect(response.status).toBe(200);
					expect(response.body).toContain(WATCH.title);
				},
				portsNote
			);
		} finally {
			if (relaunchedPid !== undefined) await stopInstance('linux', relaunchedPid);
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
