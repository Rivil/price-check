// The desktop app's lifecycle (spec c-5..c-9, decisions window_close and login_start).
//
// Startup, in order: point userData at the app's dir, take the single-instance lock
// (keyed by userData, so the path is set first), set the Windows AppUserModelId, wait
// for Electron, load the alerts key, start the server, read the runtime it published,
// create the tray, register start-at-login, and open the window unless this is a
// login launch (tray only).
//
// The AppUserModelId is set before the server starts, so before any notification can
// be shown (spec c-6): Windows routes toasts by it. A throw there is logged and
// skipped; a lost toast is better than no app.
//
// A notification click shows the window on its in-app path (spec c-2), reopening a
// closed window and restoring a minimised one, on a tray-only login launch too. A
// click before startup ends is held, the latest one winning, and shown once ready; a
// click after Quit started opens nothing.
//
// A launch that loses the lock touches nothing (no key, DB or server) and quits: the
// running instance gets 'second-instance' and shows its window instead. A launch that
// an update started (predecessorPid set) first waits, up to PREDECESSOR_WAIT_MS, for
// that old process to exit, then takes the lock once more: the updater may start it
// while the old process still holds the lock (spec c-6). Closing the
// window never quits: a 'window-all-closed' listener that does nothing replaces
// Electron's default, which would quit on Windows and Linux. Only Quit ends the app.
//
// Quit runs one shutdown: stop the scheduler (draining the pass in flight), close the
// server, close the DB, then app.exit(0). Every step is guarded and the whole run has
// a deadline, so a step that throws, rejects or hangs can never keep the process
// alive. Exiting is what makes a relaunch safe: on Windows libsql keeps the DB file
// locked after close(), and only the end of the process releases it; the relaunch
// cannot start its own server before then, because this process holds the
// single-instance lock until it exits.
//
// A downloaded update installs on the way out (spec c-5, c-6; decision update_flow):
// after the shutdown (or its deadline), right before app.exit(0), quit hands it to
// the installer, which relaunches the new version only for 'Restart to update'. The
// installer and the new version inherit this process's env, so the key and DB URL
// are removed from it first and PRICE_CHECK_PREDECESSOR_PID names this process for
// the new one to wait on. This module never calls app.relaunch(): the only relaunch
// is the updater's. The installer's own app.quit() fires before-quit again; that one
// is let through, never held, so it cannot keep the process alive.
//
// A startup that fails (bad key file, server that does not start) shows an error box
// and exits with code 1. It never lingers without a window or tray: a zombie would
// keep the lock and swallow every relaunch.
//
// Runs in the Electron main bundle. Every step is injected through the structural
// types below; main.ts wires the real Electron objects and the window, tray,
// login-item, server and key modules.
import type { ServerRuntime } from '#lib/server/runtime-bridge.ts';
import type { ExitMode } from './updater.ts';

/** How long quit lets the scheduler finish the pass in flight. */
export const SCHEDULER_DRAIN_MS = 3_000;
/** The longest quit waits for the whole shutdown before exiting anyway. */
export const SHUTDOWN_DEADLINE_MS = 6_000;
export const STARTUP_ERROR_TITLE = 'Price Check could not start';
/** The env var naming the process an update replaced; the new version waits for it to exit. */
export const PREDECESSOR_PID_ENV = 'PRICE_CHECK_PREDECESSOR_PID';
/** The longest a launch that lost the lock waits for its predecessor to exit. */
export const PREDECESSOR_WAIT_MS = 30_000;
/** How often that wait asks whether the predecessor is still alive. */
export const PREDECESSOR_POLL_MS = 250;
/** Removed from the env the installer and the new version inherit. */
const INHERITED_SECRETS = ['ALERTS_ENCRYPTION_KEY', 'DATABASE_URL'] as const;

