// The packaged smoke (05-release c-1, c-2): the app electron-builder made, launched
// from PRICE_CHECK_PACKAGED_EXE by e2e/packaged/launch-packaged.ts, on a run whose
// userData is the packaged app's own dir (see that file's header).
//
// Launch 1 opens on an empty watchlist served by the app itself, as a packaged app,
// with libsql's native binary loaded from app.asar.unpacked; its offline update check
// (the CI build's loopback feed, nothing listening) neither ends the app nor breaks
// the window. Between launches seed-child inserts a watch on a .invalid host, which
// no shop adapter claims (r-01). Launch 2 lists it and changes its target through the
// watch page; launch 3 shows the new target. On darwin the universal app's x86_64
// slice then serves the same watch under Rosetta.
//
// 06-remediate-security, on launch 1 and after: the app runs without the Node
// inspector (c-22), driven through the window's CDP and main's control channel only;
// on Linux that channel adds no listener (c-27); the alerts key is wrapped where
// safeStorage has a real OS backend (c-24). Launch 3 and the x86_64 slice refuse a
// request without the session cookie, and serve the watch to main's own appGet (c-3).
// A fourth launch passes --inspect=0, which the CLI inspect fuse makes the app ignore:
// Node never says its debugger is listening and main listens on no port beyond the
// server's and Chromium's remote debugging (c-8).
//
// The tests share one run and run in order: each picks up where the previous left.
import { execFile, spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { WRAPPED_PREFIX } from '../../src/desktop/alerts-key.ts';
import { insertWatches, KEY_FILE_NAME, rawRequest } from '../desktop/launch.ts';
import {
	createPackagedRun,
	launchPackaged,
	linuxTreeListenPorts,
	loadedNativeModules,
	spawnX64,
	updaterCheckNow,
	updaterStatus,
	X64_LAUNCH_TIMEOUT_MS,
	type ControlClient,
	type LaunchPackagedOptions,
	type PackagedApp,
	type PackagedRun
} from './launch-packaged.ts';

/** A URL no shop adapter claims, so nothing could ever fetch it (r-01). */
const WATCH = {
	id: 'e2e-packaged-watch',
	shop: 'e2e',
	productId: 'packaged-1',
	canonicalUrl: 'https://shop.e2e.invalid/item/packaged-1',
	title: 'E2E Packaged Kettle'
};

/** How long the app must survive its launch-time update check. */
const OFFLINE_WINDOW_MS = 15_000;

/** A Node inspector switch: --inspect, --inspect-brk, --inspect-port, ... */
const INSPECT = /^--inspect/;

/** The switch that, with the CLI inspect fuse on, starts main's inspector on any port. */
const INSPECT_ANY_PORT = '--inspect=0';

/** What Node prints once its inspector listens. */
const DEBUGGER_LISTENING = /Debugger listening/;

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), 'launch-packaged.ts');

/**
 * The session gate on a running app (c-3): without the cookie, the page and the
 * alerts data are refused; main's appGet, which carries it, gets the seeded watch.
 */
async function expectSessionGate(port: number, control: ControlClient, output: () => string) {
	for (const path of ['/', '/account/alerts/__data.json']) {
		const refused = await rawRequest(port, { path });
		expect(refused.status, `GET ${path} without the session cookie`).toBe(403);
	}
	const served = await control.appGet('/');
	expect(served.status, output()).toBe(200);
	expect(served.body).toContain(WATCH.title);
}

/**
 * Every TCP port the app's main process `pid` listens on, on any address, ascending:
 * on linux its whole tree (linuxTreeListenPorts), elsewhere main alone, which is where
 * Node's inspector would listen.
 */
