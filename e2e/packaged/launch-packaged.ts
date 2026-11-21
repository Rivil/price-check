// Launches the packaged desktop app for the packaged e2e specs (05-release c-1, c-2,
// and the update test's c-5, c-6, whose OS probes close this file):
// the executable PRICE_CHECK_PACKAGED_EXE names (`node scripts/packaged-app.ts exe
// dist-packaged` prints it), spawned directly with the Chromium sandbox kept on. Run it
// with `pnpm test:e2e:packaged` after `pnpm package:desktop`.
//
// No Node inspector (06-remediate-security c-22; decision cli_inspect_fuse): the
// shipped app has the CLI inspect fuse off, so no launch here passes --inspect and
// nothing evaluates code in main. Two channels take its place:
//   - the window: every launch adds --remote-debugging-port=0, Chromium writes the port
//     it picked to DevToolsActivePort in userData, and Playwright's
//     chromium.connectOverCDP attaches to the app's window through it;
//   - main: PRICE_CHECK_E2E_CONTROL_DIR names a fresh dir per launch, where main's
//     test-only control channel (src/desktop/e2e-control.ts) answers a fixed set of
//     commands dropped as files (ControlClient). A launch finds the app through it: it
//     waits for the <pid> dir main's channel creates and for main's reply to 'pid'. An
//     app whose main never wires the channel fails every launch there.
// A version an update starts inherits the variable at the hand-over (main.ts
// withControlHandOver), so it answers in the dir of the launch it replaced.
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
// Chromium's cookie key and the wrapped alerts key never land in the real login
// keychain.
//
// The DB is only ever opened by e2e/desktop/seed-child.ts (insertWatches), a process
// that has exited before anything is removed: on Windows a libsql handle in this
// process would keep the file locked (EPERM). A kill takes the app's whole tree on
// Windows (taskkill /T), where Chromium's helpers would otherwise outlive it.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import {
	packagedUserDataDir,
	isPackagedPlatform,
	type PackagedPlatform
} from '../../scripts/packaged-app.ts';
import {
	appImageProcesses,
	instancesByPort,
	linuxAppHolders,
	parseNetTcpListeners,
	parseProcesses,
	parseProcStatusPpid,
	parseSsListeners,
	type LinuxProc,
	type ProcessDetail
} from '../../scripts/process-probe.ts';
import { E2E_CONTROL_ENV, type AppGetResult, type E2eInfo } from '../../src/desktop/e2e-control.ts';
import { MARKER_FILE_NAME } from '../../src/desktop/login-item.ts';
import type { UpdaterStatus } from '../../src/desktop/updater.ts';
import {
	DB_FILE_NAME,
	INHERITED_ENV,
	makeTempDir,
	REPO_ROOT,
	treeKillCommand
} from '../desktop/launch.ts';

export const PACKAGED_EXE_ENV = 'PRICE_CHECK_PACKAGED_EXE';

/**
 * Test-only, read by src/desktop/main.ts (its OUTPUT_CAPTURE_ENV; main.spec pins the
 * two together): an absolute file each app process appends its output records to, the
 * version an update starts included (scripts/process-probe.ts parses them).
 */
export const OUTPUT_CAPTURE_ENV = 'PRICE_CHECK_E2E_OUTPUT_CAPTURE';

/** Written as the login-item marker before the first launch: the app never registered. */
export const MARKER_SEED = 'e2e: seeded, never registered\n';

/** Printed by src/desktop/main.ts once its server is up. */
export const LISTENING = /^\[desktop\] listening on (http:\/\/127\.0\.0\.1:(\d+))\s*$/m;

/** Every launchPackaged launch's renderer debugging switch: Chromium picks the port. */
export const REMOTE_DEBUGGING_ARG = '--remote-debugging-port=0';

