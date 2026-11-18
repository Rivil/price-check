import { EventEmitter } from 'node:events';
import type { UpdateCheckResult } from 'electron-updater';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopNotifier } from '#lib/server/notify-bridge.ts';
import updaterSource from './updater.ts?raw';
import {
	UPDATE_CHECK_INTERVAL_MS,
	UPDATER_HANDLE_KEY,
	createUpdater,
	publishUpdaterHandle,
	type AutoUpdater,
	type UpdaterInput
} from './updater.ts';

const HOUR = 60 * 60 * 1000;
const realSetImmediate = globalThis.setImmediate;

/** electron-updater's autoUpdater, minus the network. Defaults mimic the library's. */
class FakeUpdater extends EventEmitter {
	autoDownload = true;
	autoInstallOnAppQuit = true;
	allowDowngrade = false;
	allowPrerelease: boolean;
	autoRunAppAfterInstall = true;
	checkForUpdates = vi.fn<() => Promise<UpdateCheckResult | null>>(() => Promise.resolve(null));
	quitAndInstall = vi.fn<(isSilent?: boolean, isForceRunAfter?: boolean) => void>();

	constructor(version = '0.1.5') {
		super();
		// The library turns prerelease on for a version with a prerelease part.
		this.allowPrerelease = version.includes('-');
	}
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function setup(overrides: Partial<UpdaterInput> & { fake?: FakeUpdater } = {}) {
	const fake = overrides.fake ?? new FakeUpdater(overrides.appVersion);
	const show = vi.fn<DesktopNotifier['show']>(() => Promise.resolve({ ok: true }));
	const onReady = vi.fn<(version: string) => void>();
	const timers = {
		setInterval: vi.fn((callback: () => void, ms: number) => setInterval(callback, ms)),
		clearInterval: vi.fn((handle: ReturnType<typeof setInterval>) => clearInterval(handle))
	};
	const log = { info: vi.fn(), error: vi.fn() };
	const input: UpdaterInput = {
		autoUpdater: fake,
		isPackaged: true,
		appVersion: '0.1.5',
		notifier: { show },
		onReady,
		timers,
		log,
		...overrides
	};
	return { fake, show, onReady, timers, log, updater: createUpdater(input) };
}

/** Lets settled promises run, and Node report any rejection left unhandled. */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
	await new Promise((resolve) => realSetImmediate(resolve));
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	delete (globalThis as { [UPDATER_HANDLE_KEY]?: unknown })[UPDATER_HANDLE_KEY];
});

describe('createUpdater, unpackaged', () => {
	it('never checks, touches the updater or schedules a timer', async () => {
		const touched: PropertyKey[] = [];
		const target = new FakeUpdater();
		const spy = new Proxy(target, {
			get(obj, key, receiver) {
				touched.push(key);
				return Reflect.get(obj, key, receiver);
			},
			set(obj, key, value, receiver) {
				touched.push(key);
				return Reflect.set(obj, key, value, receiver);
			}
		});
		const { timers, updater } = setup({ isPackaged: false, autoUpdater: spy as AutoUpdater });

		updater.start();
		await updater.checkNow();
		expect(updater.installOnExit('quit')).toBe(false);
		expect(updater.installOnExit('restart')).toBe(false);
		await vi.advanceTimersByTimeAsync(24 * HOUR);
		updater.stop();

		expect(touched).toEqual([]);
		expect(target.checkForUpdates).not.toHaveBeenCalled();
		expect(timers.setInterval).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(updater.status()).toEqual({ state: 'idle', version: null, notified: [] });
		expect(updater.pending()).toBe(false);
	});
});

