import type { App, AutoUpdater, Dialog, PowerMonitor } from 'electron';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerRuntime } from '#lib/server/runtime-bridge.ts';
import {
	PREDECESSOR_PID_ENV,
	PREDECESSOR_POLL_MS,
	PREDECESSOR_WAIT_MS,
	runDesktop,
	SCHEDULER_DRAIN_MS,
	SHUTDOWN_DEADLINE_MS,
	SQUIRREL_HANDOFF_MS,
	SQUIRREL_STAGE_WAIT_MS,
	STARTUP_ERROR_TITLE,
	type LifecycleApp,
	type LifecycleDeps,
	type LifecycleNativeUpdater,
	type LifecycleServer,
	type LifecycleTrayActions,
	type LifecycleUpdates
} from './lifecycle.ts';
import type { ExitMode, UpdaterController } from './updater.ts';

// Compile-time only (pnpm check): the real Electron app, powerMonitor, dialog and
// native autoUpdater must satisfy the structural deps main.ts passes in.
type RealDeps = {
	app: App;
	powerMonitor: PowerMonitor;
	dialog: Dialog;
	nativeUpdater: AutoUpdater;
};
const realDepsFit = (
	deps: RealDeps
): Pick<LifecycleDeps, 'app' | 'powerMonitor' | 'dialog' | 'nativeUpdater'> => deps;
void realDepsFit;
// The updater's controller is what main.ts passes as deps.updates.
const updaterFits = (controller: UpdaterController): LifecycleUpdates => controller;
void updaterFits;

const USER_DATA = '/data/Price Check user';
const KEY_FILE = `${USER_DATA}/alerts.key`;
const DB_FILE = `${USER_DATA}/price-check.db`;
const ORIGIN = 'http://127.0.0.1:41234';
const KEY = Buffer.from('k'.repeat(32));
const AUMID = 'io.github.rivil.price-check';

type Listener = (...args: unknown[]) => void;
type QuitEvent = { preventDefault: () => void };

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

class FakeEmitter {
	readonly listeners = new Map<string, Listener[]>();

	on(event: string, listener: Listener): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}

	has(event: string): boolean {
		return (this.listeners.get(event) ?? []).length > 0;
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}
}

type FakeApp = FakeEmitter & LifecycleApp & { relaunch: ReturnType<typeof vi.fn> };
type FakeNative = FakeEmitter & LifecycleNativeUpdater;

type Harness = {
	deps: LifecycleDeps;
	log: string[];
	app: FakeApp;
	powerMonitor: FakeEmitter;
	runtime: ServerRuntime;
	server: LifecycleServer;
	ready: ReturnType<typeof deferred<void>>;
	/** Windows the fake showWindow created (it creates one only when none is open). */
	windowsCreated: number;
	windowOpen: boolean;
	errorBoxes: { title: string; content: string }[];
	trayActions: LifecycleTrayActions | null;
	/** deps.nativeUpdater (Squirrel.Mac), when the options asked for one. */
	native: FakeNative | null;
	/** Delivers a notification click to the handler runDesktop registered. */
	click(path: string): void;
};

type HarnessOptions = {
	lock?: boolean;
	/** Successive requestSingleInstanceLock results; the last one repeats. Overrides lock. */
	locks?: boolean[];
	/** Like Electron: app.quit() emits before-quit at once (the fake's quit only logs). */
	quitEmitsBeforeQuit?: boolean;
	/** deps.updates with pending() returning this; no deps.updates when undefined. */
	pending?: boolean;
	predecessorPid?: number | null;
	isProcessAlive?: (pid: number) => boolean;
	loginLaunch?: boolean;
	whenReadyPending?: boolean;
	/** deps.appUserModelId; null (macOS, Linux) unless given. */
	appUserModelId?: string | null;
	/** deps.platform; 'linux' unless given. */
	platform?: NodeJS.Platform;
	/** Gives deps.nativeUpdater, a fake Squirrel.Mac. */
	nativeUpdater?: boolean;
};

function harness(options: HarnessOptions = {}): Harness {
	const log: string[] = [];
	const ready = deferred();
	if (!options.whenReadyPending) ready.resolve();
	const locks = [...(options.locks ?? [options.lock ?? true])];

	const app = Object.assign(new FakeEmitter(), {
		setPath: vi.fn((name: string) => void log.push(`setPath:${name}`)),
		requestSingleInstanceLock: vi.fn(() => {
			log.push('lock');
			return locks.length > 1 ? (locks.shift() as boolean) : locks[0];
		}),
		setAppUserModelId: vi.fn(() => void log.push('aumid')),
		whenReady: vi.fn(() => {
			log.push('whenReady');
			return ready.promise;
		}),
		quit: vi.fn(() => {
			log.push('quit');
			if (options.quitEmitsBeforeQuit) app.emit('before-quit', { preventDefault: vi.fn() });
		}),
		exit: vi.fn((code?: number) => void log.push(`exit:${code}`)),
		relaunch: vi.fn(() => void log.push('relaunch'))
	}) as FakeApp;
	harnesses.push(app);

	const powerMonitor = new FakeEmitter();

	const runtime: ServerRuntime = {
		requestPass: vi.fn(() => void log.push('requestPass')),
		stop: vi.fn(async () => void log.push('runtime.stop')),
		closeDb: vi.fn(async () => void log.push('runtime.closeDb'))
	};
	const server: LifecycleServer = {
		origin: ORIGIN,
		close: vi.fn(async () => void log.push('server.close'))
	};

	let clickHandler: ((path: string) => void) | null = null;

	const h: Harness = {
		log,
		app,
		powerMonitor,
		runtime,
		server,
		ready,
		windowsCreated: 0,
		windowOpen: false,
		errorBoxes: [],
		trayActions: null,
		native: options.nativeUpdater ? (new FakeEmitter() as FakeNative) : null,
		click(path) {
			if (clickHandler === null) throw new Error('no click handler registered');
			clickHandler(path);
		},
		deps: {
			app,
			powerMonitor,
			dialog: {
				showErrorBox: vi.fn((title: string, content: string) => {
					log.push('showErrorBox');
					h.errorBoxes.push({ title, content });
				})
			},
			paths: { userData: USER_DATA, keyFile: KEY_FILE, dbFile: DB_FILE },
			loadKey: vi.fn(async () => {
				log.push('loadKey');
				return KEY;
			}),
			startServer: vi.fn(async () => {
				log.push('startServer');
				return server;
			}),
			readRuntime: vi.fn(() => {
				log.push('readRuntime');
				return runtime;
			}),
			createTray: vi.fn((actions) => {
				log.push('createTray');
				h.trayActions = actions;
				return { tray: 'held' };
			}),
			showWindow: vi.fn((origin: string, path?: string) => {
				log.push(`showWindow:${origin}${path ?? ''}`);
				if (!h.windowOpen) {
					h.windowsCreated += 1;
					h.windowOpen = true;
				}
			}),
			appUserModelId: options.appUserModelId ?? null,
			platform: options.platform ?? 'linux',
			notifications: {
				setClickHandler: vi.fn((handler: (path: string) => void) => {
					clickHandler = handler;
				})
			},
			loginItem: {
				ensureRegisteredOnce: vi.fn(() => {
					log.push('ensureRegisteredOnce');
					return { status: 'unpackaged' };
				}),
				isLoginLaunch: vi.fn(() => options.loginLaunch ?? false)
			}
		}
	};
	if (options.pending !== undefined) {
		const pending = options.pending;
		h.deps.updates = {
			pending: vi.fn(() => pending),
			installOnExit: vi.fn((mode: ExitMode) => {
				log.push(`install:${mode}`);
				return true;
			})
		};
	}
	if (h.native) h.deps.nativeUpdater = h.native;
	if (options.predecessorPid !== undefined) h.deps.predecessorPid = options.predecessorPid;
	if (options.isProcessAlive) h.deps.isProcessAlive = vi.fn(options.isProcessAlive);
	return h;
}

