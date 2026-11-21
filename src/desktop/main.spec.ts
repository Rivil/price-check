// Pins main.ts's test-only output capture (05-release t-30, c-5). electron-updater
// starts the updated AppImage with stdio 'ignore', so the packaged update test reads
// what it printed and how it ended from a file PRICE_CHECK_E2E_OUTPUT_CAPTURE names.
// The variable is taken out of process.env before the server's env is built from it,
// and put back only for the hand-over to the installer, so the version an update
// starts captures too. What the capture writes must parse with the reader the test
// uses (scripts/process-probe.ts), and an unset variable must leave the updater as is.
//
// It also pins the session gate's wiring (06-remediate-security c-3): the secret is
// made in main and handed to the server and the cookie in memory only, and the window
// is created and loaded only after session.defaultSession.cookies.set has resolved.
// Those tests run main's own startServer and showWindow through the real runDesktop,
// with fakes for everything around them, and read the order off one call log.
//
// main.ts value-imports Electron and starts the app at module load, so Electron,
// electron-updater, runDesktop and the server are mocked: the import builds nothing
// real. The mocked runDesktop only records the deps main hands it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseCaptureRecords } from '../../scripts/process-probe.ts';
import type { DesktopOutcome, LifecycleDeps, LifecycleUpdates } from './lifecycle.ts';
import type { CaptureProcess } from './main.ts';
import mainRaw from './main.ts?raw';
import type { DesktopServerOptions } from './server.ts';
import { cookieDetails, type SessionCookieDetails } from './session-gate.ts';

/** Shared with the mock factories, which vitest hoists above everything else. */
const h = vi.hoisted(() => ({
	/** Every gate-relevant call, in the order it happened. */
	log: [] as string[],
	/** Each deps object main handed runDesktop, one per import of main.ts. */
	deps: [] as unknown[],
	realRunDesktop: null as ((deps: never) => Promise<string>) | null,
	serverOptions: [] as unknown[],
	handlerEnvs: [] as Record<string, string>[],
	cookieDetails: [] as unknown[],
	/** What the next cookies.set returns. */
	setCookie: (() => Promise.resolve()) as () => Promise<void>
}));

const ORIGIN = 'http://127.0.0.1:43210';

vi.mock('electron', () => {
	const fake = {};
	class FakeWindow {
		webContents = { setWindowOpenHandler() {}, on() {} };
		constructor() {
			h.log.push('BrowserWindow');
		}
		loadURL(url: string) {
			h.log.push(`loadURL ${url}`);
			return Promise.resolve();
		}
		on() {
			return this;
		}
		isDestroyed() {
			return false;
		}
		isMinimized() {
			return false;
		}
		restore() {}
		show() {}
		focus() {}
	}
	return {
		app: {
			getPath: () => '/tmp/price-check-main-spec',
			getVersion: () => '0.0.0',
			isPackaged: false
		},
		autoUpdater: fake,
		BrowserWindow: FakeWindow,
		dialog: { showErrorBox: () => {} },
		Menu: fake,
		Notification: fake,
		powerMonitor: fake,
		session: {
			defaultSession: {
				cookies: {
					set(details: unknown) {
						h.log.push('cookies.set');
						h.cookieDetails.push(details);
						return h.setCookie();
					}
				}
			}
		},
		shell: fake,
		Tray: fake
	};
});
vi.mock('electron-updater', () => ({ default: {} }));
vi.mock('./lifecycle.ts', async (importOriginal) => {
	const real = await importOriginal<typeof import('./lifecycle.ts')>();
	h.realRunDesktop = real.runDesktop as never;
	return {
		...real,
		runDesktop: (deps: unknown) => {
			h.deps.push(deps);
			return new Promise(() => {});
		}
	};
});
vi.mock('./server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./server.ts')>()),
	loadAdapterHandler: async (env: Record<string, string>) => {
		h.log.push('loadAdapterHandler');
		h.handlerEnvs.push({ ...env });
		return () => {};
	},
	startDesktopServer: async (options: unknown) => {
		h.log.push('startDesktopServer');
		h.serverOptions.push(options);
		return {
			server: {},
			port: 43210,
			origin: 'http://127.0.0.1:43210',
			close: async () => {
				h.log.push('server.close');
			}
		};
	}
}));

