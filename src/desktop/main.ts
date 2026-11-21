// The Electron main entry (spec c-1, c-7): the one module that imports electron's
// values (boundary.spec pins that). It wires the real Electron objects into the
// lifecycle and the window, tray, login-item, key and server modules; every
// decision lives in those modules, not here.
//
// Bundled by scripts/build-desktop.ts to dist-desktop/main.js (package.json main),
// so the app root is one level above this file at runtime, and the SvelteKit server
// is adapter-node's build/handler.js under it. The handler is imported at runtime by
// loadAdapterHandler, only after the desktop env and cwd are in place: a static
// import would run the server's module-level env reads against the user's shell.
//
// The desktop notifier is built here, before startup, and published on the notify
// bridge by loadAdapterHandler ahead of that import. Its clicks route to the window
// through runDesktop. The e2e seam reads PRICE_CHECK_E2E_NOTIFY from the user's env
// now, before loadAdapterHandler swaps process.env for the server's.
//
// The server runs in serverCwdFor(APP_ROOT): the repo root unpackaged, the
// app.asar.unpacked sibling packaged, where drizzle/ ships (chdir into app.asar would
// throw ENOTDIR). The handler and the tray icons are still read from APP_ROOT.
//
// Updates (05-release c-5, c-6; decision update_flow) run only when app.isPackaged:
// the updater is built with the same notifier, its onReady shows the tray's 'Restart
// to update', and once startup has finished it starts checking and is published for
// the packaged e2e suite. An unpackaged run (pnpm dev, the e2e suite) builds no
// updater and publishes no handle. The feed comes only from app-update.yml.
// PRICE_CHECK_PREDECESSOR_PID (set by the version an update replaced) is read and
// removed now, before loadAdapterHandler swaps process.env for the server's.
// runDesktop gets process.platform and Electron's native autoUpdater (Squirrel.Mac):
// on macOS, quit waits for it to stage a handed-over update before exiting.
//
// The alerts key file is wrapped by Electron's safeStorage where it has a real OS
// backend (alerts-key.ts; 06-remediate-security c-24, c-25), so every launch hands
// it to loadOrCreateAlertsKey.
//
// The session gate (06-remediate-security c-3; decision session_secret): one secret
// is made per launch and held only in this module's memory, never in process.env or
// argv, where the server's env, a child process or a crash report could carry it. The
// server is started with it, and startServer awaits session.defaultSession.cookies.set
// for its cookie before resolving. runDesktop shows the window only once startServer
// has resolved, and every window uses the default session, so the window's first
// request already carries the cookie. A rejected cookies.set closes the server and
// fails startup: no window opens without the cookie.
//
// '[desktop] listening on http://127.0.0.1:<port>' is printed once the server is up
// and the cookie set: the desktop e2e harness reads it to find the per-launch port.
//
// Test-only output capture (05-release t-30): electron-updater starts the updated
// AppImage with stdio 'ignore', so the packaged update test cannot see what it printed
// or why it exited. When PRICE_CHECK_E2E_OUTPUT_CAPTURE names an absolute file, this
// process appends to it, as JSON lines, its start (ppid, argv), every stdout and
// stderr write, any uncaught error and its exit code (startOutputCapture);
// scripts/process-probe.ts reads them back. The variable is read and removed first
// thing, so the server's env never carries it, and put back only for the hand-over to
// the installer (withCaptureHandOver), so the version an update starts captures too.
// A packaged Electron drops NODE_OPTIONS but --max-http-header-size and --http-parser
// (Electron 45's environment-variables docs), so a --require preload cannot do this.
// Unset (every real launch), nothing is hooked and the updater is passed as is.
//
// Test-only control channel (06-remediate-security c-22, c-27; decision
// cli_inspect_fuse): the shipped app has the Node inspector fuse off, so the packaged
// e2e suites drive main through e2e-control.ts instead. PRICE_CHECK_E2E_CONTROL_DIR is
// read and removed with the capture variable, before loadAdapterHandler swaps
// process.env for the server's; set, the channel starts answering from this launch's
// objects (controlHandlers), and the variable is put back only for the hand-over to the
// installer (withControlHandOver). Its appGet reaches this launch's server with the
// session cookie, so the secret never leaves this process. Unset (every real launch),
// no channel starts at all.
// The version an update starts answers too on Linux, where electron-updater spawns it
// with this env. On Windows it does not: the NSIS installer inherits the variable but
// starts the app through Explorer (StartApp's ExecShellAsUser), so that version gets
// Explorer's env and starts no channel. The same holds for the capture and predecessor
// variables, which an installer-started version never sees on Windows.
import {
	app,
	autoUpdater,
	BrowserWindow,
	dialog,
	Menu,
	Notification,
	powerMonitor,
	safeStorage,
	session,
	shell,
	Tray
} from 'electron';
import electronUpdater from 'electron-updater';
import { appendFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntime } from '#lib/server/runtime-bridge.ts';
import { loadOrCreateAlertsKey } from './alerts-key.ts';
import { appUserModelIdFor } from './app-id.ts';
import { desktopPaths, resolveUserDataDir, serverCwdFor } from './app-paths.ts';
import {
	E2E_CONTROL_ENV,
	startE2eControl,
	takeE2eControlDir,
	type AppGetResult,
	type E2eControlHandlers
} from './e2e-control.ts';
import {
	PREDECESSOR_PID_ENV,
	runDesktop,
	STARTUP_ERROR_TITLE,
	type LifecycleUpdates
} from './lifecycle.ts';
import { createLoginItem } from './login-item.ts';
import { createNotifier } from './notifier.ts';
import { notificationClassFor } from './notify-seam.ts';
import { serverEnv } from './server-env.ts';
import { loadAdapterHandler, startDesktopServer } from './server.ts';
import { cookieDetails, createSessionSecret, SESSION_COOKIE } from './session-gate.ts';
import { createTray, type TrayHandle } from './tray.ts';
import {
	createUpdater,
	publishUpdaterHandle,
	type ExitMode,
	type UpdaterController
} from './updater.ts';
import { createWindowState, showWindow, type WindowState } from './window.ts';