/** Every fake app made in the current test, checked for app.relaunch() after it. */
const harnesses: FakeApp[] = [];

function beforeQuit(h: Harness): QuitEvent {
	const event = { preventDefault: vi.fn() };
	h.app.emit('before-quit', event);
	return event;
}

afterEach(() => {
	// No path may relaunch: the only relaunch is the updater's, after this process exits.
	const relaunched = harnesses.filter((app) => app.relaunch.mock.calls.length > 0).length;
	harnesses.length = 0;
	vi.useRealTimers();
	vi.restoreAllMocks();
	expect(relaunched).toBe(0);
});

describe('single instance', () => {
	it('a lost lock touches no key, server, tray or window and quits', async () => {
		const h = harness({ lock: false });
		await expect(runDesktop(h.deps)).resolves.toBe('second-instance');
		expect(h.app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
		expect(h.app.quit).toHaveBeenCalledTimes(1);
		expect(h.deps.loadKey).not.toHaveBeenCalled();
		expect(h.deps.startServer).not.toHaveBeenCalled();
		expect(h.deps.readRuntime).not.toHaveBeenCalled();
		expect(h.deps.createTray).not.toHaveBeenCalled();
		expect(h.deps.showWindow).not.toHaveBeenCalled();
		expect(h.deps.loginItem.ensureRegisteredOnce).not.toHaveBeenCalled();
		expect(h.deps.notifications.setClickHandler).not.toHaveBeenCalled();
		expect(h.app.exit).not.toHaveBeenCalled();
	});

	it('sets userData before taking the lock (the lock is keyed by userData)', async () => {
		const h = harness();
		await runDesktop(h.deps);
		expect(h.app.setPath).toHaveBeenCalledWith('userData', USER_DATA);
		expect(h.log.indexOf('setPath:userData')).toBeGreaterThanOrEqual(0);
		expect(h.log.indexOf('setPath:userData')).toBeLessThan(h.log.indexOf('lock'));
	});

	it('second-instance shows the window, reopening it after it was closed', async () => {
		const h = harness();
		await runDesktop(h.deps);
		expect(h.windowsCreated).toBe(1);
		h.windowOpen = false; // the user closed it
		h.app.emit('second-instance', {}, ['electron', '.'], '/');
		expect(h.deps.showWindow).toHaveBeenLastCalledWith(ORIGIN);
		expect(h.windowsCreated).toBe(2);
		h.app.emit('second-instance', {}, [], '/');
		expect(h.windowsCreated).toBe(2);
		expect(h.deps.showWindow).toHaveBeenCalledTimes(3);
	});

	it('second-instance during startup of a login launch shows the window once ready', async () => {
		const h = harness({ loginLaunch: true, whenReadyPending: true });
		const run = runDesktop(h.deps);
		h.app.emit('second-instance', {}, [], '/');
		expect(h.deps.showWindow).not.toHaveBeenCalled();
		h.ready.resolve();
		await run;
		expect(h.deps.showWindow).toHaveBeenCalledTimes(1);
		expect(h.windowsCreated).toBe(1);
	});

	it('activate with no window (macOS Dock click) shows it', async () => {
		const h = harness();
		await runDesktop(h.deps);
		h.windowOpen = false;
		h.app.emit('activate', {}, false);
		expect(h.deps.showWindow).toHaveBeenCalledTimes(2);
		expect(h.windowsCreated).toBe(2);
	});
});

describe('closing the window', () => {
	const realPlatform = process.platform;
	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: realPlatform });
	});

	it.each(['win32', 'linux', 'darwin'] as const)(
		'window-all-closed on %s keeps the app, server and scheduler running',
		async (platform) => {
			Object.defineProperty(process, 'platform', { value: platform });
			const h = harness();
			await runDesktop(h.deps);
			expect(h.app.has('window-all-closed')).toBe(true);
			h.windowOpen = false;
			h.app.emit('window-all-closed');
			await settle();
			expect(h.app.quit).not.toHaveBeenCalled();
			expect(h.app.exit).not.toHaveBeenCalled();
			expect(h.runtime.stop).not.toHaveBeenCalled();
			expect(h.runtime.closeDb).not.toHaveBeenCalled();
			expect(h.server.close).not.toHaveBeenCalled();
		}
	);
});

