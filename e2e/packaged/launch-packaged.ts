// Launches the packaged desktop app for the packaged e2e specs (05-release c-1, c-2,
// and the update test's c-5, c-6, whose OS probes close this file):
// the executable PRICE_CHECK_PACKAGED_EXE names (`node scripts/packaged-app.ts exe
// dist-packaged` prints it), through Playwright's _electron with the Chromium sandbox
// kept on. Run it with `pnpm test:e2e:packaged` after `pnpm package:desktop`.
//
// A packaged app never reads PRICE_CHECK_USER_DATA (src/desktop/app-paths.ts), so a
// run's data lives where a real install keeps it: packagedUserDataDir() of the OS's
// app-data dir. A run points that dir at a temp home where the OS lets it:
//   - darwin: HOME and CFFIXED_USER_HOME (Foundation's home override; HOME alone does
//     not move Electron's appData) name a fresh temp dir;
//   - linux: HOME and XDG_CONFIG_HOME (<temp home>/.config) do the same;
//   - win32: Electron reads APPDATA from the shell folder API, not the environment,
//     so the run uses the real %APPDATA%\price-check.
// Either way the first launch refuses, before any process starts, while that dir
// exists, and dispose() removes it only when this run created it. The smoke checks
// that app.getPath('userData') is the dir the guard looked at.
//
// Login items: the first launch seeds the login-item marker in the new userData, so
// the packaged first run never registers the app with the OS (macOS Login Items, the
// Windows Run key). Should a launch register it anyway (the marker no longer holds
// the seed), the app turns it off again before it quits.
//
// The env is the desktop harness's allowlist (e2e/desktop/launch.ts), never a
// process.env spread, plus the home overrides and SCHEDULER_DISABLED=1: a packaged
// launch must never check a shop (r-01). macOS also gets --use-mock-keychain, so
// Chromium's cookie key never lands in the real login keychain.
//
// The DB is only ever opened by e2e/desktop/seed-child.ts (insertWatches), a process
// that has exited before anything is removed: on Windows a libsql handle in this
// process would keep the file locked (EPERM). On Windows app.process() is Playwright's
// cmd wrapper, so a kill takes the whole tree.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import {
	packagedUserDataDir,
	isPackagedPlatform,
	type PackagedPlatform
} from '../../scripts/packaged-app.ts';
import {
	parseNetTcpListeners,
	parseProcesses,
	parseSsListeners
} from '../../scripts/process-probe.ts';
import { LOGIN_LAUNCH_ARG, MARKER_FILE_NAME } from '../../src/desktop/login-item.ts';
import type { UpdaterHandle, UpdaterStatus } from '../../src/desktop/updater.ts';
import {
	DB_FILE_NAME,
	INHERITED_ENV,
	makeTempDir,
	REPO_ROOT,
	treeKillCommand
} from '../desktop/launch.ts';

export const PACKAGED_EXE_ENV = 'PRICE_CHECK_PACKAGED_EXE';

/** Written as the login-item marker before the first launch: the app never registered. */
export const MARKER_SEED = 'e2e: seeded, never registered\n';

/** Printed by src/desktop/main.ts once its server is up. */
export const LISTENING = /^\[desktop\] listening on (http:\/\/127\.0\.0\.1:(\d+))\s*$/m;

/** The first window's page, once it shows the app's own server. */
const APP_URL = /^http:\/\/127\.0\.0\.1:\d+\//;

const LAUNCH_TIMEOUT_MS = 60_000;
/**
 * Rosetta translates the whole Electron framework on an x86_64 slice's first start,
 * which took over two minutes on an M-series Mac with a cold translation cache (every
 * CI runner's case).
 */
export const X64_LAUNCH_TIMEOUT_MS = 240_000;
const QUIT_TIMEOUT_MS = 15_000;

/** The packaged executable from PRICE_CHECK_PACKAGED_EXE; throws when unset or missing. */
export function packagedExe(env: NodeJS.ProcessEnv = process.env): string {
	const exe = env[PACKAGED_EXE_ENV]?.trim();
	if (!exe) {
		throw new Error(
			`${PACKAGED_EXE_ENV} is not set: package the app, then set it to the output of node scripts/packaged-app.ts exe dist-packaged`
		);
	}
	if (!existsSync(exe)) throw new Error(`${PACKAGED_EXE_ENV} names no file: ${exe}`);
	return exe;
}