describe('createUpdater, packaged', () => {
	it.each(['0.1.5', '0.1.5-rc.1'])(
		'%s: autoDownload on, install on quit off, no downgrade, no prerelease',
		(appVersion) => {
			const fake = new FakeUpdater(appVersion);
			fake.autoDownload = false;
			fake.autoInstallOnAppQuit = true;
			fake.allowDowngrade = true;
			expect(fake.allowPrerelease).toBe(appVersion.includes('-'));
			const { updater } = setup({ fake, appVersion });

			updater.start();

			expect(fake.autoDownload).toBe(true);
			expect(fake.autoInstallOnAppQuit).toBe(false);
			expect(fake.allowDowngrade).toBe(false);
			expect(fake.allowPrerelease).toBe(false);
			updater.stop();
		}
	);

	it("has an 'error' listener before the first check starts", () => {
		const fake = new FakeUpdater();
		let errorListeners = -1;
		fake.checkForUpdates.mockImplementation(() => {
			errorListeners = fake.listenerCount('error');
			return Promise.resolve(null);
		});
		const { updater } = setup({ fake });

		updater.start();

		expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
		expect(errorListeners).toBeGreaterThan(0);
		updater.stop();
	});

	it('survives a rejecting check, a throwing check, a failed download and an error event', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const fake = new FakeUpdater();
			fake.checkForUpdates
				.mockRejectedValueOnce(new Error('offline'))
				.mockImplementationOnce(() => {
					throw new Error('sync throw');
				})
				.mockImplementationOnce(() =>
					Promise.resolve({
						isUpdateAvailable: true,
						downloadPromise: Promise.reject(new Error('download failed'))
					} as unknown as UpdateCheckResult)
				);
			const { updater, log } = setup({
				fake,
				notifier: { show: () => Promise.reject(new Error('no daemon')) }
			});

			updater.start();
			await flush();
			expect(() => fake.emit('error', new Error('feed 404'))).not.toThrow();
			expect(() => fake.emit('update-downloaded', { version: '0.1.6' })).not.toThrow();

			await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
			await flush();
			expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
			await flush();
			expect(fake.checkForUpdates).toHaveBeenCalledTimes(3);

			await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
			await flush();
			expect(fake.checkForUpdates).toHaveBeenCalledTimes(4);
			expect(log.error).toHaveBeenCalled();
			updater.stop();
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
		expect(unhandled).toEqual([]);
	});

	it.each([
		['no result', null],
		['a null download', { isUpdateAvailable: false, downloadPromise: null }],
		['no download', { isUpdateAvailable: false }]
	])('a check that resolves with %s logs no error', async (_name, result) => {
		const fake = new FakeUpdater();
		fake.checkForUpdates.mockResolvedValue(result as UpdateCheckResult | null);
		const { updater, log } = setup({ fake });

		updater.start();
		await flush();
		await updater.checkNow();

		expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
		expect(log.error).not.toHaveBeenCalled();
		updater.stop();
	});

	it.each([
		['rejects', (error: Error) => Promise.reject(error)],
		[
			'throws',
			(error: Error) => {
				throw error;
			}
		]
	])("a check that %s is logged and returns 'checking' to 'idle'", async (_name, fail) => {
		const fake = new FakeUpdater();
		const error = new Error('offline');
		// electron-updater emits 'checking-for-update' before the check can fail.
		fake.checkForUpdates.mockImplementation(() => {
			fake.emit('checking-for-update');
			return fail(error);
		});
		const { updater, log } = setup({ fake });

		updater.start();
		await flush();

		expect(updater.status().state).toBe('idle');
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.error).toHaveBeenCalledWith('update check failed', error);
		updater.stop();
	});

	it('survives a throwing logger', async () => {
		const fake = new FakeUpdater();
		fake.checkForUpdates.mockRejectedValue(new Error('offline'));
		const throwing = () => {
			throw new Error('log down');
		};
		const { updater } = setup({ fake, log: { info: throwing, error: throwing } });

		updater.start();
		await flush();
		expect(() => fake.emit('error', new Error('x'))).not.toThrow();
		await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
		updater.stop();
	});

	it('checks at start, at exactly 6 h, and 4 times by 18 h', async () => {
		const { fake, updater } = setup();

		updater.start();
		expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * HOUR);
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(12 * HOUR);
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(4);

		updater.start();
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(4);
		updater.stop();
	});

	it('starts no check while one is pending', async () => {
		const fake = new FakeUpdater();
		const first = deferred<UpdateCheckResult | null>();
		fake.checkForUpdates.mockReturnValueOnce(first.promise);
		const { updater } = setup({ fake });

		updater.start();
		await vi.advanceTimersByTimeAsync(6 * HOUR);
		void updater.checkNow();
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

		first.resolve(null);
		await flush();
		await vi.advanceTimersByTimeAsync(6 * HOUR);
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
		updater.stop();
	});

	it('runs no check after stop()', async () => {
		const { fake, timers, updater } = setup();

		updater.start();
		updater.stop();
		expect(timers.clearInterval).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(48 * HOUR);
		await updater.checkNow();
		updater.start();

		expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('checkNow() triggers exactly one check and joins one in flight', async () => {
		const fake = new FakeUpdater();
		const { updater } = setup({ fake });
		updater.start();
		await flush();
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

		const pendingCheck = deferred<UpdateCheckResult | null>();
		fake.checkForUpdates.mockReturnValueOnce(pendingCheck.promise);
		const now = updater.checkNow();
		const joined = updater.checkNow();
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);

		pendingCheck.resolve(null);
		await now;
		await joined;
		await updater.checkNow();
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(3);
		updater.stop();
	});
});

