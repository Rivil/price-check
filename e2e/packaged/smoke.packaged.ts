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
// The tests share one run and run in order: each picks up where the previous left.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import type { UpdaterHandle } from '../../src/desktop/updater.ts';
import { insertWatches, rawRequest } from '../desktop/launch.ts';
import {
	createPackagedRun,
	launchPackaged,
	spawnX64,
	X64_LAUNCH_TIMEOUT_MS,
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

const UPDATER_HANDLE_KEY = 'price-check.updater';

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

	const launch = async (fresh = false) => {
		current = await launchPackaged(run, { fresh });
		current.page.on('pageerror', (error) => pageErrors.push(error.message));
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

		const { isPackaged, userData } = await app.app.evaluate(({ app: electronApp }) => ({
			isPackaged: electronApp.isPackaged,
			userData: electronApp.getPath('userData')
		}));
		expect(isPackaged).toBe(true);
		// The dir the guard checked and dispose() removes is the one the app uses. Compared
		// resolved: macOS reports the temp home as /var/..., its real path is /private/var/...
		expect(realpathSync(userData)).toBe(realpathSync(run.userData));
	});

	test('libsql outside asar', async () => {
		const app = current;
		if (!app) throw new Error('launch 1 is not running');
		const { sharedObjects, platform, arch } = await app.app.evaluate(() => {
			const report: unknown = process.report.getReport();
			const parsed = (typeof report === 'string' ? JSON.parse(report) : report) as {
				sharedObjects?: string[];
			};
			return {
				sharedObjects: parsed.sharedObjects ?? [],
				platform: process.platform,
				arch: process.arch
			};
		});
		const nativeModules = sharedObjects.filter((path) => path.endsWith('.node'));
		const libsql = nativeModules.filter((path) => /[\\/]@libsql[\\/]/.test(path));
		const unpacked = `${sep}app.asar.unpacked${sep}node_modules${sep}@libsql${sep}`;
		const own = libsql.filter((path) => path.includes(`${unpacked}${platform}-${arch}`));
		expect(own, `libsql shared objects: ${JSON.stringify(libsql)}`).not.toHaveLength(0);
		// Nothing native comes out of the archive itself (Electron's temp-copy route).
		for (const path of nativeModules) {
			expect(path, 'a native module loaded from outside app.asar.unpacked').not.toMatch(
				/[\\/]app\.asar[\\/]/
			);
		}
		for (const path of libsql) expect(path).toContain(unpacked);
	});

	test('offline update check', async () => {
		const app = current;
		if (!app) throw new Error('launch 1 is not running');
		const published = await app.app.evaluate(
			(_electron, key) => (globalThis as Record<symbol, unknown>)[Symbol.for(key)] !== undefined,
			UPDATER_HANDLE_KEY
		);
		// main.ts publishes the handle right after updater.start(), so updates are on.
		// Its '[updater] updates on for' line is printed during startup, before
		// launchPackaged attaches to stdout (see PackagedApp.output), so it is not read.
		expect(published, 'the packaged app published no updater').toBe(true);
		// checkNow joins the launch check, or runs one, and waits until it has settled.
		const state = await app.app.evaluate(async (_electron, key) => {
			const updater = (globalThis as Record<symbol, UpdaterHandle | undefined>)[Symbol.for(key)];
			await updater?.checkNow();
			return updater?.status().state;
		}, UPDATER_HANDLE_KEY);
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
		expect(pageErrors).toEqual([]);
		await quitCleanly();
	});

	test('x64 slice', async () => {
		test.skip(run.platform !== 'darwin', 'the universal app is macOS only');
		// A cold Rosetta start, then the request and a graceful exit.
		test.setTimeout(X64_LAUNCH_TIMEOUT_MS + 60_000);
		const x64 = await spawnX64(run);
		try {
			const response = await rawRequest(x64.port);
			expect(response.status, x64.output()).toBe(200);
			expect(response.body).toContain(WATCH.title);
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
				launch: () => {
					launches += 1;
					return Promise.reject(new Error('the guard let a launch through'));
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