/** The slice of Electron's app this module uses. */
export type LifecycleApp = {
	setPath(name: string, path: string): void;
	requestSingleInstanceLock(): boolean;
	setAppUserModelId(id: string): void;
	whenReady(): Promise<void>;
	on(event: 'second-instance', listener: () => void): unknown;
	on(event: 'window-all-closed', listener: () => void): unknown;
	on(event: 'activate', listener: () => void): unknown;
	on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
	quit(): void;
	exit(exitCode?: number): void;
};

/** The running desktop server (server.ts provides it). */
export type LifecycleServer = {
	/** http://127.0.0.1:<port>, the URL the window loads. */
	origin: string;
	close(): Promise<void>;
};

/** The start-at-login steps this module drives (login-item.ts provides them). */
export type LifecycleLoginItem = {
	/** Registers on a packaged first launch; must not throw. */
	ensureRegisteredOnce(): unknown;
	isLoginLaunch(): boolean;
};

/** What the tray needs from the lifecycle; main.ts adds the login item and icon dir. */
export type LifecycleTrayActions = {
	showWindow(): void;
	quitApp(): void;
	/** Quits, installing the downloaded update and relaunching the new version. */
	restartToUpdate(): void;
};

/** The update steps quit drives (updater.ts's controller provides them). */
export type LifecycleUpdates = {
	/** True while a downloaded update waits to install. */
	pending(): boolean;
	/** Hands the update to the installer; 'restart' relaunches the new version. */
	installOnExit(mode: ExitMode): boolean;
};

/** Where notification clicks are routed (notifier.ts's handle provides it). */
export type LifecycleNotifications = {
	/** Receives the in-app path each clicked notification opens. */
	setClickHandler(handler: (path: string) => void): void;
};

export type LifecycleDeps = {
	app: LifecycleApp;
	powerMonitor: { on(event: 'resume', listener: () => void): unknown };
	dialog: { showErrorBox(title: string, content: string): void };
	/** The resolved userData dir, and the key and DB files inside it. */
	paths: { userData: string; keyFile: string; dbFile: string };
	loadKey(keyFile: string): Promise<Buffer>;
	/** Loads the server's handler under the desktop env and starts listening. */
	startServer(key: Buffer): Promise<LifecycleServer>;
	/** The runtime the server published once it was up (runtime-bridge readRuntime). */
	readRuntime(): ServerRuntime;
	createTray(actions: LifecycleTrayActions): unknown;
	/**
	 * Shows the app window on `origin`: creates it if none is open (never a second
	 * one), else restores and focuses it (window.ts showWindow). With `path`, the
	 * window loads that in-app page; without, it keeps the page it is on.
	 */
	showWindow(origin: string, path?: string): void;
	/** The ID for app.setAppUserModelId (app-id.ts), or null where none is set. */
	appUserModelId: string | null;
	notifications: LifecycleNotifications;
	loginItem: LifecycleLoginItem;
	/** The updater, packaged builds only; absent, nothing installs on quit. */
	updates?: LifecycleUpdates;
	/** The process an update replaced (PRICE_CHECK_PREDECESSOR_PID), or null. */
	predecessorPid?: number | null;
	/** Whether a process is still running (wired with predecessorPid). */
	isProcessAlive?(pid: number): boolean;
};

export type DesktopOutcome = 'second-instance' | 'started' | 'failed';