describe('startup', () => {
	it('a normal launch creates the tray, registers login once and opens one window', async () => {
		const h = harness();
		await expect(runDesktop(h.deps)).resolves.toBe('started');
		expect(h.deps.createTray).toHaveBeenCalledTimes(1);
		expect(h.deps.loginItem.ensureRegisteredOnce).toHaveBeenCalledTimes(1);
		expect(h.deps.showWindow).toHaveBeenCalledTimes(1);
		expect(h.deps.showWindow).toHaveBeenCalledWith(ORIGIN);
		expect(h.windowsCreated).toBe(1);
		expect(h.deps.loadKey).toHaveBeenCalledWith(KEY_FILE);
		expect(h.deps.startServer).toHaveBeenCalledWith(KEY);
		expect(h.log).toEqual([
			'setPath:userData',
			'lock',
			'whenReady',
			'loadKey',
			'startServer',
			'readRuntime',
			'createTray',
			'ensureRegisteredOnce',
			`showWindow:${ORIGIN}`
		]);
	});

	it('a login launch is tray-only: tray and login registration, no window', async () => {
		const h = harness({ loginLaunch: true });
		await expect(runDesktop(h.deps)).resolves.toBe('started');
		expect(h.deps.createTray).toHaveBeenCalledTimes(1);
		expect(h.deps.loginItem.ensureRegisteredOnce).toHaveBeenCalledTimes(1);
		expect(h.deps.showWindow).not.toHaveBeenCalled();
		expect(h.windowsCreated).toBe(0);
	});

	it("the tray's Open shows the window and Quit calls app.quit", async () => {
		const h = harness({ loginLaunch: true });
		await runDesktop(h.deps);
		h.trayActions?.showWindow();
		expect(h.windowsCreated).toBe(1);
		h.trayActions?.quitApp();
		expect(h.app.quit).toHaveBeenCalledTimes(1);
	});
});

describe('AppUserModelId (c-6)', () => {
	it('is set once, after the lock and before the key and server', async () => {
		const h = harness({ appUserModelId: AUMID });
		await expect(runDesktop(h.deps)).resolves.toBe('started');
		expect(h.app.setAppUserModelId).toHaveBeenCalledTimes(1);
		expect(h.app.setAppUserModelId).toHaveBeenCalledWith(AUMID);
		const aumid = h.log.indexOf('aumid');
		expect(aumid).toBeGreaterThan(h.log.indexOf('lock'));
		expect(aumid).toBeLessThan(h.log.indexOf('loadKey'));
		expect(aumid).toBeLessThan(h.log.indexOf('startServer'));
	});

	it('is not set where the ID is null (macOS, Linux)', async () => {
		const h = harness({ appUserModelId: null });
		await expect(runDesktop(h.deps)).resolves.toBe('started');
		expect(h.app.setAppUserModelId).not.toHaveBeenCalled();
	});

	it('is not set by a launch that lost the lock', async () => {
		const h = harness({ lock: false, appUserModelId: AUMID });
		await expect(runDesktop(h.deps)).resolves.toBe('second-instance');
		expect(h.app.setAppUserModelId).not.toHaveBeenCalled();
	});

	it('a throwing setAppUserModelId is logged and startup carries on', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = harness({ appUserModelId: AUMID });
		vi.mocked(h.app.setAppUserModelId).mockImplementation(() => {
			throw new Error('no AUMID for you');
		});
		await expect(runDesktop(h.deps)).resolves.toBe('started');
		expect(logged).toHaveBeenCalled();
		expect(h.deps.startServer).toHaveBeenCalledTimes(1);
		expect(h.deps.createTray).toHaveBeenCalledTimes(1);
		expect(h.deps.showWindow).toHaveBeenCalledWith(ORIGIN);
		expect(h.app.exit).not.toHaveBeenCalled();
		expect(h.errorBoxes).toHaveLength(0);
	});
});

describe('notification clicks (c-2)', () => {
	it('a click after startup shows the window on its path, reopening a closed one', async () => {
		const h = harness();
		await runDesktop(h.deps);
		h.windowOpen = false; // the user closed it
		h.click('/watches/w1');
		expect(vi.mocked(h.deps.showWindow).mock.calls).toEqual([[ORIGIN], [ORIGIN, '/watches/w1']]);
		expect(h.windowsCreated).toBe(2);
	});

	it('a click on a tray-only login launch opens the window on its path', async () => {
		const h = harness({ loginLaunch: true });
		await runDesktop(h.deps);
		expect(h.deps.showWindow).not.toHaveBeenCalled();
		h.click('/watches/w1');
		expect(h.deps.showWindow).toHaveBeenCalledTimes(1);
		expect(h.deps.showWindow).toHaveBeenCalledWith(ORIGIN, '/watches/w1');
		expect(h.windowsCreated).toBe(1);
	});

	it.each([
		['a normal launch', false],
		['a login launch', true]
	])('a click before startup ends is held and shown once on %s', async (_name, loginLaunch) => {
		const h = harness({ loginLaunch, whenReadyPending: true });
		const run = runDesktop(h.deps);
		h.click('/watches/w1');
		await settle();
		expect(h.deps.showWindow).not.toHaveBeenCalled();
		h.ready.resolve();
		await run;
		expect(vi.mocked(h.deps.showWindow).mock.calls).toEqual([[ORIGIN, '/watches/w1']]);
		expect(h.windowsCreated).toBe(1);
	});

	it('two clicks before startup ends show only the latest path, once', async () => {
		const h = harness({ loginLaunch: true, whenReadyPending: true });
		const run = runDesktop(h.deps);
		h.click('/watches/w1');
		h.click('/watches/w2');
		h.ready.resolve();
		await run;
		expect(vi.mocked(h.deps.showWindow).mock.calls).toEqual([[ORIGIN, '/watches/w2']]);
	});

	it('a relaunch after a held click keeps the click path', async () => {
		const h = harness({ loginLaunch: true, whenReadyPending: true });
		const run = runDesktop(h.deps);
		h.click('/watches/w1');
		h.app.emit('second-instance', {}, [], '/');
		h.ready.resolve();
		await run;
		expect(vi.mocked(h.deps.showWindow).mock.calls).toEqual([[ORIGIN, '/watches/w1']]);
	});

	it('a click after quit started opens nothing', async () => {
		const h = harness({ loginLaunch: true });
		const stopped = deferred();
		vi.mocked(h.runtime.stop).mockImplementation(() => stopped.promise);
		await runDesktop(h.deps);
		beforeQuit(h);
		await settle();
		h.click('/watches/w1');
		stopped.resolve();
		await settle();
		expect(h.app.exit).toHaveBeenCalledWith(0);
		expect(h.deps.showWindow).not.toHaveBeenCalled();
	});
});