function hostPlatform(): PackagedPlatform {
	if (!isPackagedPlatform(process.platform)) {
		throw new Error(`no packaged app for ${process.platform}`);
	}
	return process.platform;
}

/** One smoke run: its home, env and the userData dir every launch in it shares. */
export type PackagedRun = {
	exe: string;
	platform: PackagedPlatform;
	/** The home the app sees: a temp dir on darwin and linux, the real one on win32. */
	home: string;
	/** The launched app's whole environment. */
	env: Record<string, string>;
	/** Extra command-line arguments every launch gets. */
	args: string[];
	/** packagedUserDataDir(platform, env, home): where the app keeps its data. */
	userData: string;
	/** True once the first launch created userData: only then may dispose() remove it. */
	ownsUserData: boolean;
	/** Removes userData if this run created it, and the temp home if it made one. */
	dispose(): void;
};

/** The allowlisted env plus the run's home overrides; never a process.env spread. */
export function packagedEnv(
	platform: PackagedPlatform,
	tempHome: string | null
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of INHERITED_ENV) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	if (tempHome !== null) {
		env.HOME = tempHome;
		if (platform === 'darwin') env.CFFIXED_USER_HOME = tempHome;
		if (platform === 'linux') env.XDG_CONFIG_HOME = join(tempHome, '.config');
	}
	// A packaged launch must never check a shop (r-01).
	env.SCHEDULER_DISABLED = '1';
	return env;
}

/** Sets up a run; nothing is launched and no userData is created yet. */
export function createPackagedRun(exe: string = packagedExe()): PackagedRun {
	const platform = hostPlatform();
	const tempHome = platform === 'win32' ? null : makeTempDir('packaged-home');
	const env = packagedEnv(platform, tempHome);
	const home = tempHome ?? homedir();
	const run: PackagedRun = {
		exe,
		platform,
		home,
		env,
		args: platform === 'darwin' ? ['--use-mock-keychain'] : [],
		userData: packagedUserDataDir(platform, env, home),
		ownsUserData: false,
		dispose() {
			if (run.ownsUserData) rmSync(run.userData, { recursive: true, force: true });
			run.ownsUserData = false;
			if (tempHome !== null) rmSync(tempHome, { recursive: true, force: true });
		}
	};
	return run;
}

/**
 * The first launch's claim on userData: refuses while the dir exists, else creates it
 * with the seeded login-item marker and marks the run as its owner.
 */
export function claimUserData(run: PackagedRun): void {
	if (existsSync(run.userData)) {
		throw new Error(
			`launchPackaged: refused, ${run.userData} already exists (a real install's data, or a run that did not clean up); nothing was launched`
		);
	}
	mkdirSync(run.userData, { recursive: true });
	run.ownsUserData = true;
	writeFileSync(join(run.userData, MARKER_FILE_NAME), MARKER_SEED, 'utf8');
}

export type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

export type PackagedApp = {
	app: ElectronApplication;
	/** The first window, on the app's own server. */
	page: Page;
	/** http://127.0.0.1:<port>, from the first window's URL. */
	origin: string;
	/** Date.now() just before the launch. */
	launchedAt: number;
	/** The Electron main process's pid (on win32 not app.process(), the cmd wrapper's). */
	pid: number;
	/** Everything the app wrote to stdout and stderr so far. */
	output(): string;
	/** Whether the app's process is still running. */
	running(): boolean;
	/** Resolves with the exit status once the app's process has exited by itself. */
	exited(): Promise<ExitStatus>;
	/** Date.now() when this process saw the app's process exit; null while it runs. */
	exitedAt(): number | null;
	/**
	 * Turns the login item off if the app registered one, quits through app.quit() and
	 * resolves with the exit status. Kills the tree and throws past the deadline. Safe to
	 * call twice.
	 */
	quit(): Promise<ExitStatus>;
};

export type LaunchPackagedOptions = {
	/** The first launch of the run: claims userData (see claimUserData). */
	fresh?: boolean;
	/** Playwright's launcher; a spec may swap it to prove a refusal launches nothing. */
	launch?: (typeof _electron)['launch'];
};

function collectOutput(child: ChildProcess): () => string {
	let text = '';
	const append = (chunk: Buffer | string) => {
		text += chunk.toString();
	};
	child.stdout?.on('data', append);
	child.stderr?.on('data', append);
	return () => text;
}

const tail = (text: string) => text.split(/\r?\n/).slice(-40).join('\n');

