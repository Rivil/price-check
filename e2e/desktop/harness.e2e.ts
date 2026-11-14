// Pins the desktop e2e launcher itself (spec c-1, r-01): every launch runs on a temp
// userData with an allowlisted env, the scheduler stays off unless a spec opts into
// 'unsupported-only', and that mode refuses to start against a DB holding a shop URL.
// Every test quits its app in a finally, so no Electron process outlives it.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createDb } from '../../src/lib/server/db/client.ts';
import { migrateDb, migrationsFolder } from '../../src/lib/server/db/migrate.ts';
import { watch } from '../../src/lib/server/db/schema.ts';
import { databaseUrl } from '../../src/desktop/server-env.ts';
import {
	DB_FILE_NAME,
	INHERITED_ENV,
	KEY_FILE_NAME,
	launchDesktop,
	makeTempDir,
	rawRequest,
	REPO_ROOT,
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

/** A migrated DB in `userData` holding one watch per URL. */
async function seedWatches(userData: string, urls: string[]): Promise<void> {
	const db = createDb(databaseUrl(join(userData, DB_FILE_NAME)));
	try {
		await migrateDb(db, migrationsFolder(REPO_ROOT));
		for (const [i, url] of urls.entries()) {
			await db
				.insert(watch)
				.values({ id: `w${i}`, shop: 'e2e', productId: `p${i}`, canonicalUrl: url });
		}
	} finally {
		db.$client.close();
	}
}

const mainEnv = (desktop: DesktopApp) =>
	desktop.app.evaluate(() => ({ ...process.env }) as Record<string, string | undefined>);

test('serial workers, no web server', () => {
	expect(test.info().config.workers).toBe(1);
	expect(test.info().config.webServer).toBeNull();
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

		// What the running main process ended up with, after it set the server's env.
		const env = await mainEnv(desktop);
		expect(env.SCHEDULER_DISABLED).toBe('1');
		expect(env.DATABASE_URL).toBe(databaseUrl(join(userData, DB_FILE_NAME)));
		expect(env.ALERTS_ENCRYPTION_KEY).toBeDefined();
		expect(env.ALERTS_ENCRYPTION_KEY).not.toBe(PARENT_ENV.ALERTS_ENCRYPTION_KEY);
		expect(Buffer.from(env.ALERTS_ENCRYPTION_KEY ?? '', 'base64')).toHaveLength(32);
		expect(Object.keys(env).filter((name) => name.toUpperCase() === 'ORIGIN')).toEqual([]);

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