/** dist-desktop/main.js -> the repo (or packaged app) root. */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Where the server runs: drizzle/ is resolved against it (app.asar.unpacked packaged). */
const SERVER_CWD = serverCwdFor(APP_ROOT);
const HANDLER_URL = new URL('../build/handler.js', import.meta.url).href;
const ICON_DIR = join(APP_ROOT, 'src', 'desktop', 'assets');
/** How long a notification may go unreported before it counts as delivered. */
const NOTIFY_SETTLE_MS = 4_000;

/** Test-only: names the output capture file (see the header). */
export const OUTPUT_CAPTURE_ENV = 'PRICE_CHECK_E2E_OUTPUT_CAPTURE';

/** The capture file OUTPUT_CAPTURE_ENV names, removed from `env`; null unless absolute. */
export function takeOutputCaptureFile(env: NodeJS.ProcessEnv): string | null {
	const file = env[OUTPUT_CAPTURE_ENV];
	delete env[OUTPUT_CAPTURE_ENV];
	return file !== undefined && isAbsolute(file) ? file : null;
}

/** A stream whose writes the capture records. */
export type CaptureStream = { write(chunk: string | Uint8Array, ...rest: unknown[]): boolean };

/** The slice of `process` startOutputCapture hooks. */
export type CaptureProcess = {
	pid: number;
	ppid: number;
	argv: readonly string[];
	stdout: CaptureStream;
	stderr: CaptureStream;
	on(event: 'uncaughtExceptionMonitor', listener: (error: Error, origin: string) => void): unknown;
	on(event: 'exit', listener: (code: number) => void): unknown;
};

/**
 * Appends this process's start, then every stdout and stderr write (still written
 * through), uncaught error and its exit, as one JSON line each, to `file`. Only
 * observes: the monitor event leaves Node's own uncaught handling as it was, and a
 * failed append is dropped (reporting it would print, and so append, again).
 */
export function startOutputCapture(
	file: string,
	proc: CaptureProcess,
	append: (file: string, line: string) => void = appendFileSync,
	now: () => Date = () => new Date()
): void {
	const record = (fields: Record<string, unknown>) => {
		try {
			append(file, `${JSON.stringify({ pid: proc.pid, at: now().toISOString(), ...fields })}\n`);
		} catch {
			// Never let a diagnostic aid fail the app.
		}
	};
	record({ kind: 'start', ppid: proc.ppid, argv: proc.argv });
	for (const kind of ['stdout', 'stderr'] as const) {
		const stream = proc[kind];
		const write = stream.write.bind(stream);
		stream.write = (chunk, ...rest) => {
			record({
				kind,
				text: typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			});
			return write(chunk, ...rest);
		};
	}
	proc.on('uncaughtExceptionMonitor', (error, origin) => {
		record({
			kind: 'error',
			origin,
			text: error instanceof Error ? (error.stack ?? String(error)) : String(error)
		});
	});
	proc.on('exit', (code) => record({ kind: 'exit', code }));
}