describe('resume from sleep', () => {
	it('attaches after whenReady and runs exactly one pass per resume', async () => {
		const h = harness({ whenReadyPending: true });
		const run = runDesktop(h.deps);
		await settle();
		expect(h.powerMonitor.has('resume')).toBe(false);
		h.ready.resolve();
		await run;
		expect(h.powerMonitor.has('resume')).toBe(true);
		h.powerMonitor.emit('resume');
		expect(h.runtime.requestPass).toHaveBeenCalledTimes(1);
		h.powerMonitor.emit('resume');
		expect(h.runtime.requestPass).toHaveBeenCalledTimes(2);
	});

	it('a disabled runtime (no-op controls) or a throwing requestPass never throws', async () => {
		const h = harness();
		h.deps.readRuntime = () => ({
			requestPass: () => {},
			stop: async () => {},
			closeDb: async () => {}
		});
		await runDesktop(h.deps);
		expect(() => h.powerMonitor.emit('resume')).not.toThrow();

		const t = harness();
		vi.mocked(t.runtime.requestPass).mockImplementation(() => {
			throw new Error('boom');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await runDesktop(t.deps);
		expect(() => t.powerMonitor.emit('resume')).not.toThrow();
		expect(t.runtime.requestPass).toHaveBeenCalledTimes(1);
	});
});

describe('quit', () => {
	it('runs stop, server close, DB close, then exit(0), in that order', async () => {
		const h = harness();
		await runDesktop(h.deps);
		h.log.length = 0;
		const event = beforeQuit(h);
		expect(event.preventDefault).toHaveBeenCalled();
		await settle();
		expect(h.log).toEqual(['runtime.stop', 'server.close', 'runtime.closeDb', 'exit:0']);
		expect(h.runtime.stop).toHaveBeenCalledWith(SCHEDULER_DRAIN_MS);
		expect(h.app.exit).toHaveBeenCalledTimes(1);
	});

	it('does not exit before closeDb resolves', async () => {
		const h = harness();
		const closed = deferred();
		vi.mocked(h.runtime.closeDb).mockImplementation(() => closed.promise);
		await runDesktop(h.deps);
		beforeQuit(h);
		await settle();
		expect(h.runtime.closeDb).toHaveBeenCalledTimes(1);
		expect(h.app.exit).not.toHaveBeenCalled();
		closed.resolve();
		await settle();
		expect(h.app.exit).toHaveBeenCalledWith(0);
	});

	it('a second before-quit during shutdown is held and runs nothing again', async () => {
		const h = harness();
		const stopped = deferred();
		vi.mocked(h.runtime.stop).mockImplementation(() => stopped.promise);
		await runDesktop(h.deps);
		beforeQuit(h);
		const second = beforeQuit(h);
		expect(second.preventDefault).toHaveBeenCalled();
		stopped.resolve();
		await settle();
		expect(h.runtime.stop).toHaveBeenCalledTimes(1);
		expect(h.server.close).toHaveBeenCalledTimes(1);
		expect(h.runtime.closeDb).toHaveBeenCalledTimes(1);
		expect(h.app.exit).toHaveBeenCalledTimes(1);
	});

	it('a throwing or rejecting step still ends in exit(0), later steps still run', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = harness();
		vi.mocked(h.runtime.stop).mockImplementation(() => {
			throw new Error('stop threw');
		});
		vi.mocked(h.server.close).mockRejectedValue(new Error('close rejected'));
		await runDesktop(h.deps);
		beforeQuit(h);
		await settle();
		expect(h.runtime.closeDb).toHaveBeenCalledTimes(1);
		expect(h.app.exit).toHaveBeenCalledWith(0);
	});

	it('a second-instance or activate during shutdown opens no window', async () => {
		const h = harness();
		const stopped = deferred();
		vi.mocked(h.runtime.stop).mockImplementation(() => stopped.promise);
		await runDesktop(h.deps);
		expect(h.deps.showWindow).toHaveBeenCalledTimes(1);
		h.windowOpen = false; // the window was closed before quitting
		beforeQuit(h);
		await settle();
		// Shutdown is under way and still waiting on the scheduler.
		expect(h.app.exit).not.toHaveBeenCalled();

		h.app.emit('second-instance', {}, ['electron', '.'], '/');
		h.app.emit('activate', {}, false);
		h.trayActions?.showWindow();

		expect(h.deps.showWindow).toHaveBeenCalledTimes(1);
		expect(h.windowsCreated).toBe(1);
		stopped.resolve();
		await settle();
		expect(h.app.exit).toHaveBeenCalledWith(0);
		expect(h.deps.showWindow).toHaveBeenCalledTimes(1);
	});

	it('a rejecting closeDb still ends in exit(0)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = harness();
		vi.mocked(h.runtime.closeDb).mockRejectedValue(new Error('database is locked'));
		await runDesktop(h.deps);
		beforeQuit(h);
		await settle();
		expect(h.app.exit).toHaveBeenCalledWith(0);
	});

	it.each(['stop', 'close', 'closeDb'] as const)(
		'a %s that never settles is cut off at the shutdown deadline',
		async (which) => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const h = harness();
			const hang = () => new Promise<void>(() => {});
			if (which === 'stop') vi.mocked(h.runtime.stop).mockImplementation(hang);
			if (which === 'close') vi.mocked(h.server.close).mockImplementation(hang);
			if (which === 'closeDb') vi.mocked(h.runtime.closeDb).mockImplementation(hang);
			await runDesktop(h.deps);
			vi.useFakeTimers();
			beforeQuit(h);
			await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
			expect(h.app.exit).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(h.app.exit).toHaveBeenCalledTimes(1);
			expect(h.app.exit).toHaveBeenCalledWith(0);
		}
	);
});

