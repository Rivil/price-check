// Launches the packaged desktop app for the packaged e2e specs (05-release c-1, c-2):
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
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import {
	packagedUserDataDir,
	isPackagedPlatform,
	type PackagedPlatform
} from '../../scripts/packaged-app.ts';
import { LOGIN_LAUNCH_ARG, MARKER_FILE_NAME } from '../../src/desktop/login-item.ts';
import { INHERITED_ENV, makeTempDir, treeKillCommand } from '../desktop/launch.ts';

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
	/** Everything the app wrote to stdout and stderr so far. */
	output(): string;
	/** Whether the app's process is still running. */
	running(): boolean;
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
		const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
		await page.waitForURL(APP_URL, { timeout: LAUNCH_TIMEOUT_MS });
		const origin = new URL(page.url()).origin;

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
			output,
			running: () => isRunning(child),
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
