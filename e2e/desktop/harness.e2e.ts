// Pins the desktop e2e launcher itself (spec c-1, r-01): every launch runs on a temp
// userData with an allowlisted env, the scheduler stays off unless a spec opts into
// 'unsupported-only', and that mode refuses to start against a DB holding a shop URL.
// Every test quits its app in a finally, so no Electron process outlives it.
// Windows pins (t-15): no launch argument ends in a path separator, the DB seeding
// runs outside this process so its temp userData can be removed, and a kill takes
// the whole process tree.
// The notification seam's variable is set only when a launch asks for it, so a plain
// launch always runs Electron's real Notification class.
// An unpackaged launch builds no updater (05-release c-5): main publishes no
// Symbol.for('price-check.updater') handle.
// rawRequest's timeoutMs gives up on a server that accepts and never answers, so the
// packaged update test reports a hung relaunch instead of running out its own timeout.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { databaseUrl } from '../../src/desktop/server-env.ts';
import {
	DB_FILE_NAME,
	desktopEnv,
	E2E_NOTIFY_ENV,
	electronArgs,
	INHERITED_ENV,
	KEY_FILE_NAME,
	launchDesktop,
	makeTempDir,
	rawRequest,
	REPO_ROOT,
	seedWatches,
	treeKillCommand,
	type DesktopApp
} from './launch.ts';

const PARENT_ENV = {
	DATABASE_URL: 'file:/elsewhere.db',
	ALERTS_ENCRYPTION_KEY: Buffer.from('parent-shell-alerts-key-01234567').toString('base64'),
	ORIGIN: 'http://evil.example'
};