describe('createUpdater, downloads', () => {
	it('notifies once per version and calls onReady once per version', async () => {
		const { fake, show, onReady, updater } = setup();
		updater.start();

		fake.emit('update-downloaded', { version: '0.1.6' });
		expect(show).toHaveBeenCalledTimes(1);
		const notice = show.mock.calls[0][0];
		expect(notice.body).toContain('0.1.6');
		expect(notice.body).toContain('Restart to update');
		await expect(notice.clickPath()).resolves.toBe('/');
		expect(onReady).toHaveBeenCalledTimes(1);
		expect(onReady).toHaveBeenCalledWith('0.1.6');

		fake.emit('update-downloaded', { version: '0.1.6' });
		expect(show).toHaveBeenCalledTimes(1);
		expect(onReady).toHaveBeenCalledTimes(1);
		expect(updater.status().notified).toEqual(['0.1.6']);

		fake.emit('update-downloaded', { version: '0.1.7' });
		expect(show).toHaveBeenCalledTimes(2);
		expect(show.mock.calls[1][0].body).toContain('0.1.7');
		expect(onReady).toHaveBeenLastCalledWith('0.1.7');
		expect(updater.status()).toEqual({
			state: 'downloaded',
			version: '0.1.7',
			notified: ['0.1.6', '0.1.7']
		});
		updater.stop();
	});

	it('a throwing onReady still leaves the update notified and pending', () => {
		const { fake, show, updater } = setup({
			onReady: () => {
				throw new Error('tray gone');
			}
		});
		updater.start();

		expect(() => fake.emit('update-downloaded', { version: '0.1.6' })).not.toThrow();
		expect(show).toHaveBeenCalledTimes(1);
		expect(updater.pending()).toBe(true);
		updater.stop();
	});

	it('never restarts by itself: 48 h after a download, no quitAndInstall', async () => {
		const { fake, updater } = setup();
		updater.start();
		fake.emit('update-downloaded', { version: '0.1.6' });

		await vi.advanceTimersByTimeAsync(48 * HOUR);

		expect(fake.quitAndInstall).not.toHaveBeenCalled();
		expect(updater.pending()).toBe(true);
		updater.stop();
	});

	it("status() goes 'idle' -> 'checking' -> 'downloaded'", () => {
		const { fake, updater } = setup();
		expect(updater.status()).toEqual({ state: 'idle', version: null, notified: [] });

		updater.start();
		fake.emit('checking-for-update');
		expect(updater.status()).toEqual({ state: 'checking', version: null, notified: [] });

		fake.emit('update-downloaded', { version: '0.1.6' });
		expect(updater.status()).toEqual({
			state: 'downloaded',
			version: '0.1.6',
			notified: ['0.1.6']
		});

		fake.emit('checking-for-update');
		expect(updater.status().state).toBe('downloaded');
		updater.stop();
	});

	it("an up-to-date check or an error returns 'checking' to 'idle'", () => {
		const { fake, updater } = setup();
		updater.start();

		fake.emit('checking-for-update');
		fake.emit('update-not-available');
		expect(updater.status().state).toBe('idle');

		fake.emit('checking-for-update');
		fake.emit('error', new Error('offline'));
		expect(updater.status().state).toBe('idle');
		updater.stop();
	});

	it("a later check that finds nothing, errors or fails keeps 'downloaded'", async () => {
		const fake = new FakeUpdater();
		const { log, updater } = setup({ fake });
		updater.start();
		await flush();
		fake.emit('update-downloaded', { version: '0.1.6' });
		const downloaded = { state: 'downloaded', version: '0.1.6', notified: ['0.1.6'] };

		fake.emit('checking-for-update');
		fake.emit('update-not-available');
		expect(updater.status()).toEqual(downloaded);

		fake.emit('error', new Error('feed 404'));
		expect(updater.status()).toEqual(downloaded);

		fake.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
		await updater.checkNow();
		expect(log.error).toHaveBeenCalledWith('update check failed', expect.any(Error));
		expect(updater.status()).toEqual(downloaded);
		expect(updater.pending()).toBe(true);
		updater.stop();
	});

	it('status() hands out a copy of the notified list', () => {
		const { fake, updater } = setup();
		updater.start();
		fake.emit('update-downloaded', { version: '0.1.6' });

		updater.status().notified.push('9.9.9');

		expect(updater.status().notified).toEqual(['0.1.6']);
		updater.stop();
	});
});