const isRunning = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

function exitOf(child: ChildProcess): Promise<ExitStatus> {
	if (!isRunning(child)) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
}

/** Kills `child` and everything it started (see treeKillCommand), then waits for its exit. */
async function killTree(child: ChildProcess): Promise<void> {
	if (!isRunning(child)) return;
	const tree = treeKillCommand(child.pid);
	if (tree) {
		await new Promise<void>((done) => {
			// A failed taskkill falls through to the plain kill below.
			execFile(tree.file, tree.args, { windowsHide: true }, () => done());
		});
	}
	if (isRunning(child)) child.kill('SIGKILL');
	await exitOf(child);
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<'timeout'>((done) => {
		timer = setTimeout(() => done('timeout'), ms);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** Whether the app rewrote the seeded marker, i.e. registered itself as a login item. */
function registeredLoginItem(run: PackagedRun): boolean {
	const marker = join(run.userData, MARKER_FILE_NAME);
	return !existsSync(marker) || readFileSync(marker, 'utf8') !== MARKER_SEED;
}

/** Launches the packaged app and waits for its first window on its own server. */
export async function launchPackaged(
	run: PackagedRun,
	{ fresh = false, launch = _electron.launch.bind(_electron) }: LaunchPackagedOptions = {}
): Promise<PackagedApp> {
	// Before anything starts: a refused launch must never reach the app.
	if (fresh) claimUserData(run);
	else if (!run.ownsUserData) {
		throw new Error('launchPackaged: relaunch refused, this run has not claimed userData');
	}

	const launchedAt = Date.now();
	let app: ElectronApplication | undefined;
	try {
		app = await launch({
			executablePath: run.exe,
			args: run.args,
			env: run.env,
			cwd: run.home,
			// Keep Chromium's sandbox on Linux too: Playwright would otherwise add --no-sandbox.
			chromiumSandbox: true,
			timeout: LAUNCH_TIMEOUT_MS
		});
		const child = app.process();
		const output = collectOutput(child);
		let exitedAt: number | null = null;
		child.once('exit', () => {
			exitedAt = Date.now();
		});
		const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
		await page.waitForURL(APP_URL, { timeout: LAUNCH_TIMEOUT_MS });
		const origin = new URL(page.url()).origin;
		const pid = await app.evaluate(() => process.pid);

		const launched = app;
		let quitting: Promise<ExitStatus> | undefined;
		const quit = () => {
			quitting ??= (async () => {
				if (!isRunning(child)) return exitOf(child);
				if (registeredLoginItem(run)) {
					await launched.evaluate(
						({ app: electronApp }, args) => {
							electronApp.setLoginItemSettings({ openAtLogin: false, args });
						},
						run.platform === 'win32' ? [LOGIN_LAUNCH_ARG] : []
					);
				}
				const exit = exitOf(child);
				// The quit is asynchronous (before-quit runs the shutdown), so this usually returns
				// first. It can also reject because the exiting app drops Playwright's connection
				// mid-call, so a rejection is not a failure by itself: the exit decides, and a
				// missed exit reports the rejection with it.
				let quitError: unknown;
				await launched
					.evaluate(({ app: electronApp }) => electronApp.quit())
					.catch((error: unknown) => {
						quitError = error;
					});
				const outcome = await withDeadline(exit, QUIT_TIMEOUT_MS);
				if (outcome === 'timeout') {
					await killTree(child);
					const cause =
						quitError === undefined ? '' : ` (app.quit() call failed: ${String(quitError)})`;
					throw new Error(
						`launchPackaged: the app did not quit within ${QUIT_TIMEOUT_MS}ms${cause}:\n${tail(output())}`
					);
				}
				return outcome;
			})();
			return quitting;
		};
		return {
			app: launched,
			page,
			origin,
			launchedAt,
			pid,
			output,
			running: () => isRunning(child),
			exited: () => exitOf(child),
			exitedAt: () => exitedAt,
			quit
		};
	} catch (error) {
		if (app) await killTree(app.process());
		throw error;
	}
}

export type SpawnedApp = {
	child: ChildProcess;
	/** http://127.0.0.1:<port>, from the listening line. */
	origin: string;
	port: number;
	output(): string;
	/** Ends the app's whole process group: SIGTERM, then SIGKILL past the deadline. */
	kill(): Promise<ExitStatus>;
};

/**
 * darwin: starts the universal app's x86_64 slice under Rosetta with
 * `/usr/bin/arch -x86_64 <exe>`, outside Playwright (which puts --inspect before user
 * arguments, and arch rejects that), and waits for main.ts's listening line. The run
 * must already own its userData; the app runs in its own process group.
 */
export async function spawnX64(run: PackagedRun): Promise<SpawnedApp> {
	if (run.platform !== 'darwin') throw new Error('spawnX64: darwin only');
	if (!run.ownsUserData) throw new Error('spawnX64: refused, this run has not claimed userData');
	const child = spawn('/usr/bin/arch', ['-x86_64', run.exe, ...run.args], {
		cwd: run.home,
		env: run.env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	const output = collectOutput(child);
	const group = child.pid;

	let killing: Promise<ExitStatus> | undefined;
	const kill = () => {
		killing ??= (async () => {
			const exit = exitOf(child);
			const signalGroup = (signal: NodeJS.Signals) => {
				if (group === undefined) return;
				try {
					process.kill(-group, signal);
				} catch (error) {
					// ESRCH: the group is already gone. Anything else (EPERM) left it running.
					if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
				}
			};
			signalGroup('SIGTERM');
			if ((await withDeadline(exit, QUIT_TIMEOUT_MS)) === 'timeout') signalGroup('SIGKILL');
			return exit;
		})();
		return killing;
	};

	try {
		const { origin, port } = await new Promise<{ origin: string; port: number }>((done, fail) => {
			const check = () => {
				const match = LISTENING.exec(output());
				if (!match) return;
				cleanup();
				done({ origin: match[1], port: Number(match[2]) });
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				cleanup();
				fail(
					new Error(
						`spawnX64: the app exited (code ${code}, signal ${signal}) before listening:\n${tail(output())}`
					)
				);
			};
			const onError = (error: Error) => {
				cleanup();
				fail(error);
			};
			const timer = setTimeout(() => {
				cleanup();
				fail(
					new Error(
						`spawnX64: no listening line after ${X64_LAUNCH_TIMEOUT_MS}ms:\n${tail(output())}`
					)
				);
			}, X64_LAUNCH_TIMEOUT_MS);
			const cleanup = () => {
				clearTimeout(timer);
				child.stdout?.off('data', check);
				child.stderr?.off('data', check);
				child.off('exit', onExit);
				child.off('error', onError);
			};
			child.stdout?.on('data', check);
			child.stderr?.on('data', check);
			child.once('exit', onExit);
			child.once('error', onError);
			check();
		});
		return { child, origin, port, output, kill };
	} catch (error) {
		await kill();
		throw error;
	}
}

// ---------------------------------------------------------------------------
// The packaged update test's probes (05-release c-5, c-6). An update's relaunch is
// started by the installer, not Playwright, so the test finds it through the OS:
//   - win32: Get-Process filtered to the install path inside PowerShell (an unfiltered
//     listing carries the Idle process, pid 0, which no app process can be), and
//     Get-NetTCPConnection for the 127.0.0.1 port its main process serves on;
//   - linux: `ss -Hltnp` for 127.0.0.1 listeners, each tied to the AppImage by the
//     APPIMAGE variable the AppImage runtime gave the process.
// scripts/process-probe.ts parses the output.

/** The updater handle main.ts publishes for a packaged app (src/desktop/updater.ts). */
const UPDATER_HANDLE_KEY = 'price-check.updater';

/** The packaged app's updater status; throws when the app published no updater. */
export async function updaterStatus(app: ElectronApplication): Promise<UpdaterStatus> {
	const status = await app.evaluate(
		(_electron, key) =>
			(globalThis as Record<symbol, UpdaterHandle | undefined>)[Symbol.for(key)]?.status(),
		UPDATER_HANDLE_KEY
	);
	if (status === undefined) throw new Error('the packaged app published no updater');
	return status;
}

/** Forces an update check (or joins the one in flight) and waits for it to settle. */
export async function updaterCheckNow(app: ElectronApplication): Promise<void> {
	const published = await app.evaluate(async (_electron, key) => {
		const updater = (globalThis as Record<symbol, UpdaterHandle | undefined>)[Symbol.for(key)];
		await updater?.checkNow();
		return updater !== undefined;
	}, UPDATER_HANDLE_KEY);
	if (!published) throw new Error('the packaged app published no updater');
}

/**
 * The tray's 'Restart to update'. The app starts quitting at once and may drop
 * Playwright's connection mid-call, so a rejected call is not a failure by itself:
 * the caller judges by the process's exit.
 */
export async function updaterRestart(app: ElectronApplication): Promise<unknown> {
	return app
		.evaluate((_electron, key) => {
			const updater = (globalThis as Record<symbol, UpdaterHandle | undefined>)[Symbol.for(key)];
			if (updater === undefined) throw new Error('the packaged app published no updater');
			updater.restart();
		}, UPDATER_HANDLE_KEY)
		.then(
			() => undefined,
			(error: unknown) => error
		);
}

/** One running instance of the packaged app found through the OS. */
export type AppInstance = {
	pid: number;
	/** The 127.0.0.1 port it serves on: only the main process has one. */
	port: number | null;
	startTime: Date | null;
};

const PROBE_TIMEOUT_MS = 60_000;

function runProbe(file: string, args: string[], env?: Record<string, string>): Promise<string> {
	return new Promise((done, fail) => {
		execFile(
			file,
			args,
			{
				encoding: 'utf8',
				windowsHide: true,
				timeout: PROBE_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				// A probe, not the app: it needs the whole env (PowerShell's module path).
				env: env === undefined ? process.env : { ...process.env, ...env }
			},
			(error, stdout, stderr) => {
				if (error) fail(new Error(`${file} ${args.join(' ')}: ${error.message}\n${stderr}`));
				else done(stdout);
			}
		);
	});
}

/** Windows PowerShell 5.1, always present; output forced to UTF-8 for non-ASCII paths. */
function powershell(script: string, env?: Record<string, string>): Promise<string> {
	return runProbe(
		'powershell.exe',
		[
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
		],
		env
	);
}

/** Read by the PowerShell filter: the path never goes through command-line quoting. */
const PROBE_EXE_ENV = 'PRICE_CHECK_PROBE_EXE';

/**
 * Every 127.0.0.1 listener as JSON (empty output when there is none). Get-NetTCPConnection
 * reports 'no listener matched' as an error, category ObjectNotFound (a CimJobException);
 * that one case is a plain empty answer, since the relaunch may not be serving yet. Any
 * other failure (CIM unavailable, access denied) goes to stderr with exit 1, so the probe
 * rejects with the cmdlet's own message rather than read as 'no port' until the poll
 * times out.
 */
const NET_TCP_LISTENERS_SCRIPT = [
	'try {',
	"  $rows = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -ErrorAction Stop)",
	'} catch {',
	"  if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
	'  $rows = @()',
	'}',
	'if ($rows.Count -gt 0) { $rows | Select-Object LocalAddress, LocalPort, OwningProcess, State | ConvertTo-Json -Compress }'
].join('\n');

/** Every process running `exe` (win32), each with its 127.0.0.1 port if it has one. */
export async function windowsAppInstances(exe: string): Promise<AppInstance[]> {
	const processes = parseProcesses(
		await powershell(
			`Get-Process | Where-Object { $_.Path -and ($_.Path -eq $env:${PROBE_EXE_ENV}) } | Select-Object Id, Path, StartTime | ConvertTo-Json -Compress`,
			{ [PROBE_EXE_ENV]: exe }
		)
	);
	if (processes.length === 0) return [];
	const listeners = parseNetTcpListeners(await powershell(NET_TCP_LISTENERS_SCRIPT));
	return processes.map(({ pid, startTime }) => ({
		pid,
		port: listeners.get(pid)?.[0] ?? null,
		startTime
	}));
}

/**
 * The APPIMAGE variable a linux process started with, or null when it has none or
 * has exited since `ss` listed it (ENOENT, or ESRCH mid-read). Any other failure
 * (EACCES) throws: read as 'not ours' it would hide the very instance the test wants.
 */
function appImageOf(pid: number): string | null {
	let environ: string;
	try {
		environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ESRCH') return null;
		throw error;
	}
	const entry = environ.split('\0').find((line) => line.startsWith('APPIMAGE='));
	return entry === undefined ? null : entry.slice('APPIMAGE='.length);
}

/** Every process serving on 127.0.0.1 that the AppImage at `appImage` started (linux). */
export async function linuxAppInstances(appImage: string): Promise<AppInstance[]> {
	const listeners = parseSsListeners(await runProbe('ss', ['-Hltnp']));
	const instances: AppInstance[] = [];
	for (const [pid, ports] of listeners) {
		if (appImageOf(pid) === appImage) instances.push({ pid, port: ports[0], startTime: null });
	}
	return instances;
}

/** Instances of the packaged app at `exe`, found through the OS. */
export function appInstances(platform: PackagedPlatform, exe: string): Promise<AppInstance[]> {
	if (platform === 'win32') return windowsAppInstances(exe);
	if (platform === 'linux') return linuxAppInstances(exe);
	throw new Error(`no process probe for ${platform}`);
}

const POLL_MS = 1_000;

/** Polls `probe` until it returns a value or `ms` has passed; null on timeout. */
export async function pollFor<T>(probe: () => Promise<T | null>, ms: number): Promise<T | null> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) return null;
		await new Promise((done) => setTimeout(done, POLL_MS));
	}
}

const STOP_TIMEOUT_MS = 30_000;

/** True while `pid` exists (EPERM: alive, not ours to signal); throws on any error but ESRCH. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'EPERM') return true;
		if (code === 'ESRCH') return false;
		throw error;
	}
}

/** Sends `signal` to `pid`; false when it was already gone (ESRCH), throws otherwise. */
function signal(pid: number, name: NodeJS.Signals): boolean {
	try {
		process.kill(pid, name);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
		throw error;
	}
}

/**
 * Ends an app instance the installer started (no Playwright handle to quit it):
 * win32 kills the process tree, linux sends SIGTERM (Electron quits on it); SIGKILL
 * follows past half the deadline. Resolves once it is gone; throws if it outlives
 * that, with taskkill's own failure when it had one.
 */
export async function stopInstance(platform: PackagedPlatform, pid: number): Promise<void> {
	let killError: unknown;
	if (platform === 'win32') {
		// Not thrown at once: taskkill also fails for a process that exited first, so
		// whether the process is gone decides, and the error explains a survivor.
		await runProbe('taskkill', ['/PID', String(pid), '/T', '/F']).catch((error: unknown) => {
			killError = error;
		});
	} else {
		signal(pid, 'SIGTERM');
	}
	const gone = () => pollFor(async () => (isAlive(pid) ? null : true), STOP_TIMEOUT_MS / 2);
	if (await gone()) return;
	signal(pid, 'SIGKILL');
	if (!(await gone())) {
		const cause = killError === undefined ? '' : ` (taskkill failed: ${String(killError)})`;
		throw new Error(`stopInstance: pid ${pid} is still running${cause}`);
	}
}

/**
 * The DB's own PRAGMA integrity_check rows ('ok' when sound), read by a short-lived
 * Node process, as e2e/desktop/seed-child.ts reads it: a libsql handle in this
 * process would keep the file locked on Windows until the test process ends. Throws
 * when there is no DB file, rather than check a new empty one.
 */
export function integrityCheck(userData: string): Promise<string[]> {
	const dbFile = join(userData, DB_FILE_NAME);
	if (!existsSync(dbFile)) throw new Error(`integrityCheck: no DB at ${dbFile}`);
	const url = (path: string) => JSON.stringify(pathToFileURL(join(REPO_ROOT, path)).href);
	const script = [
		`const { createDb } = await import(${url('src/lib/server/db/client.ts')});`,
		`const { databaseUrl } = await import(${url('src/desktop/server-env.ts')});`,
		`const db = createDb(databaseUrl(process.argv[1]));`,
		`try {`,
		`  const result = await db.$client.execute('PRAGMA integrity_check');`,
		`  process.stdout.write(JSON.stringify(result.rows.map((row) => String(row[0]))));`,
		`} finally { db.$client.close(); }`
	].join('\n');
	return new Promise((done, fail) => {
		execFile(
			process.execPath,
			['--input-type=module', '-e', script, dbFile],
			{ cwd: REPO_ROOT, windowsHide: true, encoding: 'utf8' },
			(error, stdout, stderr) => {
				if (error) return fail(new Error(`integrityCheck failed: ${error.message}\n${stderr}`));
				let rows: unknown;
				try {
					rows = JSON.parse(stdout);
				} catch (parseError) {
					return fail(
						new Error(`integrityCheck: output is not JSON (${String(parseError)}): ${stdout}`)
					);
				}
				if (!Array.isArray(rows) || !rows.every((row) => typeof row === 'string')) {
					return fail(new Error(`integrityCheck: not a string array: ${stdout}`));
				}
				done(rows);
			}
		);
	});
}