describe('startup failure', () => {
	it('a bad key file shows an error naming the file, then exits 1 with no tray', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = harness();
		vi.mocked(h.deps.loadKey).mockRejectedValue(
			new Error(`alerts key file ${KEY_FILE} is not a valid key`)
		);
		await expect(runDesktop(h.deps)).resolves.toBe('failed');
		expect(h.errorBoxes).toHaveLength(1);
		expect(h.errorBoxes[0].title).toBe(STARTUP_ERROR_TITLE);
		expect(h.errorBoxes[0].content).toContain(KEY_FILE);
		expect(h.log.slice(-2)).toEqual(['showErrorBox', 'exit:1']);
		expect(h.deps.startServer).not.toHaveBeenCalled();
		expect(h.deps.createTray).not.toHaveBeenCalled();
		expect(h.deps.showWindow).not.toHaveBeenCalled();
	});

	it('a server that does not start shows an error without the key, then exits 1', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = harness();
		const leaky = `listen failed; env ALERTS_ENCRYPTION_KEY=${KEY.toString('base64')} ${KEY.toString('base64url')} ${KEY.toString('hex')}`;
		vi.mocked(h.deps.startServer).mockRejectedValue(new Error(leaky));
		await expect(runDesktop(h.deps)).resolves.toBe('failed');
		expect(h.errorBoxes).toHaveLength(1);
		const { content } = h.errorBoxes[0];
		expect(content).toContain(DB_FILE);
		expect(content).toContain('listen failed');
		expect(content).not.toContain(KEY.toString('base64'));
		expect(content).not.toContain(KEY.toString('base64url'));
		expect(content).not.toContain(KEY.toString('hex'));
		for (const call of vi.mocked(console.error).mock.calls) {
			expect(call.map(String).join(' ')).not.toContain(KEY.toString('base64'));
		}
		expect(h.log.slice(-2)).toEqual(['showErrorBox', 'exit:1']);
		expect(h.deps.createTray).not.toHaveBeenCalled();
		expect(h.deps.showWindow).not.toHaveBeenCalled();
	});

	it('a key failure leads with the key file, a server failure with the database', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		// Neither message names a path: each path in the dialog must come from its lead.
		const keyError = new Error('not a valid key');
		const serverError = new Error('listen EADDRINUSE');

		const k = harness();
		vi.mocked(k.deps.loadKey).mockRejectedValue(keyError);
		await expect(runDesktop(k.deps)).resolves.toBe('failed');
		expect(k.errorBoxes).toHaveLength(1);
		const keyLead = `The alerts key file could not be used:\n${KEY_FILE}\n\nnot a valid key`;
		expect(k.errorBoxes[0].content.slice(0, keyLead.length)).toBe(keyLead);
		expect(k.errorBoxes[0].content).not.toContain(DB_FILE);

		const s = harness();
		vi.mocked(s.deps.startServer).mockRejectedValue(serverError);
		await expect(runDesktop(s.deps)).resolves.toBe('failed');
		expect(s.errorBoxes).toHaveLength(1);
		const serverLead = `The app's server did not start. Its database is:\n${DB_FILE}\n\nlisten EADDRINUSE`;
		expect(s.errorBoxes[0].content.slice(0, serverLead.length)).toBe(serverLead);
		expect(s.errorBoxes[0].content).not.toContain(KEY_FILE);
	});

	it('an unpublished runtime is a startup failure too', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = harness();
		h.deps.readRuntime = () => {
			throw new Error('server runtime not published');
		};
		await expect(runDesktop(h.deps)).resolves.toBe('failed');
		expect(h.app.exit).toHaveBeenCalledWith(1);
		expect(h.deps.createTray).not.toHaveBeenCalled();
	});

	it('exits 1 even if the error box itself throws', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = harness();
		vi.mocked(h.deps.loadKey).mockRejectedValue(new Error('bad key'));
		vi.mocked(h.deps.dialog.showErrorBox).mockImplementation(() => {
			throw new Error('no display');
		});
		await expect(runDesktop(h.deps)).resolves.toBe('failed');
		expect(h.app.exit).toHaveBeenCalledWith(1);
	});
});