const { OUTPUT_CAPTURE_ENV, startOutputCapture, takeOutputCaptureFile, withCaptureHandOver } =
	await import('./main.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const mainSource = readFileSync(join(HERE, 'main.ts'), 'utf8');

const FILE = '/tmp/capture/output-capture.jsonl';
const AT = new Date('2026-11-18T09:00:00.000Z');

type Listener = (...args: never[]) => void;

/** A process slice whose streams record what reached them, and its listeners by event. */
function fakeProcess() {
	const written = { stdout: [] as unknown[][], stderr: [] as unknown[][] };
	const listeners = new Map<string, Listener>();
	const proc: CaptureProcess = {
		pid: 4242,
		ppid: 4200,
		argv: ['/tmp/.mount_price/price-check', '--flag'],
		stdout: {
			write: (...args) => {
				written.stdout.push(args);
				return true;
			}
		},
		stderr: {
			write: (...args) => {
				written.stderr.push(args);
				return false;
			}
		},
		on(event: string, listener: Listener) {
			listeners.set(event, listener);
			return proc;
		}
	};
	return { proc, written, listeners };
}

/** startOutputCapture over a fake process, its appended lines kept in order. */
function captured() {
	const fake = fakeProcess();
	const lines: string[] = [];
	startOutputCapture(
		FILE,
		fake.proc,
		(file, line) => {
			expect(file).toBe(FILE);
			lines.push(line);
		},
		() => AT
	);
	return { ...fake, lines };
}

describe('takeOutputCaptureFile', () => {
	it('returns the absolute file the variable names and removes it from the env', () => {
		const env: NodeJS.ProcessEnv = { [OUTPUT_CAPTURE_ENV]: FILE, PATH: '/usr/bin' };
		expect(takeOutputCaptureFile(env)).toBe(FILE);
		expect(env).toEqual({ PATH: '/usr/bin' });
	});

	it('takes a relative or empty value as no file, and still removes it', () => {
		for (const value of ['capture.jsonl', '']) {
			const env: NodeJS.ProcessEnv = { [OUTPUT_CAPTURE_ENV]: value };
			expect(takeOutputCaptureFile(env), value).toBeNull();
			expect(OUTPUT_CAPTURE_ENV in env).toBe(false);
		}
	});

	it('is null when the variable is unset', () => {
		expect(takeOutputCaptureFile({})).toBeNull();
	});
});

describe('startOutputCapture', () => {
	it('appends the start, each write, an uncaught error and the exit, each one JSON line', () => {
		const { proc, lines, listeners } = captured();
		proc.stdout.write('[desktop] listening on http://127.0.0.1:4000\n');
		proc.stderr.write(new TextEncoder().encode('lost the lock\n'));
		const error = new Error('boom');
		(listeners.get('uncaughtExceptionMonitor') as (e: Error, o: string) => void)(
			error,
			'unhandledRejection'
		);
		(listeners.get('exit') as (code: number) => void)(3);

		expect(lines.every((line) => line.endsWith('\n') && !line.slice(0, -1).includes('\n'))).toBe(
			true
		);
		expect(parseCaptureRecords(lines.join(''))).toEqual([
			{ pid: 4242, at: AT, kind: 'start', ppid: 4200, argv: proc.argv },
			{
				pid: 4242,
				at: AT,
				kind: 'stdout',
				text: '[desktop] listening on http://127.0.0.1:4000\n'
			},
			{ pid: 4242, at: AT, kind: 'stderr', text: 'lost the lock\n' },
			{ pid: 4242, at: AT, kind: 'error', origin: 'unhandledRejection', text: error.stack },
			{ pid: 4242, at: AT, kind: 'exit', code: 3 }
		]);
	});

	it('still writes every chunk through, with its arguments and result', () => {
		const { proc, written } = captured();
		const done = () => {};
		expect(proc.stdout.write('out', 'utf8', done)).toBe(true);
		const bytes = new Uint8Array([104, 105]);
		expect(proc.stderr.write(bytes)).toBe(false);
		expect(written.stdout).toEqual([['out', 'utf8', done]]);
		expect(written.stderr).toEqual([[bytes]]);
	});

	it('watches uncaught errors only through the monitor, never as a handler', () => {
		const { listeners } = captured();
		expect([...listeners.keys()].sort()).toEqual(['exit', 'uncaughtExceptionMonitor']);
	});

	it('never throws when the append fails, and the writes still go through', () => {
		const { proc, written } = fakeProcess();
		expect(() =>
			startOutputCapture(FILE, proc, () => {
				throw new Error('ENOENT');
			})
		).not.toThrow();
		expect(proc.stdout.write('still printed')).toBe(true);
		expect(written.stdout).toEqual([['still printed']]);
	});
});

describe('withCaptureHandOver', () => {
	it('passes the updater as is when there is no capture file', () => {
		const given: LifecycleUpdates = { pending: () => true, installOnExit: () => true };
		const env: NodeJS.ProcessEnv = {};
		expect(withCaptureHandOver(given, null, env)).toBe(given);
		expect(env).toEqual({});
	});

	it('puts the variable back into the env before handing over to the installer', () => {
		const env: NodeJS.ProcessEnv = {};
		/** The variable as the installer's spawn would read it, at each hand-over. */
		const seen: (string | undefined)[] = [];
		const installOnExit = vi.fn<LifecycleUpdates['installOnExit']>(() => {
			seen.push(env[OUTPUT_CAPTURE_ENV]);
			return false;
		});
		const wrapped = withCaptureHandOver({ pending: () => true, installOnExit }, FILE, env);
		expect(wrapped.pending()).toBe(true);
		expect(env[OUTPUT_CAPTURE_ENV]).toBeUndefined();
		expect(wrapped.installOnExit('restart')).toBe(false);
		expect(installOnExit).toHaveBeenCalledWith('restart');
		expect(seen).toEqual([FILE]);
	});
});

describe('main.ts wiring of the capture', () => {
	it('takes the capture file from process.env and starts it before anything else runs', () => {
		const take = mainSource.indexOf('takeOutputCaptureFile(process.env)');
		const start = mainSource.indexOf('startOutputCapture(outputCapture, process)');
		expect(take).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(take);
		for (const later of ['desktopPaths(', 'createLoginItem(', 'createUpdater(', 'runDesktop(']) {
			expect(mainSource.indexOf(later), later).toBeGreaterThan(start);
		}
	});

	it('hands runDesktop the updater through withCaptureHandOver, with the same env', () => {
		expect(mainSource).toMatch(
			/updates:\s*withCaptureHandOver\(\s*updater,\s*outputCapture,\s*process\.env\s*\)/
		);
	});

	it('names the same variable as the packaged update test', () => {
		const launcher = readFileSync(join(ROOT, 'e2e', 'packaged', 'launch-packaged.ts'), 'utf8');
		expect(launcher).toContain(`export const OUTPUT_CAPTURE_ENV = '${OUTPUT_CAPTURE_ENV}';`);
	});
});

/** A promise and the function that settles it, logging when it resolves. */
function deferredCookie() {
	let release!: () => void;
	const settled = new Promise<void>((resolve) => {
		release = () => {
			h.log.push('cookies.set resolved');
			resolve();
		};
	});
	return { settled, release };
}

/**
 * Imports main.ts afresh (a new launch, so a new secret and no window yet), then runs
 * the real runDesktop over main's deps: main's own startServer and showWindow, with
 * fakes for the app, the key, the runtime, the tray and the login item.
 */
async function launchMain(): Promise<{ outcome: Promise<DesktopOutcome> }> {
	h.log.length = 0;
	h.serverOptions.length = 0;
	h.handlerEnvs.length = 0;
	h.cookieDetails.length = 0;
	vi.resetModules();
	const before = h.deps.length;
	await import('./main.ts');
	expect(h.deps).toHaveLength(before + 1);
	const deps = h.deps.at(-1) as LifecycleDeps;
	const runtime = { requestPass() {}, stop: async () => {}, closeDb: async () => {} };
	const app = {
		setPath() {},
		requestSingleInstanceLock: () => true,
		setAppUserModelId() {},
		whenReady: async () => {},
		on: () => app,
		quit() {},
		exit: (code?: number) => h.log.push(`exit ${code}`)
	};
	const runDesktop = h.realRunDesktop as unknown as (
		deps: LifecycleDeps
	) => Promise<DesktopOutcome>;
	const outcome = runDesktop({
		...deps,
		app,
		powerMonitor: { on() {} },
		dialog: { showErrorBox: () => h.log.push('showErrorBox') },
		loadKey: async () => Buffer.alloc(32, 7),
		readRuntime: () => runtime,
		createTray: () => ({}),
		loginItem: { ensureRegisteredOnce() {}, isLoginLaunch: () => false },
		notifications: { setClickHandler() {} },
		updates: undefined
	});
	return { outcome };
}

/** The secret main handed the server; the cookie must carry the same one. */
function launchSecret(): string {
	expect(h.serverOptions).toHaveLength(1);
	const { secret } = h.serverOptions[0] as DesktopServerOptions;
	expect(typeof secret).toBe('string');
	expect(Buffer.from(secret, 'base64url').length).toBeGreaterThanOrEqual(32);
	return secret;
}

describe('main.ts wiring of the session gate', () => {
	it('creates and loads the window only after cookies.set resolves', async () => {
		const cookie = deferredCookie();
		h.setCookie = () => cookie.settled;
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const { outcome } = await launchMain();
			await vi.waitFor(() => expect(h.log).toContain('cookies.set'));
			// Give startup every chance to run ahead of the pending cookie.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(h.log).toEqual(['loadAdapterHandler', 'startDesktopServer', 'cookies.set']);

			cookie.release();
			expect(await outcome).toBe('started');

			expect(h.log).toEqual([
				'loadAdapterHandler',
				'startDesktopServer',
				'cookies.set',
				'cookies.set resolved',
				'BrowserWindow',
				`loadURL ${ORIGIN}`
			]);
			const secret = launchSecret();
			expect(h.cookieDetails).toEqual([cookieDetails(ORIGIN, secret)]);
			expect((h.cookieDetails[0] as SessionCookieDetails).value).toBe(secret);
		} finally {
			log.mockRestore();
			h.setCookie = () => Promise.resolve();
		}
	});

	it('a rejected cookies.set closes the server and opens no window', async () => {
		h.setCookie = () => Promise.reject(new Error('cookie store unavailable'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const { outcome } = await launchMain();

			expect(await outcome).toBe('failed');
			expect(h.log).toEqual([
				'loadAdapterHandler',
				'startDesktopServer',
				'cookies.set',
				'server.close',
				'showErrorBox',
				'exit 1'
			]);
		} finally {
			error.mockRestore();
			h.setCookie = () => Promise.resolve();
		}
	});

	it('each launch makes its own secret, and it reaches neither process.env nor argv', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const secrets: string[] = [];
			for (let i = 0; i < 2; i++) {
				const { outcome } = await launchMain();
				expect(await outcome).toBe('started');
				const secret = launchSecret();
				secrets.push(secret);
				const carriers = [
					...Object.values(process.env),
					...process.argv,
					...Object.values(h.handlerEnvs[0])
				];
				expect(carriers.filter((value) => value?.includes(secret))).toEqual([]);
			}
			expect(secrets[0]).not.toBe(secrets[1]);
		} finally {
			log.mockRestore();
		}
	});

	it('the source hands the secret only to the server and the cookie (?raw)', () => {
		const code = mainRaw
			.split('\n')
			.filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
			.join('\n');
		// Made once, in one place.
		expect(code.match(/createSessionSecret\(/g)).toHaveLength(1);
		const uses = code
			.split('\n')
			.filter((line) => line.includes('sessionSecret'))
			.map((line) => line.trim());
		expect(uses).toEqual([
			'const sessionSecret = createSessionSecret();',
			'const server = await startDesktopServer({ handler, secret: sessionSecret });',
			'await session.defaultSession.cookies.set(cookieDetails(server.origin, sessionSecret));'
		]);
		// Nothing writes process.env or argv at all.
		expect(code).not.toMatch(/process\.env(\.\w+|\[[^\]]+\])\s*=[^=]/);
		expect(code).not.toMatch(/process\.argv\.(push|unshift|splice)|appendSwitch|appendArgument/);
	});
});
