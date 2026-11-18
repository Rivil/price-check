import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { E2E_ALERTS_KEY } from './accounts.ts';
import { freePort, nodeServerEnv, startNodeServer } from './node-server.ts';

// c-1 and c-2 on the built server (`node build`), each run on its own empty temp
// database: a fresh install opens straight on the empty watchlist, and the server
// needs only DATABASE_URL and ALERTS_ENCRYPTION_KEY — never BETTER_AUTH_SECRET or
// ORIGIN, which this process exports but the child never sees (node-server.ts
// passes an allowlist, not process.env).

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Variables a stale shell or CI could export: the server must not depend on them. */
const PARENT_ONLY = {
	BETTER_AUTH_SECRET: 'parent-only-better-auth-secret',
	ORIGIN: 'http://parent-only.e2e.invalid'
};

let dir: string;
let saved: [string, string | undefined][];

test.beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fresh-install-'));
	saved = Object.keys(PARENT_ONLY).map((name) => [name, process.env[name]]);
	Object.assign(process.env, PARENT_ONLY);
});

test.afterEach(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

test('minimal env serves every page', async () => {
	const server = await startNodeServer({
		port: await freePort(),
		dbFile: join(dir, 'fresh.db'),
		env: { ALERTS_ENCRYPTION_KEY: E2E_ALERTS_KEY }
	});
	try {
		for (const path of ['/', '/account/alerts', '/health']) {
			const res = await fetch(`${server.url}${path}`, { redirect: 'manual' });
			await res.body?.cancel();
			expect(res.status, path).toBe(200);
		}
	} finally {
		await server.stop();
	}
});

test('fresh database opens on the empty watchlist', async () => {
	const server = await startNodeServer({
		port: await freePort(),
		dbFile: join(dir, 'fresh.db'),
		env: { ALERTS_ENCRYPTION_KEY: E2E_ALERTS_KEY }
	});
	try {
		const res = await fetch(`${server.url}/`, { redirect: 'manual' });
		const html = await res.text();
		// No redirect to a login or setup page: / itself answers.
		expect(res.status).toBe(200);
		expect(new URL(res.url).pathname).toBe('/');
		expect(res.headers.get('location')).toBeNull();
		expect(html).toContain('Nothing on your watchlist yet.');
		// No login form and no session.
		expect(html).not.toMatch(/<input[^>]*type="password"/i);
		expect(res.headers.get('set-cookie')).toBeNull();
	} finally {
		await server.stop();
	}
});

for (const missing of ['ALERTS_ENCRYPTION_KEY', 'DATABASE_URL']) {
	test(`refuses to start without ${missing}`, async () => {
		const env = nodeServerEnv({
			port: await freePort(),
			dbFile: join(dir, 'fresh.db'),
			env: { ALERTS_ENCRYPTION_KEY: E2E_ALERTS_KEY }
		});
		delete env[missing];
		// A server that started would keep running until this timeout kills it, leaving
		// status null: a numeric non-zero status means it exited on its own, unready.
		const run = spawnSync(process.execPath, ['build/index.js'], {
			cwd: REPO_ROOT,
			env,
			encoding: 'utf8',
			timeout: 30_000
		});
		expect(run.signal, 'killed by the timeout: the server started').toBeNull();
		expect(run.error, 'spawn error').toBeUndefined();
		expect(run.status).toEqual(expect.any(Number));
		expect(run.status).not.toBe(0);
		expect(`${run.stdout}${run.stderr}`).toContain(missing);
	});
}