describe('update install on quit (05-release c-5, c-6)', () => {
	const ENV_NAMES = ['ALERTS_ENCRYPTION_KEY', 'DATABASE_URL', PREDECESSOR_PID_ENV] as const;
	const savedEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);
		// What loadAdapterHandler leaves in the main process's env.
		process.env.ALERTS_ENCRYPTION_KEY = KEY.toString('base64');
		process.env.DATABASE_URL = `file:${DB_FILE}`;
		delete process.env[PREDECESSOR_PID_ENV];
	});

	afterEach(() => {
		for (const name of ENV_NAMES) {
			const value = savedEnv.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	/** Runs the app and clears the startup entries from the call-order log. */
	async function started(options: HarnessOptions): Promise<Harness> {
		const h = harness(options);
		await expect(runDesktop(h.deps)).resolves.toBe('started');
		h.log.length = 0;
		return h;
	}

	function updatesOf(h: Harness): LifecycleUpdates {
		if (!h.deps.updates) throw new Error('no updates in deps');
		return h.deps.updates;
	}

	function restartToUpdate(h: Harness): void {
		if (h.trayActions === null) throw new Error('no tray created');
		h.trayActions.restartToUpdate();
	}

	it('Quit with an update pending installs it after the DB is closed, then exits', async () => {
		const h = await started({ pending: true });
		beforeQuit(h);
		await settle();
		expect(h.log).toEqual([
			'runtime.stop',
			'server.close',
			'runtime.closeDb',
			'install:quit',
			'exit:0'
		]);
		expect(updatesOf(h).installOnExit).toHaveBeenCalledTimes(1);
	});

	it('Restart to update quits once and installs in restart mode after the DB is closed', async () => {
		const h = await started({ pending: true, quitEmitsBeforeQuit: true });
		restartToUpdate(h);
		await settle();
		expect(h.log).toEqual([
			'quit',
			'runtime.stop',
			'server.close',
			'runtime.closeDb',
			'install:restart',
			'exit:0'
		]);
		expect(h.app.quit).toHaveBeenCalledTimes(1);
		expect(h.app.exit).toHaveBeenCalledTimes(1);
	});

	it('a second Restart to update while quitting changes nothing', async () => {
		const h = await started({ pending: true, quitEmitsBeforeQuit: true });
		const stopped = deferred();
		vi.mocked(h.runtime.stop).mockImplementation(() => stopped.promise);
		restartToUpdate(h);
		await settle();
		const logBefore = [...h.log];
		restartToUpdate(h);
		expect(h.log).toEqual(logBefore);
		stopped.resolve();
		await settle();
		expect(h.app.quit).toHaveBeenCalledTimes(1);
		expect(h.log.slice(-2)).toEqual(['install:restart', 'exit:0']);
		expect(h.runtime.stop).toHaveBeenCalledTimes(1);
		expect(updatesOf(h).installOnExit).toHaveBeenCalledTimes(1);
		expect(h.app.exit).toHaveBeenCalledTimes(1);
	});

	it('two Restart to update clicks before before-quit arrives call app.quit once', async () => {
		const h = await started({ pending: true });
		restartToUpdate(h);
		restartToUpdate(h);
		expect(h.app.quit).toHaveBeenCalledTimes(1);
		beforeQuit(h);
		await settle();
		expect(h.log).toEqual([
			'quit',
			'runtime.stop',
			'server.close',
			'runtime.closeDb',
			'install:restart',
			'exit:0'
		]);
	});

	it('Restart to update after Quit started keeps the quit mode and calls no quit', async () => {
		const h = await started({ pending: true, quitEmitsBeforeQuit: true });
		const stopped = deferred();
		vi.mocked(h.runtime.stop).mockImplementation(() => stopped.promise);
		beforeQuit(h);
		await settle();
		restartToUpdate(h);
		stopped.resolve();
		await settle();
		expect(h.app.quit).not.toHaveBeenCalled();
		expect(h.log.slice(-2)).toEqual(['install:quit', 'exit:0']);
	});

	it('a quit with no update pending never installs and keeps the env', async () => {
		const h = await started({ pending: false });
		beforeQuit(h);
		await settle();
		expect(h.log).toEqual(['runtime.stop', 'server.close', 'runtime.closeDb', 'exit:0']);
		expect(updatesOf(h).installOnExit).not.toHaveBeenCalled();
		expect(process.env.ALERTS_ENCRYPTION_KEY).toBe(KEY.toString('base64'));
		expect(process.env[PREDECESSOR_PID_ENV]).toBeUndefined();
	});

	it('an unpackaged run (no updates) keeps the existing quit order for Quit and Restart', async () => {
		const q = await started({});
		expect(q.deps.updates).toBeUndefined();
		beforeQuit(q);
		await settle();
		expect(q.log).toEqual(['runtime.stop', 'server.close', 'runtime.closeDb', 'exit:0']);

		const r = await started({ quitEmitsBeforeQuit: true });
		restartToUpdate(r);
		await settle();
		expect(r.log).toEqual(['quit', 'runtime.stop', 'server.close', 'runtime.closeDb', 'exit:0']);
		expect(process.env[PREDECESSOR_PID_ENV]).toBeUndefined();
	});

	it('a closeDb that hangs installs only once the shutdown deadline passes', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = await started({ pending: true });
		vi.mocked(h.runtime.closeDb).mockImplementation(() => new Promise<void>(() => {}));
		vi.useFakeTimers();
		beforeQuit(h);
		await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
		expect(updatesOf(h).installOnExit).not.toHaveBeenCalled();
		expect(h.app.exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.log.slice(-2)).toEqual(['install:quit', 'exit:0']);
		expect(updatesOf(h).installOnExit).toHaveBeenCalledTimes(1);
	});

	it('a throwing installOnExit or pending still ends in exit(0)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const i = await started({ pending: true });
		vi.mocked(updatesOf(i).installOnExit).mockImplementation(() => {
			throw new Error('installer missing');
		});
		beforeQuit(i);
		await settle();
		expect(i.app.exit).toHaveBeenCalledTimes(1);
		expect(i.app.exit).toHaveBeenCalledWith(0);

		const p = await started({ pending: true });
		vi.mocked(updatesOf(p).pending).mockImplementation(() => {
			throw new Error('no state');
		});
		beforeQuit(p);
		await settle();
		expect(updatesOf(p).installOnExit).not.toHaveBeenCalled();
		expect(p.app.exit).toHaveBeenCalledWith(0);
	});

	it('an installOnExit that hands nothing over still exits', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = await started({ pending: true });
		vi.mocked(updatesOf(h).installOnExit).mockReturnValue(false);
		beforeQuit(h);
		await settle();
		expect(h.app.exit).toHaveBeenCalledWith(0);
	});

	it('two quits install once', async () => {
		const h = await started({ pending: true });
		beforeQuit(h);
		await settle();
		beforeQuit(h);
		await settle();
		expect(updatesOf(h).installOnExit).toHaveBeenCalledTimes(1);
		expect(h.runtime.stop).toHaveBeenCalledTimes(1);
		expect(h.app.exit).toHaveBeenCalledTimes(1);
	});

	it("the installer's own app.quit() is let through and exit(0) still runs once", async () => {
		const h = await started({ pending: true });
		const installerQuit: QuitEvent[] = [];
		vi.mocked(updatesOf(h).installOnExit).mockImplementation((mode) => {
			h.log.push(`install:${mode}`);
			// electron-updater's quitAndInstall ends in app.quit(), which fires before-quit.
			installerQuit.push(beforeQuit(h));
			return true;
		});
		beforeQuit(h);
		await settle();
		expect(installerQuit).toHaveLength(1);
		expect(installerQuit[0].preventDefault).not.toHaveBeenCalled();
		expect(h.log).toEqual([
			'runtime.stop',
			'server.close',
			'runtime.closeDb',
			'install:quit',
			'exit:0'
		]);
		// One that arrives after exit (electron-updater defers its quit) is let through too.
		const late = beforeQuit(h);
		await settle();
		expect(late.preventDefault).not.toHaveBeenCalled();
		expect(h.app.exit).toHaveBeenCalledTimes(1);
	});

	it('hands over with the key and DB URL gone from the env and this pid as predecessor', async () => {
		const h = await started({ pending: true });
		const seen: Record<string, string | boolean | undefined>[] = [];
		vi.mocked(updatesOf(h).installOnExit).mockImplementation(() => {
			seen.push({
				key: process.env.ALERTS_ENCRYPTION_KEY,
				db: process.env.DATABASE_URL,
				hasKey: 'ALERTS_ENCRYPTION_KEY' in process.env,
				hasDb: 'DATABASE_URL' in process.env,
				predecessor: process.env[PREDECESSOR_PID_ENV]
			});
			return true;
		});
		beforeQuit(h);
		await settle();
		expect(seen).toEqual([
			{
				key: undefined,
				db: undefined,
				hasKey: false,
				hasDb: false,
				predecessor: String(process.pid)
			}
		]);
	});

	it('no path calls app.relaunch()', async () => {
		const q = await started({ pending: true });
		beforeQuit(q);
		const r = await started({ pending: true, quitEmitsBeforeQuit: true });
		restartToUpdate(r);
		const u = await started({ quitEmitsBeforeQuit: true });
		restartToUpdate(u);
		await settle();
		for (const h of [q, r, u]) {
			expect(h.app.exit).toHaveBeenCalledWith(0);
			expect(h.app.relaunch).not.toHaveBeenCalled();
		}
	});

	describe('macOS: Squirrel stages the update before the app exits (c-5)', () => {
		function nativeOf(h: Harness): FakeNative {
			if (h.native === null) throw new Error('no native updater in deps');
			return h.native;
		}

		it('macOS waits for Squirrel before exiting', async () => {
			const h = await started({
				platform: 'darwin',
				nativeUpdater: true,
				pending: true,
				quitEmitsBeforeQuit: true
			});
			vi.useFakeTimers();
			restartToUpdate(h);
			await settle();
			expect(h.log).toEqual([
				'quit',
				'runtime.stop',
				'server.close',
				'runtime.closeDb',
				'install:restart'
			]);
			await vi.advanceTimersByTimeAsync(SQUIRREL_STAGE_WAIT_MS - 1);
			expect(h.app.exit).not.toHaveBeenCalled();

			nativeOf(h).emit('update-downloaded');
			// electron-updater now has Squirrel install and end the app: its quit goes through.
			const installerQuit = beforeQuit(h);
			expect(installerQuit.preventDefault).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(SQUIRREL_HANDOFF_MS - 1);
			expect(h.app.exit).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(h.log.slice(-1)).toEqual(['exit:0']);
			expect(h.app.exit).toHaveBeenCalledTimes(1);
			expect(updatesOf(h).installOnExit).toHaveBeenCalledTimes(1);
		});

		it('macOS install wait times out to a normal quit', async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			const h = await started({ platform: 'darwin', nativeUpdater: true, pending: true });
			vi.useFakeTimers();
			beforeQuit(h);
			await settle();
			expect(h.log.slice(-1)).toEqual(['install:quit']);
			await vi.advanceTimersByTimeAsync(SQUIRREL_STAGE_WAIT_MS - 1);
			expect(h.app.exit).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(h.app.exit).toHaveBeenCalledTimes(1);
			expect(h.app.exit).toHaveBeenCalledWith(0);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('did not stage the update'));
			// A signal after the exit changes nothing.
			nativeOf(h).emit('update-downloaded');
			await vi.advanceTimersByTimeAsync(SQUIRREL_HANDOFF_MS);
			expect(h.app.exit).toHaveBeenCalledTimes(1);
		});

		it('a Squirrel error exits at once', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const h = await started({ platform: 'darwin', nativeUpdater: true, pending: true });
			vi.useFakeTimers();
			beforeQuit(h);
			await settle();
			expect(h.app.exit).not.toHaveBeenCalled();
			nativeOf(h).emit('error', new Error('code signature mismatch'));
			await settle();
			expect(h.app.exit).toHaveBeenCalledTimes(1);
			expect(h.app.exit).toHaveBeenCalledWith(0);
		});

		it('listens before the hand-over, so a signal raised during it counts', async () => {
			const h = await started({ platform: 'darwin', nativeUpdater: true, pending: true });
			vi.mocked(updatesOf(h).installOnExit).mockImplementation((mode) => {
				h.log.push(`install:${mode}`);
				nativeOf(h).emit('update-downloaded');
				return true;
			});
			vi.useFakeTimers();
			beforeQuit(h);
			await settle();
			await vi.advanceTimersByTimeAsync(SQUIRREL_HANDOFF_MS - 1);
			expect(h.app.exit).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(h.log.slice(-2)).toEqual(['install:quit', 'exit:0']);
		});

		it('macOS with nothing handed over exits at once', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const none = await started({ platform: 'darwin', nativeUpdater: true, pending: false });
			beforeQuit(none);
			await settle();
			expect(none.log).toEqual(['runtime.stop', 'server.close', 'runtime.closeDb', 'exit:0']);

			const refused = await started({ platform: 'darwin', nativeUpdater: true, pending: true });
			vi.mocked(updatesOf(refused).installOnExit).mockReturnValue(false);
			beforeQuit(refused);
			await settle();
			expect(refused.app.exit).toHaveBeenCalledWith(0);

			const unwired = await started({ platform: 'darwin', pending: true });
			beforeQuit(unwired);
			await settle();
			expect(unwired.log.slice(-2)).toEqual(['install:quit', 'exit:0']);
		});

		it.each(['win32', 'linux'] as const)(
			'%s exits right after the hand-over and never listens to Squirrel',
			async (platform) => {
				const q = await started({ platform, nativeUpdater: true, pending: true });
				beforeQuit(q);
				await settle();
				expect(q.log.slice(-2)).toEqual(['install:quit', 'exit:0']);

				const r = await started({
					platform,
					nativeUpdater: true,
					pending: true,
					quitEmitsBeforeQuit: true
				});
				restartToUpdate(r);
				await settle();
				expect(r.log.slice(-2)).toEqual(['install:restart', 'exit:0']);
				for (const h of [q, r]) {
					expect(nativeOf(h).has('update-downloaded')).toBe(false);
					expect(nativeOf(h).has('error')).toBe(false);
				}
			}
		);
	});
});