type Running = {
	server: LifecycleServer | null;
	runtime: ServerRuntime | null;
	/** Startup has finished: the window may be shown. */
	ready: boolean;
	/** Held so the tray is never garbage-collected (it would vanish from the menu bar). */
	tray: unknown;
	/** A relaunch or click came before the window could be shown; show it once ready. */
	showRequested: boolean;
	/** The latest notification click's path held for that show, if any. */
	requestedPath: string | undefined;
	quitting: boolean;
	/** How quit hands over a pending update: 'restart' only from Restart to update. */
	exitMode: ExitMode;
	/** The update went to the installer: its own before-quit is let through. */
	installing: boolean;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Removes the key, in every encoding it could appear in, from text shown to the user. */
export function redactKey(text: string, key: Buffer | null): string {
	if (key === null) return text;
	let redacted = text;
	for (const encoded of [key.toString('base64'), key.toString('base64url'), key.toString('hex')]) {
		redacted = redacted.split(encoded).join('[redacted]');
	}
	return redacted;
}

/** Runs one shutdown step; a throw or rejection is logged, never propagated. */
async function step(name: string, run: () => Promise<void> | void): Promise<void> {
	try {
		await run();
	} catch (error) {
		console.error(`desktop quit: ${name} failed`, error);
	}
}

/** Resolves after `ms` on the real (or faked) timers. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until `pid` has exited or PREDECESSOR_WAIT_MS has passed. A throwing probe
 * counts as exited: the lock retry that follows decides.
 */
async function waitForExit(pid: number, isAlive: (pid: number) => boolean): Promise<void> {
	for (let waited = 0; waited < PREDECESSOR_WAIT_MS; waited += PREDECESSOR_POLL_MS) {
		try {
			if (!isAlive(pid)) return;
		} catch (error) {
			console.error('desktop startup: checking the previous version failed', error);
			return;
		}
		await sleep(PREDECESSOR_POLL_MS);
	}
	console.error(`desktop startup: the previous version outlived ${PREDECESSOR_WAIT_MS}ms`);
}

/**
 * After a lost lock: when an update started this launch, waits for the process it
 * replaced to exit and takes the lock once more. False at once for any other launch.
 */
async function lockAfterPredecessor(deps: LifecycleDeps): Promise<boolean> {
	const { app, predecessorPid, isProcessAlive } = deps;
	if (predecessorPid === undefined || predecessorPid === null || !isProcessAlive) return false;
	await waitForExit(predecessorPid, isProcessAlive);
	return app.requestSingleInstanceLock();
}

/**
 * Hands a pending update to the installer, with the key and DB URL gone from the env
 * it inherits and this process named as the predecessor. Marks the hand-over before
 * it starts, so the installer's own app.quit() is let through. Never throws.
 */
function installPending(updates: LifecycleUpdates | undefined, running: Running): void {
	if (!updates) return;
	try {
		if (!updates.pending()) return;
		for (const name of INHERITED_SECRETS) delete process.env[name];
		process.env[PREDECESSOR_PID_ENV] = String(process.pid);
		running.installing = true;
		if (!updates.installOnExit(running.exitMode)) {
			console.error('desktop quit: the update was not handed to the installer');
		}
	} catch (error) {
		console.error('desktop quit: installing the update failed', error);
	}
}

function startupFailure(
	deps: LifecycleDeps,
	stage: 'key' | 'server',
	error: unknown,
	key: Buffer | null
): void {
	const { userData, keyFile, dbFile } = deps.paths;
	const lead =
		stage === 'key'
			? `The alerts key file could not be used:\n${keyFile}`
			: `The app's server did not start. Its database is:\n${dbFile}`;
	const content = redactKey(`${lead}\n\n${messageOf(error)}\n\nData folder: ${userData}`, key);
	console.error(`desktop startup: ${stage} failed`, redactKey(messageOf(error), key));
	try {
		deps.dialog.showErrorBox(STARTUP_ERROR_TITLE, content);
	} catch (boxError) {
		console.error('desktop startup: showing the error failed', boxError);
	}
	deps.app.exit(1);
}

/**
 * Starts the desktop app. Resolves 'second-instance' when another instance holds the
 * lock (this one quits), 'failed' when startup failed (this one exits 1), else
 * 'started'.
 */
export async function runDesktop(deps: LifecycleDeps): Promise<DesktopOutcome> {
	const { app } = deps;
	app.setPath('userData', deps.paths.userData);
	// The usual launch takes the lock without awaiting anything, so its listeners are
	// attached in this same tick.
	if (!app.requestSingleInstanceLock() && !(await lockAfterPredecessor(deps))) {
		app.quit();
		return 'second-instance';
	}

	if (deps.appUserModelId !== null) {
		try {
			app.setAppUserModelId(deps.appUserModelId);
		} catch (error) {
			console.error('desktop startup: setting the AppUserModelId failed', error);
		}
	}

	const running: Running = {
		server: null,
		runtime: null,
		ready: false,
		tray: null,
		showRequested: false,
		requestedPath: undefined,
		quitting: false,
		exitMode: 'quit',
		installing: false
	};

	/** Shows the window, on `path` if given; before startup ends, holds the request. */
	const show = (path: string | undefined): void => {
		if (running.quitting) return;
		if (!running.ready || running.server === null) {
			running.showRequested = true;
			// A relaunch names no page, so it never drops a held click's path.
			if (path !== undefined) running.requestedPath = path;
			return;
		}
		const { origin } = running.server;
		if (path === undefined) deps.showWindow(origin);
		else deps.showWindow(origin, path);
	};
	// Takes no arguments: Electron passes event objects to the listeners it is attached to.
	const showWindow = (): void => show(undefined);

	const shutdown = async (): Promise<void> => {
		const { runtime, server } = running;
		if (runtime) await step('stopping the scheduler', () => runtime.stop(SCHEDULER_DRAIN_MS));
		if (server) await step('closing the server', () => server.close());
		if (runtime) await step('closing the database', () => runtime.closeDb());
	};

	app.on('second-instance', showWindow);
	deps.notifications.setClickHandler((path) => show(path));
	// Present but empty: closing the last window must not quit (decision window_close).
	app.on('window-all-closed', () => {});
	app.on('before-quit', (event) => {
		// The installer quitting the app it replaces: exit is already under way.
		if (running.installing) return;
		event.preventDefault();
		if (running.quitting) return;
		running.quitting = true;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<void>((resolve) => {
			deadline = setTimeout(() => {
				console.error(`desktop quit: shutdown passed ${SHUTDOWN_DEADLINE_MS}ms, exiting anyway`);
				resolve();
			}, SHUTDOWN_DEADLINE_MS);
		});
		void Promise.race([shutdown(), timedOut]).then(() => {
			clearTimeout(deadline);
			installPending(deps.updates, running);
			app.exit(0);
		});
	});

	await app.whenReady();

	let key: Buffer;
	try {
		key = await deps.loadKey(deps.paths.keyFile);
	} catch (error) {
		startupFailure(deps, 'key', error, null);
		return 'failed';
	}

	let runtime: ServerRuntime;
	try {
		running.server = await deps.startServer(key);
		runtime = deps.readRuntime();
	} catch (error) {
		startupFailure(deps, 'server', error, key);
		return 'failed';
	}
	running.runtime = runtime;

	deps.powerMonitor.on('resume', () => {
		if (running.quitting) return;
		try {
			runtime.requestPass();
		} catch (error) {
			console.error('desktop resume: scheduler pass failed', error);
		}
	});

	running.tray = deps.createTray({
		showWindow,
		quitApp: () => app.quit(),
		restartToUpdate() {
			// Once quit started (or a restart was asked for), the mode is settled.
			if (running.quitting || running.exitMode === 'restart') return;
			running.exitMode = 'restart';
			app.quit();
		}
	});
	deps.loginItem.ensureRegisteredOnce();

	running.ready = true;
	// macOS: clicking the Dock icon reopens the window. Attached after startup, so an
	// activation at launch cannot open a window on a login launch.
	app.on('activate', showWindow);
	if (!deps.loginItem.isLoginLaunch() || running.showRequested) {
		const path = running.requestedPath;
		running.showRequested = false;
		running.requestedPath = undefined;
		show(path);
	}
	return 'started';
}