/**
 * `updates` as is without a capture file; with one, each hand-over to the installer
 * first puts OUTPUT_CAPTURE_ENV back into `env`, which the installer inherits, and the
 * version it starts too except on Windows (see the header).
 */
export function withCaptureHandOver(
	updates: LifecycleUpdates,
	file: string | null,
	env: NodeJS.ProcessEnv
): LifecycleUpdates {
	if (file === null) return updates;
	return {
		pending: () => updates.pending(),
		installOnExit(mode) {
			env[OUTPUT_CAPTURE_ENV] = file;
			return updates.installOnExit(mode);
		}
	};
}

/**
 * `updates` as is without a control dir; with one, each hand-over to the installer
 * first puts E2E_CONTROL_ENV back into `env`, which the installer inherits. The version
 * it starts inherits it too, and answers on the same channel, except on Windows (see
 * the header).
 */
export function withControlHandOver<T extends LifecycleUpdates>(
	updates: T,
	dir: string | null,
	env: NodeJS.ProcessEnv
): T {
	if (dir === null) return updates;
	return {
		...updates,
		installOnExit(mode: ExitMode) {
			env[E2E_CONTROL_ENV] = dir;
			return updates.installOnExit(mode);
		}
	};
}

/** How long appGet waits for main's own server to answer in full. */
const APP_GET_TIMEOUT_MS = 30_000;

/** One GET of `origin` + `path` carrying the session cookie: status and body only. */
function appGet(origin: string, path: string, secret: string): Promise<AppGetResult> {
	return new Promise((done, fail) => {
		const outgoing = httpRequest(
			`${origin}${path}`,
			{ headers: { cookie: `${SESSION_COOKIE}=${secret}` }, agent: false },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () =>
					done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
				);
				res.on('error', fail);
			}
		);
		outgoing.setTimeout(APP_GET_TIMEOUT_MS, () => outgoing.destroy(new Error('appGet timed out')));
		outgoing.on('error', fail);
		outgoing.end();
	});
}

/** Read and started before anything else here prints. */
const outputCapture = takeOutputCaptureFile(process.env);
if (outputCapture !== null) startOutputCapture(outputCapture, process);

/** Test-only: the control channel's directory (see the header); null on every real launch. */
const e2eControlDir = takeE2eControlDir(process.env);

/** This launch's session secret (see the header): in memory only. */
const sessionSecret = createSessionSecret();

const paths = desktopPaths(
	resolveUserDataDir({
		appData: app.getPath('appData'),
		isPackaged: app.isPackaged,
		env: process.env
	})
);

const loginItem = createLoginItem({
	app,
	platform: process.platform,
	argv: process.argv,
	env: process.env,
	execPath: process.execPath,
	homeDir: homedir(),
	userData: paths.userData
});

const notifications = createNotifier({
	Notification: notificationClassFor({
		isPackaged: app.isPackaged,
		env: process.env,
		Notification
	}),
	settleMs: NOTIFY_SETTLE_MS
});

let windowState: WindowState | null = null;
let tray: TrayHandle<Menu> | null = null;
/** The tray's 'Restart to update' action, as runDesktop handed it to createTray. */
let restartToUpdate: (() => void) | null = null;
/** The server's origin once it is up and the cookie set; null before. */
let serverOrigin: string | null = null;

/** The process an update replaced, read before the server's env replaces process.env. */
const predecessorPid = parsePid(process.env[PREDECESSOR_PID_ENV]);
delete process.env[PREDECESSOR_PID_ENV];

function parsePid(raw: string | undefined): number | null {
	if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return null;
	const pid = Number(raw);
	return Number.isSafeInteger(pid) && pid !== process.pid ? pid : null;
}

/** Signal 0 only probes: ESRCH means gone; EPERM means alive but not ours. */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Packaged only: reading electronUpdater.autoUpdater builds the platform updater. */
const updater: UpdaterController | null = app.isPackaged
	? withControlHandOver(
			createUpdater({
				autoUpdater: electronUpdater.autoUpdater,
				isPackaged: app.isPackaged,
				appVersion: app.getVersion(),
				notifier: notifications.notifier,
				onReady: () => tray?.setUpdateReady(true),
				timers: { setInterval, clearInterval },
				log: {
					info: (message) => console.log(`[updater] ${message}`),
					error: (message, error) => console.error(`[updater] ${message}`, error ?? '')
				}
			}),
			e2eControlDir,
			process.env
		)
	: null;

/** The updater, for a control command; throws when this launch built none. */
function requireUpdater(): UpdaterController {
	if (updater === null) throw new Error('no updater');
	return updater;
}

