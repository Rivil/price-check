import type { App, Dialog, PowerMonitor } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerRuntime } from '#lib/server/runtime-bridge.ts';
import {
	runDesktop,
	SCHEDULER_DRAIN_MS,
	SHUTDOWN_DEADLINE_MS,
	STARTUP_ERROR_TITLE,
	type LifecycleApp,
	type LifecycleDeps,
	type LifecycleServer
} from './lifecycle.ts';

// Compile-time only (pnpm check): the real Electron app, powerMonitor and dialog must
// satisfy the structural deps main.ts passes in.
type RealDeps = { app: App; powerMonitor: PowerMonitor; dialog: Dialog };
const realDepsFit = (deps: RealDeps): Pick<LifecycleDeps, 'app' | 'powerMonitor' | 'dialog'> =>
	deps;
void realDepsFit;

const USER_DATA = '/data/Price Check user';
const KEY_FILE = `${USER_DATA}/alerts.key`;
const DB_FILE = `${USER_DATA}/price-check.db`;
const ORIGIN = 'http://127.0.0.1:41234';
const KEY = Buffer.from('k'.repeat(32));

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

type Harness = {
	deps: LifecycleDeps;
	log: string[];
	app: FakeEmitter & LifecycleApp;
	powerMonitor: FakeEmitter;
	runtime: ServerRuntime;
	server: LifecycleServer;
	ready: ReturnType<typeof deferred<void>>;
	/** Windows the fake showWindow created (it creates one only when none is open). */
	windowsCreated: number;
	windowOpen: boolean;
	errorBoxes: { title: string; content: string }[];
	trayActions: { showWindow(): void; quitApp(): void } | null;
};

type HarnessOptions = {
	lock?: boolean;
	loginLaunch?: boolean;
	whenReadyPending?: boolean;
};

function harness(options: HarnessOptions = {}): Harness {
	const log: string[] = [];
	const ready = deferred();
	if (!options.whenReadyPending) ready.resolve();

	const app = Object.assign(new FakeEmitter(), {
		setPath: vi.fn((name: string) => void log.push(`setPath:${name}`)),
		requestSingleInstanceLock: vi.fn(() => {
			log.push('lock');
			return options.lock ?? true;
		}),
		whenReady: vi.fn(() => {
			log.push('whenReady');
			return ready.promise;
		}),
		quit: vi.fn(() => void log.push('quit')),
		exit: vi.fn((code?: number) => void log.push(`exit:${code}`))
	}) as FakeEmitter & LifecycleApp;

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
			showWindow: vi.fn((origin: string) => {
				log.push(`showWindow:${origin}`);
				if (!h.windowOpen) {
					h.windowsCreated += 1;
					h.windowOpen = true;
				}
			}),
			loginItem: {
				ensureRegisteredOnce: vi.fn(() => {
					log.push('ensureRegisteredOnce');
					return { status: 'unpackaged' };
				}),
				isLoginLaunch: vi.fn(() => options.loginLaunch ?? false)
			}
		}
	};
	return h;
}

function beforeQuit(h: Harness): QuitEvent {
	const event = { preventDefault: vi.fn() };
	h.app.emit('before-quit', event);
	return event;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('single instance', () => {
	it('a lost lock touches no key, server, tray or window and quits', async () => {
		const h = harness({ lock: false });
		await expect(runDesktop(h.deps)).resolves.toBe('second-instance');
		expect(h.app.quit).toHaveBeenCalledTimes(1);
		expect(h.deps.loadKey).not.toHaveBeenCalled();
		expect(h.deps.startServer).not.toHaveBeenCalled();
		expect(h.deps.readRuntime).not.toHaveBeenCalled();
		expect(h.deps.createTray).not.toHaveBeenCalled();
		expect(h.deps.showWindow).not.toHaveBeenCalled();
		expect(h.deps.loginItem.ensureRegisteredOnce).not.toHaveBeenCalled();
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