describe('createUpdater, installOnExit', () => {
	it("'quit' with nothing downloaded installs nothing", () => {
		const { fake, updater } = setup();
		updater.start();

		expect(updater.installOnExit('quit')).toBe(false);
		expect(updater.installOnExit('restart')).toBe(false);
		expect(fake.quitAndInstall).not.toHaveBeenCalled();
		updater.stop();
	});

	it("'quit' with a download installs silently, once, without relaunching", () => {
		const { fake, updater } = setup();
		updater.start();
		fake.emit('update-downloaded', { version: '0.1.6' });

		expect(updater.installOnExit('quit')).toBe(true);
		expect(updater.installOnExit('quit')).toBe(false);

		expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
		expect(fake.quitAndInstall).toHaveBeenCalledWith(true, false);
		expect(updater.pending()).toBe(false);
		updater.stop();
	});

	it("'restart' installs silently and relaunches", () => {
		const { fake, updater } = setup();
		updater.start();
		fake.emit('update-downloaded', { version: '0.1.6' });

		expect(updater.installOnExit('restart')).toBe(true);

		expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
		expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
		updater.stop();
	});

	/** Records autoRunAppAfterInstall as quitAndInstall sees it (MacUpdater reads it then). */
	function recordAutoRun(fake: FakeUpdater): boolean[] {
		const seen: boolean[] = [];
		fake.quitAndInstall.mockImplementation(() => {
			seen.push(fake.autoRunAppAfterInstall);
		});
		return seen;
	}

	it('macOS plain quit installs without relaunch', () => {
		const { fake, updater } = setup();
		const seen = recordAutoRun(fake);
		updater.start();
		fake.emit('update-downloaded', { version: '0.1.6' });

		expect(updater.installOnExit('quit')).toBe(true);

		expect(seen).toEqual([false]);
		expect(fake.quitAndInstall).toHaveBeenCalledWith(true, false);
		updater.stop();
	});

	it('macOS restart relaunches after install', () => {
		const fake = new FakeUpdater();
		fake.autoRunAppAfterInstall = false;
		const { updater } = setup({ fake });
		const seen = recordAutoRun(fake);
		updater.start();
		fake.emit('update-downloaded', { version: '0.1.6' });

		expect(updater.installOnExit('restart')).toBe(true);

		expect(seen).toEqual([true]);
		expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
		updater.stop();
	});

	it('a later download installs with the mode of its own exit', () => {
		const { fake, updater } = setup();
		const seen = recordAutoRun(fake);
		updater.start();
		fake.emit('update-downloaded', { version: '0.1.6' });
		expect(updater.installOnExit('quit')).toBe(true);
		fake.emit('update-downloaded', { version: '0.1.7' });
		expect(updater.installOnExit('restart')).toBe(true);
		fake.emit('update-downloaded', { version: '0.1.8' });
		expect(updater.installOnExit('quit')).toBe(true);

		expect(seen).toEqual([false, true, false]);
		updater.stop();
	});

	it('a throwing quitAndInstall does not propagate and leaves the update pending', () => {
		const { fake, log, updater } = setup();
		fake.quitAndInstall.mockImplementation(() => {
			throw new Error('installer missing');
		});
		updater.start();
		fake.emit('update-downloaded', { version: '0.1.6' });

		let result: boolean | undefined;
		expect(() => (result = updater.installOnExit('restart'))).not.toThrow();

		expect(result).toBe(false);
		expect(updater.pending()).toBe(true);
		expect(log.error).toHaveBeenCalled();
		updater.stop();
	});
});