/** Sets `vars` in this (the test) process for the duration of `run`, then restores them. */
async function withParentEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
	Object.assign(process.env, vars);
	try {
		return await run();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

const mainEnv = (desktop: DesktopApp) =>
	desktop.app.evaluate(() => ({ ...process.env }) as Record<string, string | undefined>);

test('serial workers, no web server', () => {
	expect(test.info().config.workers).toBe(1);
	expect(test.info().config.webServer).toBeNull();
});

test('launch args have no trailing separator', () => {
	expect(REPO_ROOT).not.toMatch(/[\\/]$/);
	for (const arg of electronArgs(['--login-launch'])) expect(arg).not.toMatch(/[\\/]$/);
	expect(electronArgs(['--login-launch'])).toEqual([REPO_ROOT, '--login-launch']);
});

test('kill path takes the whole tree on win32 only', () => {
	expect(treeKillCommand(4242, 'win32')).toEqual({
		file: 'taskkill',
		args: ['/pid', '4242', '/T', '/F']
	});
	expect(treeKillCommand(undefined, 'win32')).toBeUndefined();
	expect(treeKillCommand(4242, 'linux')).toBeUndefined();
	expect(treeKillCommand(4242, 'darwin')).toBeUndefined();
});

test('launcher env', async () => {
	let desktop: DesktopApp | undefined;
	try {
		desktop = await withParentEnv(PARENT_ENV, () => launchDesktop());
		const { userData } = desktop;

		// What the harness hands Electron: the allowlist and its own settings only.
		const allowed = new Set<string>([
			...INHERITED_ENV,
			'PRICE_CHECK_USER_DATA',
			'XDG_CONFIG_HOME',
			'SCHEDULER_DISABLED'
		]);
		for (const name of Object.keys(desktop.env)) expect(allowed, name).toContain(name);
		expect(desktop.env.PRICE_CHECK_USER_DATA).toBe(userData);
		// No notify option: the seam's variable is absent, not empty.
		expect(Object.keys(desktop.env)).not.toContain(E2E_NOTIFY_ENV);
		const configHome = desktop.env.XDG_CONFIG_HOME;
		expect(Object.keys(desktopEnv({ userData, configHome }))).not.toContain(E2E_NOTIFY_ENV);
		expect(desktopEnv({ userData, configHome, notify: 'record' })[E2E_NOTIFY_ENV]).toBe('record');
		expect(desktopEnv({ userData, configHome, notify: 'unsupported' })[E2E_NOTIFY_ENV]).toBe(
			'unsupported'
		);
		// What electron.launch got: the app path with no trailing separator.
		expect(desktop.args).toEqual(electronArgs());
		for (const arg of desktop.args) expect(arg).not.toMatch(/[\\/]$/);

		// What the running main process ended up with, after it set the server's env.
		const env = await mainEnv(desktop);
		expect(env.SCHEDULER_DISABLED).toBe('1');
		expect(env.DATABASE_URL).toBe(databaseUrl(join(userData, DB_FILE_NAME)));
		// The server took the alerts key at startup; main dropped it from its env after
		// (SEC-11), so neither the launcher's key nor the server's is left in main.
		expect(Object.keys(env)).not.toContain('ALERTS_ENCRYPTION_KEY');
		expect(Object.keys(env).filter((name) => name.toUpperCase() === 'ORIGIN')).toEqual([]);

		// The server still holds the key: an SMTP channel saved through the window's own
		// form reads back with its host, not as unreadable. Host is .invalid and saving
		// connects nowhere (r-01).
		const page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
		await page.goto(`${desktop.origin}/account/alerts`);
		const smtp = page.getByTestId('channel-smtp');
		await smtp.getByLabel('SMTP server host').fill('smtp.harness.invalid');
		await smtp.getByLabel('Port').fill('587');
		await smtp.getByLabel('Username').fill('e2e-harness');
		await smtp.getByLabel('Password').fill('e2e-harness-not-a-secret');
		await smtp.getByLabel('Sender address').fill('alerts@harness.invalid');
		await smtp.getByLabel('Recipient address').fill('me@harness.invalid');
		await smtp.getByRole('button', { name: 'Save SMTP settings' }).click();
		await expect(smtp.getByRole('status')).toHaveText('Saved.');
		await page.reload();
		await expect(smtp.getByTestId('current-smtp')).toContainText('smtp.harness.invalid');
		await expect(smtp.getByTestId('current-smtp')).not.toContainText('could not be read');
		await expect(smtp.getByTestId('password-state')).toHaveText('Password: set.');

		// Electron's own userData is the temp dir, and the app's files landed there.
		expect(await desktop.app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData);
		expect(existsSync(join(userData, KEY_FILE_NAME))).toBe(true);
		expect(existsSync(join(userData, DB_FILE_NAME))).toBe(true);
		expect(existsSync('/elsewhere.db')).toBe(false);

		// The listening line named a real loopback port.
		expect(desktop.origin).toBe(`http://127.0.0.1:${desktop.port}`);
		const health = await rawRequest(desktop.port, {
			path: '/health',
			headers: { host: `127.0.0.1:${desktop.port}` }
		});
		expect(health.status).toBe(200);
	} finally {
		await desktop?.close();
	}
	// close() removed the temp userData it created.
	expect(desktop && existsSync(desktop.userData)).toBe(false);
});

test('scheduler unsupported-only refuses a shop URL before launch', async () => {
	const userData = makeTempDir('refused');
	try {
		await seedWatches(userData, [
			'https://shop.e2e.invalid/item/1',
			'https://www.amazon.co.uk/dp/B0HARNESS1'
		]);
		await expect(launchDesktop({ userData, scheduler: 'unsupported-only' })).rejects.toThrow(
			/refused.*https:\/\/www\.amazon\.co\.uk\/dp\/B0HARNESS1/
		);
		// Electron never ran: it would have written the alerts key on first launch.
		expect(existsSync(join(userData, KEY_FILE_NAME))).toBe(false);
		// No DB handle survives in this process: on Windows one would make this EPERM.
		rmSync(userData, { recursive: true, force: true });
		expect(existsSync(userData)).toBe(false);
	} finally {
		rmSync(userData, { recursive: true, force: true });
	}
});

test('scheduler unsupported-only leaves the scheduler on', async () => {
	const userData = makeTempDir('unsupported');
	let desktop: DesktopApp | undefined;
	try {
		await seedWatches(userData, ['https://shop.e2e.invalid/item/1']);
		desktop = await launchDesktop({ userData, scheduler: 'unsupported-only' });
		expect(desktop.env.SCHEDULER_DISABLED).toBeUndefined();
		expect((await mainEnv(desktop)).SCHEDULER_DISABLED).toBeUndefined();
	} finally {
		await desktop?.close();
		rmSync(userData, { recursive: true, force: true });
	}
});

test("electron's node major matches .node-version", async () => {
	const pinned = readFileSync(join(REPO_ROOT, '.node-version'), 'utf8').trim().replace(/^v/, '');
	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop();
		const node = await desktop.app.evaluate(() => process.versions.node);
		expect(node.split('.')[0]).toBe(pinned.split('.')[0]);
	} finally {
		await desktop?.close();
	}
});

test('rawRequest with timeoutMs gives up on a server that accepts but never answers', async () => {
	const sockets = new Set<Socket>();
	// Takes the request and never writes a byte back, as a hung app server would.
	const server = createServer(() => {});
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const { port } = server.address() as AddressInfo;
	try {
		const started = Date.now();
		let guardTimer: ReturnType<typeof setTimeout> | undefined;
		const guard = new Promise<'still waiting'>((done) => {
			guardTimer = setTimeout(() => done('still waiting'), 5_000);
		});
		const outcome = await Promise.race([
			rawRequest(port, { path: '/health', timeoutMs: 500 }).then(
				() => 'answered',
				(error: unknown) => error
			),
			guard
		]);
		clearTimeout(guardTimer);
		expect(outcome).toBeInstanceOf(Error);
		expect(String(outcome)).toContain(
			`rawRequest: no complete response from 127.0.0.1:${port}/health within 500ms`
		);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(450);
		expect(elapsed).toBeLessThan(4_000);
		// The request was destroyed, not left open on the server.
		await expect.poll(() => sockets.size, { timeout: 2_000 }).toBe(0);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((done) => server.close(() => done()));
	}
});

test('an unpackaged launch builds no updater', async () => {
	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop();
		const main = await desktop.app.evaluate(({ app }) => ({
			isPackaged: app.isPackaged,
			hasHandle: Symbol.for('price-check.updater') in globalThis
		}));
		expect(main).toEqual({ isPackaged: false, hasHandle: false });
	} finally {
		await desktop?.close();
	}
});