async function mainListenPorts(platform: PackagedRun['platform'], pid: number): Promise<number[]> {
	if (platform === 'linux') return linuxTreeListenPorts(pid);
	const [file, args]: [string, string[]] =
		platform === 'darwin'
			? ['lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'n']]
			: [
					'powershell.exe',
					[
						'-NoProfile',
						'-NonInteractive',
						'-Command',
						`Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction Stop | ForEach-Object { $_.LocalPort }`
					]
				];
	const { stdout } = await promisify(execFile)(file, args, { encoding: 'utf8', windowsHide: true });
	// lsof -F n: one 'n<address>:<port>' line per socket; PowerShell: one port per line.
	const ports = stdout
		.split(/\r?\n/)
		.map((line) => {
			if (platform !== 'darwin') return line.trim();
			return line.startsWith('n') ? line.slice(line.lastIndexOf(':') + 1) : '';
		})
		.filter((port) => /^\d+$/.test(port))
		.map(Number);
	return [...new Set(ports)].sort((a, b) => a - b);
}

test.describe.serial('packaged app', () => {
	let run: PackagedRun;
	let current: PackagedApp | undefined;
	const pageErrors: string[] = [];

	test.beforeAll(() => {
		run = createPackagedRun();
	});

	test.afterAll(async () => {
		try {
			await current?.quit();
		} finally {
			run.dispose();
		}
	});

	const launch = async (fresh = false, options: LaunchPackagedOptions = {}) => {
		current = await launchPackaged(run, { ...options, fresh });
		current.page.on('pageerror', (error) => pageErrors.push(error.message));
		return current;
	};

	const running = () => {
		if (!current) throw new Error('launch 1 is not running');
		return current;
	};

	const quitCleanly = async () => {
		const app = current;
		if (!app) throw new Error('no app is running');
		const exit = await app.quit();
		current = undefined;
		expect(exit, `quit:\n${app.output()}`).toEqual({ code: 0, signal: null });
	};

	test('empty', async () => {
		const app = await launch(true);
		expect(app.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(app.page.url()).toBe(`${app.origin}/`);
		await expect(app.page.getByText('Nothing on your watchlist yet.')).toBeVisible();

		const info = await app.control.info();
		expect(info.isPackaged).toBe(true);
		expect(info.origin).toBe(app.origin);
		// The dir the guard checked and dispose() removes is the one the app uses. Compared
		// resolved: macOS reports the temp home as /var/..., its real path is /private/var/...
		expect(realpathSync(info.userData)).toBe(realpathSync(run.userData));
	});

	test('no inspector', async () => {
		const app = running();
		// The harness reaches main only through the control channel (c-22).
		expect(readFileSync(LAUNCHER, 'utf8')).not.toMatch(/\b_electron\b/);
		expect(app.args.filter((arg) => INSPECT.test(arg))).toEqual([]);
		// What the app itself was started with, Node's own switches included.
		const { argv, execArgv } = await app.control.info();
		for (const [name, args] of [
			['argv', argv],
			['execArgv', execArgv]
		] as const) {
			const inspect = args.filter((arg) => INSPECT.test(arg));
			expect(inspect, `${name}: ${args.join(' ')}`).toEqual([]);
		}
	});

	test('no extra listener', async () => {
		test.skip(run.platform !== 'linux', 'ss and /proc show every listener of the app on Linux');
		const app = running();
		// The server and Chromium's remote debugging only: the control channel adds none (c-27).
		const expected = [Number(new URL(app.origin).port), app.devtoolsPort].sort((a, b) => a - b);
		expect(await linuxTreeListenPorts(app.pid)).toEqual(expected);
	});

	test('key wrapped', async () => {
		const app = running();
		const keyFile = join(run.userData, KEY_FILE_NAME);
		const text = readFileSync(keyFile, 'utf8').trim();
		const raw = /^[A-Za-z0-9+/]{43}=$/.test(text) && Buffer.from(text, 'base64').length === 32;
		const { available, backend } = (await app.control.send({ cmd: 'keyBackend' })) as {
			available: boolean;
			backend: string | null;
		};
		if (run.platform !== 'linux') {
			// The macOS mock keychain and Windows DPAPI are real backends (c-24).
			expect(available).toBe(true);
			expect(raw, 'the key file holds the raw key').toBe(false);
			expect(text.startsWith(WRAPPED_PREFIX)).toBe(true);
			return;
		}
		if (available && backend !== null && /^(gnome_libsecret|kwallet\d*)$/.test(backend)) {
			expect(text.startsWith(WRAPPED_PREFIX), `wrapped on ${backend}`).toBe(true);
			return;
		}
		// basic_text (or no encryption): wrapping would protect nothing, so the key stays raw.
		expect(raw, `raw on ${backend}`).toBe(true);
		expect(statSync(keyFile).mode & 0o777).toBe(0o600);
	});

	test('libsql outside asar', async () => {
		const app = running();
		const { platform, arch } = await app.control.info();
		const nativeModules = await loadedNativeModules(run.platform, app.pid);
		const libsql = nativeModules.filter((path) => /[\\/]@libsql[\\/]/.test(path));
		const unpacked = `${sep}app.asar.unpacked${sep}node_modules${sep}@libsql${sep}`;
		const own = libsql.filter((path) => path.includes(`${unpacked}${platform}-${arch}`));
		expect(own, `libsql native modules: ${JSON.stringify(libsql)}`).not.toHaveLength(0);
		// Nothing native comes out of the archive itself (Electron's temp-copy route).
		for (const path of nativeModules) {
			expect(path, 'a native module loaded from outside app.asar.unpacked').not.toMatch(
				/[\\/]app\.asar[\\/]/
			);
		}
		for (const path of libsql) expect(path).toContain(unpacked);
	});

	test('offline update check', async () => {
		const app = running();
		// main.ts builds the updater only when packaged, and starts it once startup is done.
		await updaterStatus(app.control);
		expect(app.output()).toContain('[updater] updates on for');
		// checkNow joins the launch check, or runs one, and waits until it has settled.
		const { state } = await updaterCheckNow(app.control);
		expect(state, `updater:\n${app.output()}`).toBe('idle');

		const wait = app.launchedAt + OFFLINE_WINDOW_MS - Date.now();
		if (wait > 0) await new Promise((done) => setTimeout(done, wait));
		expect(app.running(), `the app exited after launch:\n${app.output()}`).toBe(true);
		expect(app.page.url()).toBe(`${app.origin}/`);
		await expect(app.page.getByText('Nothing on your watchlist yet.')).toBeVisible();
		expect(pageErrors).toEqual([]);
	});

	test('persists', async () => {
		await quitCleanly();

		// Written by a child process that has exited before anything is removed (Windows EPERM).
		await insertWatches(run.userData, [WATCH]);

		const second = await launch();
		const card = second.page.locator(`li[data-watch-id="${WATCH.id}"]`);
		await expect(card).toContainText(WATCH.title);
		await second.page.goto(`${second.origin}/watches/${WATCH.id}`);
		await second.page.getByLabel('New target (£, leave empty to clear)').fill('12.34');
		await second.page.getByRole('button', { name: 'Save target' }).click();
		await expect(second.page.getByRole('status')).toHaveText('Target saved.');
		await quitCleanly();

		const third = await launch();
		const relaunched = third.page.locator(`li[data-watch-id="${WATCH.id}"]`);
		await expect(relaunched).toContainText(WATCH.title);
		await expect(relaunched.locator('p.target')).toHaveText('Target £12.34');
		await expectSessionGate(Number(new URL(third.origin).port), third.control, third.output);
		expect(pageErrors).toEqual([]);
		await quitCleanly();
	});

	test('inspector refused', async () => {
		// The switch reaches the app on top of the harness's own arguments.
		const app = await launch(false, {
			spawn: (file, args, options) => spawn(file, [...args, INSPECT_ANY_PORT], options)
		});
		const { argv } = await app.control.info();
		expect(argv, 'the app was not started with the switch').toContain(INSPECT_ANY_PORT);
		await expect(app.page.locator(`li[data-watch-id="${WATCH.id}"]`)).toContainText(WATCH.title);
		// The CLI inspect fuse is off (c-8): no inspector started, and none listens.
		expect(app.output()).not.toMatch(DEBUGGER_LISTENING);
		const expected = [Number(new URL(app.origin).port), app.devtoolsPort].sort((a, b) => a - b);
		expect(await mainListenPorts(run.platform, app.pid), app.output()).toEqual(expected);
		expect(pageErrors).toEqual([]);
		await quitCleanly();
	});

	test('x64 slice', async () => {
		test.skip(run.platform !== 'darwin', 'the universal app is macOS only');
		// A cold Rosetta start, then the requests and a graceful exit.
		test.setTimeout(X64_LAUNCH_TIMEOUT_MS + 60_000);
		const x64 = await spawnX64(run);
		try {
			await expectSessionGate(x64.port, x64.control, x64.output);
		} finally {
			await x64.kill();
		}
	});
});

test('refuses existing data', async () => {
	const run = createPackagedRun();
	// win32's userData is the real one: never create or remove it when it is already there.
	const preexisting = existsSync(run.userData);
	const sentinel = join(run.userData, 'e2e-sentinel');
	let launches = 0;
	try {
		if (!preexisting) {
			mkdirSync(run.userData, { recursive: true });
			writeFileSync(sentinel, 'keep\n', 'utf8');
		}
		const before = readdirSync(run.userData).sort();
		await expect(
			launchPackaged(run, {
				fresh: true,
				spawn: () => {
					launches += 1;
					throw new Error('the guard let a launch through');
				}
			})
		).rejects.toThrow(/refused, .* already exists/);
		expect(launches).toBe(0);
		expect(run.ownsUserData).toBe(false);
		expect(readdirSync(run.userData).sort()).toEqual(before);
	} finally {
		if (!preexisting) rmSync(run.userData, { recursive: true, force: true });
		run.dispose();
	}
});