/** The control channel's commands (e2e-control.ts) over this launch's objects. */
function controlHandlers(secret: string): E2eControlHandlers {
	return {
		pid: () => process.pid,
		info: () => ({
			version: app.getVersion(),
			isPackaged: app.isPackaged,
			userData: app.getPath('userData'),
			platform: process.platform,
			arch: process.arch,
			origin: serverOrigin ?? '',
			argv: [...process.argv],
			execArgv: [...process.execArgv]
		}),
		quit: () => app.quit(),
		loginItemOff: () => loginItem.setEnabled(false),
		updaterStatus: () => requireUpdater().status(),
		async updaterCheckNow() {
			const checked = requireUpdater();
			await checked.checkNow();
			return checked.status();
		},
		updaterRestart() {
			if (restartToUpdate === null) throw new Error('no tray restart action');
			restartToUpdate();
		},
		keyBackend: () => ({
			available: safeStorage.isEncryptionAvailable(),
			backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null
		}),
		appGet(path) {
			if (serverOrigin === null) return Promise.reject(new Error('the server is not up'));
			return appGet(serverOrigin, path, secret);
		},
		sessionSecret: () => secret
	};
}

if (e2eControlDir !== null) {
	startE2eControl(e2eControlDir, controlHandlers(sessionSecret), { pid: process.pid });
}

/** macOS: the app menu carries Quit (Cmd+Q), and Edit keeps copy and paste working in forms. */
function installAppMenu(): void {
	if (process.platform !== 'darwin') return;
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: app.name,
				submenu: [
					{ role: 'about' },
					{ type: 'separator' },
					{ role: 'hide' },
					{ role: 'hideOthers' },
					{ role: 'unhide' },
					{ type: 'separator' },
					{ role: 'quit' }
				]
			},
			{ role: 'editMenu' },
			{ role: 'windowMenu' }
		])
	);
}

runDesktop({
	app,
	powerMonitor,
	dialog,
	paths,
	// Called after app ready, when safeStorage can report its backend (SEC-15).
	loadKey: (keyFile) => loadOrCreateAlertsKey(keyFile, { safeStorage, platform: process.platform }),
	async startServer(key) {
		const env = serverEnv(process.env, { dbFile: paths.dbFile, key });
		const handler = await loadAdapterHandler(env, HANDLER_URL, SERVER_CWD, {
			notifier: notifications.notifier
		});
		const server = await startDesktopServer({ handler, secret: sessionSecret });
		try {
			// Before resolving: runDesktop creates the first window only after this.
			await session.defaultSession.cookies.set(cookieDetails(server.origin, sessionSecret));
		} catch (error) {
			await server.close().catch((closeError: unknown) => {
				console.error('desktop startup: closing the server failed', closeError);
			});
			throw error;
		}
		serverOrigin = server.origin;
		console.log(`[desktop] listening on ${server.origin}`);
		return server;
	},
	readRuntime,
	createTray: (actions) => {
		restartToUpdate = actions.restartToUpdate;
		tray = createTray(
			{ Tray, Menu, platform: process.platform },
			{ ...actions, loginItem, iconDir: ICON_DIR }
		);
		return tray;
	},
	showWindow(origin, path) {
		windowState ??= createWindowState({ BrowserWindow, shell }, origin);
		showWindow(windowState, path);
	},
	appUserModelId: appUserModelIdFor({
		platform: process.platform,
		isPackaged: app.isPackaged,
		execPath: process.execPath
	}),
	notifications,
	loginItem,
	platform: process.platform,
	...(updater ? { updates: withCaptureHandOver(updater, outputCapture, process.env) } : {}),
	nativeUpdater: autoUpdater,
	predecessorPid,
	isProcessAlive
}).then(
	(outcome) => {
		if (outcome !== 'started') return;
		installAppMenu();
		if (app.isPackaged && updater && restartToUpdate) {
			updater.start();
			publishUpdaterHandle({
				status: () => updater.status(),
				restart: restartToUpdate,
				checkNow: () => updater.checkNow()
			});
		}
	},
	(error: unknown) => {
		// A step after the server started threw (the tray, the window): exit rather
		// than linger without a way back, holding the lock against every relaunch.
		console.error('desktop startup failed', error);
		try {
			dialog.showErrorBox(
				STARTUP_ERROR_TITLE,
				error instanceof Error ? error.message : String(error)
			);
		} catch (boxError) {
			console.error('desktop startup: showing the error failed', boxError);
		}
		app.exit(1);
	}
);