/** Where Chromium writes the port REMOTE_DEBUGGING_ARG picked, in userData. */
const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';

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
	/** A temp dir holding each launch's control dir (E2E_CONTROL_ENV). */
	controlRoot: string;
	/** True once the first launch created userData: only then may dispose() remove it. */
	ownsUserData: boolean;
	/** Removes userData if this run created it, the control dirs, and any temp home. */
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
	const controlRoot = makeTempDir('packaged-control');
	const env = packagedEnv(platform, tempHome);
	const home = tempHome ?? homedir();
	const run: PackagedRun = {
		exe,
		platform,
		home,
		env,
		args: platform === 'darwin' ? ['--use-mock-keychain'] : [],
		userData: packagedUserDataDir(platform, env, home),
		controlRoot,
		ownsUserData: false,
		dispose() {
			if (run.ownsUserData) rmSync(run.userData, { recursive: true, force: true });
			run.ownsUserData = false;
			rmSync(controlRoot, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// The control channel's client side (src/desktop/e2e-control.ts holds the layout).

/** A command main's control channel answers, with exactly its fields. */
export type ControlRequest =
	| {
			cmd:
				| 'pid'
				| 'info'
				| 'quit'
				| 'loginItemOff'
				| 'updaterStatus'
				| 'updaterCheckNow'
				| 'updaterRestart'
				| 'keyBackend';
	  }
	| { cmd: 'appGet'; path: string };

/** How long a command may go unanswered, unless the call says otherwise. */
const CONTROL_REPLY_MS = 30_000;
/** How often a reply, a launch's <pid> dir or DevToolsActivePort is looked for. */
const LAUNCH_POLL_MS = 50;

export type ControlClient = {
	/** The main process answering: its <pid> dir's name, confirmed by its own reply. */
	readonly pid: number;
	/** Sends `request`; resolves with its result, rejects on an error reply or none in time. */
	send(request: ControlRequest, timeoutMs?: number): Promise<unknown>;
	info(): Promise<E2eInfo>;
	/** A GET of the app's own server with its session cookie, which never leaves main. */
	appGet(path: string, timeoutMs?: number): Promise<AppGetResult>;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A client for main process `pid`'s channel under `dir`. Main reads a request as soon
 * as it appears, so each one is written to a temp name main ignores, then renamed to
 * req-<n>.json; main's res-<n>.json arrives the same way, and is read and removed.
 */
export function controlClient(dir: string, pid: number): ControlClient {
	const own = join(dir, String(pid));
	let sent = 0;
	const send = async (request: ControlRequest, timeoutMs = CONTROL_REPLY_MS) => {
		sent += 1;
		const n = sent;
		mkdirSync(own, { recursive: true });
		const temp = join(own, `.req-${n}.json.tmp`);
		writeFileSync(temp, JSON.stringify(request));
		renameSync(temp, join(own, `req-${n}.json`));
		const reply = join(own, `res-${n}.json`);
		const deadline = Date.now() + timeoutMs;
		while (!existsSync(reply)) {
			if (Date.now() >= deadline) {
				throw new Error(
					`control ${request.cmd}: no reply from pid ${pid} within ${timeoutMs}ms (${own})`
				);
			}
			await sleep(LAUNCH_POLL_MS);
		}
		const text = readFileSync(reply, 'utf8');
		rmSync(reply, { force: true });
		const response = JSON.parse(text) as
			{ ok: true; result: unknown } | { ok: false; error: string };
		if (!response.ok) throw new Error(`control ${request.cmd}: ${response.error}`);
		return response.result;
	};
	return {
		pid,
		send,
		info: async () => (await send({ cmd: 'info' })) as E2eInfo,
		appGet: async (path, timeoutMs) =>
			(await send({ cmd: 'appGet', path }, timeoutMs)) as AppGetResult
	};
}

/** The <pid> dirs main processes have opened under a control dir. */
export function controlPids(dir: string): string[] {
	return existsSync(dir) ? readdirSync(dir).filter((name) => /^\d+$/.test(name)) : [];
}

// ---------------------------------------------------------------------------
// Launching.

export type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

export type PackagedApp = {
	/** Main's control channel (see the header). */
	control: ControlClient;
	/** This launch's control dir: a version an update starts answers in it too. */
	controlDir: string;
	/** The CDP connection to the app's renderer. */
	browser: Browser;
	/** The first window, on the app's own server. */
	page: Page;
	/** http://127.0.0.1:<port>, from the first window's URL. */
	origin: string;
	/** The port Chromium's remote debugging listens on (DevToolsActivePort). */
	devtoolsPort: number;
	/** The command-line arguments the app was spawned with. */
	args: readonly string[];
	/** Date.now() just before the launch. */
	launchedAt: number;
	/** The Electron main process's pid, as main itself reports it. */
	pid: number;
	/** Everything the app wrote to stdout and stderr since it was spawned. */
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

/** How a launch starts its process: node's spawn, or a spec's stand-in. */
export type SpawnApp = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export type LaunchPackagedOptions = {
	/** The first launch of the run: claims userData (see claimUserData). */
	fresh?: boolean;
	/** Starts the process; a spec may swap it to prove a refusal launches nothing. */
	spawn?: SpawnApp;
	/** Added to run.env for this launch only (OUTPUT_CAPTURE_ENV). */
	env?: Record<string, string>;
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
	// A process that never started (spawn's 'error') has nothing to kill, and no exit.
	if (child.pid === undefined || !isRunning(child)) return;
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

/** A spawned app process, watched for a failed start or an early exit. */
type Started = {
	output(): string;
	/** Why waiting on the process is pointless (it failed to start, or exited); else null. */
	ended(): Error | null;
};

function watchStart(child: ChildProcess, output: () => string): Started {
	let spawnError: Error | null = null;
	child.once('error', (error) => {
		spawnError = error;
	});
	return {
		output,
		ended() {
			if (spawnError !== null) return spawnError;
			if (isRunning(child)) return null;
			return new Error(
				`the app exited (code ${child.exitCode}, signal ${child.signalCode}):\n${tail(output())}`
			);
		}
	};
}

/**
 * Polls `probe` every LAUNCH_POLL_MS until it gives a value; rejects, naming `what`,
 * past `deadline` (a Date.now() time) or as soon as the started process has ended.
 */
async function untilStarted<T>(
	started: Started,
	what: () => string,
	deadline: number,
	probe: () => T | null
): Promise<T> {
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		const ended = started.ended();
		if (ended) throw new Error(`${what()}: ${ended.message}`, { cause: ended });
		if (Date.now() >= deadline) {
			throw new Error(`${what()}: not within the launch timeout:\n${tail(started.output())}`);
		}
		await sleep(LAUNCH_POLL_MS);
	}
}

/**
 * The control channel of the app started with the fresh control dir `dir`: the one
 * <pid> dir its main creates, once main has answered 'pid' with that pid.
 */
async function awaitControl(
	started: Started,
	dir: string,
	deadline: number
): Promise<ControlClient> {
	const pid = await untilStarted(
		started,
		() => `no control channel opened in ${dir}`,
		deadline,
		() => {
			const pids = controlPids(dir);
			if (pids.length > 1) throw new Error(`several processes opened ${dir}: ${pids.join(', ')}`);
			return pids.length === 1 ? Number(pids[0]) : null;
		}
	);
	const control = controlClient(dir, pid);
	const reply = await control.send({ cmd: 'pid' }, Math.max(deadline - Date.now(), 1));
	if (reply !== pid) throw new Error(`control: pid dir ${pid} answered pid ${String(reply)}`);
	return control;
}

/** The port in userData's DevToolsActivePort once Chromium has written it whole; else null. */
function devtoolsPortIn(userData: string): number | null {
	const file = join(userData, DEVTOOLS_PORT_FILE);
	if (!existsSync(file)) return null;
	// Line 1 is the port, line 2 the browser target: both there means the write is done.
	const [port = '', target = ''] = readFileSync(file, 'utf8').split(/\r?\n/);
	if (!/^\d+$/.test(port.trim()) || !target.startsWith('/devtools/browser/')) return null;
	return Number(port.trim());
}

/** The app's window, once it shows the app's own server. */
function appWindow(started: Started, browser: Browser, deadline: number): Promise<Page> {
	const pages = () => browser.contexts().flatMap((context) => context.pages());
	return untilStarted(
		started,
		() => `no window on the app's server (pages: ${JSON.stringify(pages().map((p) => p.url()))})`,
		deadline,
		() => pages().find((page) => APP_URL.test(page.url())) ?? null
	);
}

/** Launches the packaged app and waits for its control channel and its first window. */
export async function launchPackaged(
	run: PackagedRun,
	{ fresh = false, spawn: spawnApp = spawn, env = {} }: LaunchPackagedOptions = {}
): Promise<PackagedApp> {
	// Before anything starts: a refused launch must never reach the app.
	if (fresh) claimUserData(run);
	else if (!run.ownsUserData) {
		throw new Error('launchPackaged: relaunch refused, this run has not claimed userData');
	}

	const controlDir = mkdtempSync(join(run.controlRoot, 'launch-'));
	const args = [...run.args, REMOTE_DEBUGGING_ARG];
	// One left by the previous launch would name a port nothing listens on any more.
	rmSync(join(run.userData, DEVTOOLS_PORT_FILE), { force: true });
	const launchedAt = Date.now();
	const deadline = launchedAt + LAUNCH_TIMEOUT_MS;
	const child = spawnApp(run.exe, args, {
		cwd: run.home,
		env: { ...run.env, ...env, [E2E_CONTROL_ENV]: controlDir },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const output = collectOutput(child);
	const started = watchStart(child, output);
	let exitedAt: number | null = null;
	child.once('exit', () => {
		exitedAt = Date.now();
	});
	let browser: Browser | undefined;
	try {
		const control = await awaitControl(started, controlDir, deadline);
		const devtoolsPort = await untilStarted(
			started,
			() => `no ${DEVTOOLS_PORT_FILE} in ${run.userData}`,
			deadline,
			() => devtoolsPortIn(run.userData)
		);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`, {
			timeout: Math.max(deadline - Date.now(), 1),
			// The app's own session as it is: no download or emulation overrides on it.
			noDefaults: true
		});
		const connected = browser;
		const page = await appWindow(started, connected, deadline);
		const origin = new URL(page.url()).origin;

		let quitting: Promise<ExitStatus> | undefined;
		const quit = () => {
			quitting ??= (async () => {
				try {
					if (!isRunning(child)) return await exitOf(child);
					let loginItemError: unknown;
					if (registeredLoginItem(run)) {
						await control.send({ cmd: 'loginItemOff' }).catch((error: unknown) => {
							loginItemError = error;
						});
					}
					const exit = exitOf(child);
					// Main writes the reply before it starts quitting, so a rejection means the
					// channel is gone, not a failure by itself: the exit decides, and a missed exit
					// reports the rejection with it.
					let quitError: unknown;
					await control.send({ cmd: 'quit' }, QUIT_TIMEOUT_MS).catch((error: unknown) => {
						quitError = error;
					});
					const outcome = await withDeadline(exit, QUIT_TIMEOUT_MS);
					if (outcome === 'timeout') {
						await killTree(child);
						const cause =
							quitError === undefined ? '' : ` (quit command failed: ${String(quitError)})`;
						throw new Error(
							`launchPackaged: the app did not quit within ${QUIT_TIMEOUT_MS}ms${cause}:\n${tail(output())}`
						);
					}
					if (loginItemError !== undefined) {
						throw new Error(
							`launchPackaged: the app registered a login item, and turning it off failed: ${String(loginItemError)}`
						);
					}
					return outcome;
				} finally {
					// The app has exited by now: this only drops Playwright's end of the connection.
					await connected.close().catch(() => undefined);
				}
			})();
			return quitting;
		};
		return {
			control,
			controlDir,
			browser: connected,
			page,
			origin,
			devtoolsPort,
			args,
			launchedAt,
			pid: control.pid,
			output,
			running: () => isRunning(child),
			exited: () => exitOf(child),
			exitedAt: () => exitedAt,
			quit
		};
	} catch (error) {
		await killTree(child);
		// The app is gone, so this only drops Playwright's end of the connection; a failure
		// here says nothing the launch error rethrown below does not.
		await browser?.close().catch(() => undefined);
		throw error;
	}
}

export type SpawnedApp = {
	child: ChildProcess;
	/** Main's control channel (see the header). */
	control: ControlClient;
	/** http://127.0.0.1:<port>, from the listening line. */
	origin: string;
	port: number;
	output(): string;
	/** Ends the app's whole process group: SIGTERM, then SIGKILL past the deadline. */
	kill(): Promise<ExitStatus>;
};

/**
 * darwin: starts the universal app's x86_64 slice under Rosetta with
 * `/usr/bin/arch -x86_64 <exe>`, with main's control channel and no window
 * connection, and waits for main.ts's listening line and main's reply to 'pid'. The
 * run must already own its userData; the app runs in its own process group.
 */
export async function spawnX64(run: PackagedRun): Promise<SpawnedApp> {
	if (run.platform !== 'darwin') throw new Error('spawnX64: darwin only');
	if (!run.ownsUserData) throw new Error('spawnX64: refused, this run has not claimed userData');
	const controlDir = mkdtempSync(join(run.controlRoot, 'x64-'));
	const child = spawn('/usr/bin/arch', ['-x86_64', run.exe, ...run.args], {
		cwd: run.home,
		env: { ...run.env, [E2E_CONTROL_ENV]: controlDir },
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	const output = collectOutput(child);
	const started = watchStart(child, output);
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
		const listening = await untilStarted(
			started,
			() => 'spawnX64: no listening line',
			Date.now() + X64_LAUNCH_TIMEOUT_MS,
			() => LISTENING.exec(output())
		);
		const control = await awaitControl(started, controlDir, Date.now() + CONTROL_REPLY_MS);
		return { child, control, origin: listening[1], port: Number(listening[2]), output, kill };
	} catch (error) {
		// A process that never started has no group to signal and no exit to wait for.
		if (group !== undefined) await kill();
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Main's updater, through the control channel (src/desktop/updater.ts).

/** The packaged app's updater status; throws when the app built no updater. */
export async function updaterStatus(control: ControlClient): Promise<UpdaterStatus> {
	return (await control.send({ cmd: 'updaterStatus' })) as UpdaterStatus;
}

/** How long a forced update check may take to settle. */
const CHECK_NOW_MS = 120_000;

/**
 * Forces an update check (or joins the one in flight), waits for it to settle and
 * resolves with the status after it; throws when the app built no updater.
 */
export async function updaterCheckNow(control: ControlClient): Promise<UpdaterStatus> {
	return (await control.send({ cmd: 'updaterCheckNow' }, CHECK_NOW_MS)) as UpdaterStatus;
}

/**
 * The tray's 'Restart to update'. Main answers before it starts quitting and reports
 * a failure after that on stderr, so a rejected call is not a failure by itself: the
 * caller judges by the process's exit.
 */
export async function updaterRestart(control: ControlClient): Promise<unknown> {
	return control.send({ cmd: 'updaterRestart' }).then(
		() => undefined,
		(error: unknown) => error
	);
}

// ---------------------------------------------------------------------------
// The packaged update test's probes (05-release c-5, c-6). An update's relaunch is
// started by the installer, not this harness, so the test finds it through the OS:
//   - win32: Get-Process filtered to the install path inside PowerShell (an unfiltered
//     listing carries the Idle process, pid 0, which no app process can be), and
//     Get-NetTCPConnection for the 127.0.0.1 port its main process serves on;
//   - linux: `ss -Hltnp` for 127.0.0.1 listeners, each tied to the AppImage by the
//     APPIMAGE variable the AppImage runtime gave the process, and counted only when
//     its executable lies under the AppImage's mount (not the runtime or FUSE daemon),
//     or, once /proc no longer shows that variable, by a socket it shares with the
//     runtime or FUSE daemon.
// One listening port is one instance, however many of the app's processes hold its
// socket; its pid is the main process among them (scripts/process-probe.ts parses the
// output and picks it).

/** One running instance of the packaged app found through the OS. */
export type AppInstance = {
	/** Its main process: of a port's holders, the one mainProcess picks. */
	pid: number;
	/** The 127.0.0.1 port it serves on; null for a process that serves none (win32). */
	port: number | null;
	startTime: Date | null;
	/** Every process of the app holding the port's socket (or the one process), for diagnosis. */
	processes: ProcessDetail[];
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
/** Read by the PowerShell module listing: the pid it lists. */
const PROBE_PID_ENV = 'PRICE_CHECK_PROBE_PID';

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
	// One OwningProcess per connection, so a port has one holder here; grouped by port
	// all the same, as on linux. Get-Process gives no parent or command line.
	const byPid = new Map(processes.map((info) => [info.pid, info]));
	const serving = instancesByPort(listeners, (pid) =>
		byPid.has(pid) ? { pid, ppid: null, cmdline: null } : null
	);
	const holders = new Set(serving.flatMap(({ processes: held }) => held.map(({ pid }) => pid)));
	return [
		...serving.map(({ pid, port, processes: held }) => ({
			pid,
			port,
			startTime: byPid.get(pid)?.startTime ?? null,
			processes: held
		})),
		...processes
			.filter(({ pid }) => !holders.has(pid))
			.map(({ pid, startTime }) => ({
				pid,
				port: null,
				startTime,
				processes: [{ pid, ppid: null, cmdline: null }]
			}))
	];
}

/**
 * Runs `read` on a /proc entry; null when the process has exited since it was listed
 * (ENOENT, or ESRCH mid-read). Any other failure (EACCES) throws: read as 'not ours'
 * it would hide the very instance the test wants. `tolerant` (a diagnosis, which reads
 * what it can) reads every failure as null.
 */
function procEntry(read: () => string, tolerant: boolean): string | null {
	try {
		return read();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (tolerant || code === 'ENOENT' || code === 'ESRCH') return null;
		throw error;
	}
}

/** What /proc shows of a linux process (see procEntry for `tolerant`). */
function linuxProc(pid: number, tolerant = false): LinuxProc {
	const file = (name: string) =>
		procEntry(() => readFileSync(`/proc/${pid}/${name}`, 'utf8'), tolerant);
	return {
		pid,
		environ: file('environ'),
		exe: procEntry(() => readlinkSync(`/proc/${pid}/exe`), tolerant),
		status: file('status'),
		cmdline: file('cmdline')
	};
}

/** Every 127.0.0.1 listener on linux, by pid. */
export async function linuxListeners() {
	return parseSsListeners(await runProbe('ss', ['-Hltnp']));
}

/**
 * Every instance serving on 127.0.0.1 that the AppImage at `appImage` started (linux):
 * one per port, since processes sharing a socket all show up in its `ss` entry. Only
 * the app's own processes count (linuxAppHolders), one whose environ no longer names
 * the AppImage included when it shares a socket with the runtime: a port held only by
 * the AppImage runtime or its FUSE daemon is no instance.
 */
export async function linuxAppInstances(appImage: string): Promise<AppInstance[]> {
	const listeners = await linuxListeners();
	const procs = [...listeners.keys()].map((pid) => linuxProc(pid));
	const holders = linuxAppHolders(procs, listeners, appImage);
	return instancesByPort(listeners, (pid) => holders.get(pid) ?? null).map((instance) => ({
		...instance,
		startTime: null
	}));
}

/** The 127.0.0.1 ports linux process `pid` listens on, ascending; [] for none. */
export async function linuxListenPorts(pid: number): Promise<number[]> {
	return (await linuxListeners()).get(pid) ?? [];
}

/**
 * Linux process `root` and every process descended from it, by /proc's PPid. Only a
 * process gone since the listing is skipped: an unreadable one throws (procEntry), as
 * a descendant dropped from the tree would hide its listeners.
 */
function linuxProcessTree(root: number): Set<number> {
	const children = new Map<number, number[]>();
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		const status = procEntry(() => readFileSync(`/proc/${entry}/status`, 'utf8'), false);
		const ppid = status === null ? null : parseProcStatusPpid(status);
		if (ppid !== null) children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)]);
	}
	const tree = new Set([root]);
	for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child);
	return tree;
}

/**
 * Every TCP port linux process `root` or a process descended from it listens on, on any
 * address, ascending (06-remediate-security c-27). Read from `ss -Hltnp` directly:
 * linuxListeners keeps 127.0.0.1 only, and would miss a listener on 0.0.0.0 or [::].
 */
export async function linuxTreeListenPorts(root: number): Promise<number[]> {
	const tree = linuxProcessTree(root);
	const ports = new Set<number>();
	for (const line of (await runProbe('ss', ['-Hltnp'])).split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 6 || fields[0] !== 'LISTEN') continue;
		const users = fields.slice(5).join(' ');
		const pids = [...users.matchAll(/\bpid=(\d+)\b/g)].map((match) => Number(match[1]));
		if (!pids.some((pid) => tree.has(pid))) continue;
		const local = fields[3];
		const port = local.slice(local.lastIndexOf(':') + 1);
		if (/^\d+$/.test(port)) ports.add(Number(port));
	}
	return [...ports].sort((a, b) => a - b);
}

/**
 * The native modules (.node files) process `pid` has loaded, as the OS lists them:
 * linux /proc/<pid>/maps, darwin `lsof -p` (mapped libraries are among its files),
 * win32 the process's Modules. The inspector that once read process.report is gone.
 */
export async function loadedNativeModules(
	platform: PackagedPlatform,
	pid: number
): Promise<string[]> {
	let paths: string[];
	if (platform === 'linux') {
		paths = readFileSync(`/proc/${pid}/maps`, 'utf8')
			.split('\n')
			.map((line) => (line.includes('/') ? line.slice(line.indexOf('/')) : ''))
			.map((path) => path.replace(/ \(deleted\)$/, ''));
	} else if (platform === 'darwin') {
		// -F n: one 'n<path>' line per open file.
		paths = (await runProbe('lsof', ['-p', String(pid), '-F', 'n']))
			.split('\n')
			.filter((line) => line.startsWith('n'))
			.map((line) => line.slice(1));
	} else {
		const json = await powershell(
			`(Get-Process -Id $env:${PROBE_PID_ENV}).Modules | ForEach-Object { $_.FileName } | ConvertTo-Json -Compress`,
			{ [PROBE_PID_ENV]: String(pid) }
		);
		const parsed: unknown = json.trim() === '' ? [] : JSON.parse(json);
		paths = (Array.isArray(parsed) ? parsed : [parsed]).filter(
			(path): path is string => typeof path === 'string'
		);
	}
	return [...new Set(paths.filter((path) => path.endsWith('.node')))];
}

/**
 * For a failed step's diagnosis (linux): every process of the AppImage at `appImage`,
 * runtime and FUSE daemon included, listening or not (appImageProcesses), with its
 * executable. Reads what /proc gives; a process it withholds is left out.
 */
export function linuxAppImageProcesses(appImage: string): ProcessDetail[] {
	const procs = readdirSync('/proc')
		.filter((entry) => /^\d+$/.test(entry))
		.map((entry) => linuxProc(Number(entry), true));
	return appImageProcesses(procs, appImage);
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
 * Ends an app instance the installer started (no launch handle to quit it):
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