describe('waiting for the version an update replaced (05-release c-6)', () => {
	const PID = 4242;

	/** Starts runDesktop on fake timers and records its outcome once it settles. */
	function launch(options: HarnessOptions) {
		vi.useFakeTimers();
		const h = harness(options);
		const result: { outcome: string | null } = { outcome: null };
		const run = runDesktop(h.deps).then((outcome) => {
			result.outcome = outcome;
			return outcome;
		});
		return { h, run, result };
	}

	it('waits for the predecessor to exit, then takes the lock and starts', async () => {
		let alive = true;
		const { h, run, result } = launch({
			locks: [false, true],
			predecessorPid: PID,
			isProcessAlive: () => alive
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(result.outcome).toBeNull();
		expect(h.app.quit).not.toHaveBeenCalled();
		// Never retries the lock or starts while the old process is alive.
		expect(h.app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
		expect(h.deps.loadKey).not.toHaveBeenCalled();
		expect(h.deps.isProcessAlive).toHaveBeenCalledWith(PID);
		alive = false;
		await vi.advanceTimersByTimeAsync(PREDECESSOR_POLL_MS);
		await expect(run).resolves.toBe('started');
		expect(h.app.requestSingleInstanceLock).toHaveBeenCalledTimes(2);
		expect(h.app.quit).not.toHaveBeenCalled();
		expect(h.deps.startServer).toHaveBeenCalledTimes(1);
		expect(h.log.slice(0, 4)).toEqual(['setPath:userData', 'lock', 'lock', 'whenReady']);
	});

	it('gives up after PREDECESSOR_WAIT_MS, retries the lock once and quits if still held', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { h, run, result } = launch({
			lock: false,
			predecessorPid: PID,
			isProcessAlive: () => true
		});
		expect(PREDECESSOR_WAIT_MS).toBe(30_000);
		await vi.advanceTimersByTimeAsync(PREDECESSOR_WAIT_MS - PREDECESSOR_POLL_MS - 1);
		expect(result.outcome).toBeNull();
		expect(h.app.quit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(PREDECESSOR_POLL_MS + 1);
		expect(result.outcome).toBe('second-instance');
		await expect(run).resolves.toBe('second-instance');
		expect(h.app.requestSingleInstanceLock).toHaveBeenCalledTimes(2);
		expect(h.app.quit).toHaveBeenCalledTimes(1);
		expect(h.deps.loadKey).not.toHaveBeenCalled();
		expect(h.deps.startServer).not.toHaveBeenCalled();
	});

	it('a predecessor already gone retries the lock once; still held, it quits', async () => {
		const { h, run } = launch({
			lock: false,
			predecessorPid: PID,
			isProcessAlive: () => false
		});
		await expect(run).resolves.toBe('second-instance');
		expect(h.app.requestSingleInstanceLock).toHaveBeenCalledTimes(2);
		expect(h.deps.isProcessAlive).toHaveBeenCalledTimes(1);
		expect(h.app.quit).toHaveBeenCalledTimes(1);
		expect(h.deps.notifications.setClickHandler).not.toHaveBeenCalled();
	});

	it('a throwing isProcessAlive stops the wait and retries the lock', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { h, run } = launch({
			locks: [false, true],
			predecessorPid: PID,
			isProcessAlive: () => {
				throw new Error('EPERM');
			}
		});
		await expect(run).resolves.toBe('started');
		expect(h.app.requestSingleInstanceLock).toHaveBeenCalledTimes(2);
	});

	// Each part of the guard alone: a wait would poll a live probe (or log a missing
	// one) and ask for the lock a second time.
	it.each([
		{ name: 'predecessorPid null', predecessorPid: null, probe: true },
		{ name: 'no predecessorPid', predecessorPid: undefined, probe: true },
		{ name: 'no isProcessAlive', predecessorPid: PID, probe: false }
	])('with $name a lost lock asks for it once and quits at once', async (row) => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const alive = vi.fn(() => true);
		const { h, run, result } = launch({
			lock: false,
			predecessorPid: row.predecessorPid,
			...(row.probe ? { isProcessAlive: alive } : {})
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(result.outcome).toBe('second-instance');
		expect(alive).not.toHaveBeenCalled();
		expect(h.app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
		expect(h.app.quit).toHaveBeenCalledTimes(1);
		expect(h.log).toEqual(['setPath:userData', 'lock', 'quit']);
		expect(error).not.toHaveBeenCalled();
		await expect(run).resolves.toBe('second-instance');
	});

	it('a launch that gets the lock never asks about the predecessor', async () => {
		const { h, run } = launch({ predecessorPid: PID, isProcessAlive: () => true });
		await expect(run).resolves.toBe('started');
		expect(h.deps.isProcessAlive).not.toHaveBeenCalled();
		expect(h.app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
	});
});

// 05-release c-5: main.ts hands runDesktop the platform and Electron's own native
// autoUpdater, so the macOS install wait has Squirrel.Mac to listen to.
describe('main.ts wiring for the macOS install wait', () => {
	const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');
	const source = readFileSync(MAIN, 'utf8');
	const file = ts.createSourceFile(MAIN, source, ts.ScriptTarget.Latest, true);

	function runDesktopInput(): ts.ObjectLiteralExpression {
		const found: ts.CallExpression[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'runDesktop'
			) {
				found.push(node);
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		expect(found).toHaveLength(1);
		const input = found[0].arguments[0];
		if (!input || !ts.isObjectLiteralExpression(input))
			throw new Error('runDesktop({...}) expected');
		return input;
	}

	/** An unconditional property of the literal: assigned or shorthand, never in a spread. */
	function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
		for (const p of object.properties) {
			if (p.name?.getText(file) !== name) continue;
			if (ts.isPropertyAssignment(p)) return p.initializer;
			if (ts.isShorthandPropertyAssignment(p)) return p.name;
		}
		return undefined;
	}

	/** The local names bound to `exported` by value imports from `module`. */
	function valueImportsOf(module: string, exported: string): string[] {
		const names: string[] = [];
		for (const statement of file.statements) {
			if (!ts.isImportDeclaration(statement)) continue;
			if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
			if (statement.moduleSpecifier.text !== module) continue;
			const clause = statement.importClause;
			if (!clause || clause.isTypeOnly) continue;
			const bindings = clause.namedBindings;
			if (!bindings || !ts.isNamedImports(bindings)) continue;
			for (const element of bindings.elements) {
				if (element.isTypeOnly) continue;
				if ((element.propertyName ?? element.name).text === exported) {
					names.push(element.name.text);
				}
			}
		}
		return names;
	}

	it('passes process.platform as platform', () => {
		expect(property(runDesktopInput(), 'platform')?.getText(file)).toBe('process.platform');
	});

	it("runDesktop receives a nativeUpdater on darwin: electron's autoUpdater, unconditionally", () => {
		const native = property(runDesktopInput(), 'nativeUpdater');
		expect(native && ts.isIdentifier(native)).toBe(true);
		expect(valueImportsOf('electron', 'autoUpdater')).toContain(native?.getText(file));
	});
});