describe('publishUpdaterHandle', () => {
	it("publishes status, restart and checkNow under Symbol.for('price-check.updater')", async () => {
		expect(UPDATER_HANDLE_KEY).toBe(Symbol.for('price-check.updater'));
		const { fake, updater } = setup();
		updater.start();
		await flush();
		const restart = vi.fn();

		publishUpdaterHandle({ status: updater.status, restart, checkNow: updater.checkNow });

		const handle = (globalThis as Record<symbol, unknown>)[Symbol.for('price-check.updater')] as {
			status(): unknown;
			restart(): void;
			checkNow(): Promise<void>;
		};
		expect(typeof handle.status).toBe('function');
		expect(typeof handle.restart).toBe('function');
		expect(typeof handle.checkNow).toBe('function');

		fake.emit('update-downloaded', { version: '0.1.6' });
		await handle.checkNow();
		fake.emit('update-downloaded', { version: '0.1.6' });
		expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
		expect(handle.status()).toEqual({
			state: 'downloaded',
			version: '0.1.6',
			notified: ['0.1.6']
		});
		handle.restart();
		expect(restart).toHaveBeenCalledTimes(1);
		updater.stop();
	});
});

describe('updater.ts source (decision update_flow: no runtime feed override)', () => {
	it('never sets a feed URL, a dev config or an update config path', () => {
		expect(updaterSource).not.toMatch(/setFeedURL|forceDevUpdateConfig|updateConfigPath/);
	});

	it('assigns no provider or url', () => {
		expect(updaterSource).not.toMatch(/\b(provider|url)\s*(:|=(?!=))/i);
	});

	it('imports electron and electron-updater as types only', () => {
		const specifier = String.raw`['"]electron(?:-updater)?(?:\/[^'"]*)?['"]`;
		const typeOnly = new RegExp(String.raw`^\s*import\s+type\b[^;]*from\s*${specifier}`, 'gm');
		const anyImport = new RegExp(String.raw`^\s*import\b[^;]*?${specifier}`, 'gm');
		expect(updaterSource.match(typeOnly)?.length ?? 0).toBe(1);
		expect(updaterSource.match(anyImport)?.length ?? 0).toBe(1);
		expect(updaterSource).not.toMatch(
			new RegExp(String.raw`\b(?:import|require)\s*\(\s*${specifier}`)
		);
		expect(updaterSource).not.toMatch(
			new RegExp(String.raw`^\s*export\b[^;]*from\s*${specifier}`, 'm')
		);
	});
});
