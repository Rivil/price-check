import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { count } from 'drizzle-orm';
import { AdminExistsError, bootstrapAdmin } from './admin-bootstrap.ts';
import { createAuth } from './auth-factory.ts';
import { createDb } from './db/client.ts';
import { account, user } from './db/schema.ts';
import { createAuthHarness, type AuthHarness } from './testing/auth-harness.ts';
import { removeTempDir } from './testing/temp-dir.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = 'src/lib/server/cli/admin-create.ts';
const SECRET = 'test-only-cli-secret-0123456789abcdef0123';
const CLI_TIMEOUT_MS = 60_000;

const first = { email: 'first@example.com', name: 'First Admin', password: 'first-admin-pw' };

async function rowCounts(h: AuthHarness) {
	const [u] = await h.db.select({ n: count() }).from(user);
	const [a] = await h.db.select({ n: count() }).from(account);
	return { users: u.n, accounts: a.n };
}

function runCli(databaseUrl: string, answers: string[]) {
	const result = spawnSync(process.execPath, [CLI], {
		cwd: REPO_ROOT,
		env: { ...process.env, DATABASE_URL: databaseUrl, BETTER_AUTH_SECRET: SECRET },
		input: answers.map((a) => `${a}\n`).join(''),
		encoding: 'utf8',
		timeout: CLI_TIMEOUT_MS
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('bootstrapAdmin', () => {
	let h: AuthHarness;

	beforeEach(async () => {
		h = await createAuthHarness();
	});

	afterEach(() => {
		h.cleanup();
	});

	it('creates first admin', async () => {
		const created = await bootstrapAdmin(h.auth, h.db, first);

		expect(created.role).toBe('admin');
		expect(await rowCounts(h)).toEqual({ users: 1, accounts: 1 });
		const signedIn = await h.auth.api.signInEmail({
			body: { email: first.email, password: first.password }
		});
		expect(signedIn.user.email).toBe(first.email);
	});

	it('refuses when admin exists', async () => {
		await bootstrapAdmin(h.auth, h.db, first);
		const before = await rowCounts(h);

		await expect(
			bootstrapAdmin(h.auth, h.db, {
				email: 'second@example.com',
				name: 'Second',
				password: 'second-admin-pw'
			})
		).rejects.toBeInstanceOf(AdminExistsError);
		expect(await rowCounts(h)).toEqual(before);
	});

	it('non-admins only', async () => {
		await h.createUser({ email: 'member@example.com', role: 'user' });

		const created = await bootstrapAdmin(h.auth, h.db, first);

		expect(created.role).toBe('admin');
	});

	it('validates before write', async () => {
		await h.createUser({ email: 'taken@example.com', role: 'user' });
		const before = await rowCounts(h);

		const invalid = [
			{ ...first, password: 'x'.repeat(7) },
			{ ...first, name: '   ' },
			{ ...first, email: 'taken@example.com' }
		];
		for (const input of invalid) {
			await expect(bootstrapAdmin(h.auth, h.db, input)).rejects.toThrow();
			expect(await rowCounts(h)).toEqual(before);
		}
	});

	it(
		'real CLI process',
		async () => {
			const answers = [first.email, first.name, first.password];

			const firstRun = runCli(h.url, answers);
			expect(firstRun.stderr).not.toMatch(/error/i);
			expect(firstRun.status).toBe(0);

			const rerun = runCli(h.url, ['second@example.com', 'Second', 'second-admin-pw']);
			expect(rerun.status).toBe(1);
			expect(rerun.stderr).toContain('admin already exists');
			expect(await rowCounts(h)).toEqual({ users: 1, accounts: 1 });
		},
		CLI_TIMEOUT_MS * 2
	);

	it(
		'password not printed',
		async () => {
			const ok = runCli(h.url, [first.email, first.name, first.password]);
			const refused = runCli(h.url, ['second@example.com', 'Second', 'second-secret-pw']);
			const tooShort = runCli(h.url, ['third@example.com', 'Third', 'shortpw']);

			expect(ok.status).toBe(0);
			for (const [run, password] of [
				[ok, first.password],
				[refused, 'second-secret-pw'],
				[tooShort, 'shortpw']
			] as const) {
				expect(run.stdout).not.toContain(password);
				expect(run.stderr).not.toContain(password);
			}
		},
		CLI_TIMEOUT_MS * 3
	);

	it(
		'fresh instance',
		async () => {
			const dir = mkdtempSync(join(tmpdir(), 'apc-fresh-'));
			const file = join(dir, 'fresh.db');
			const url = `file:${file}`;
			try {
				expect(existsSync(file)).toBe(false);

				const run = runCli(url, [first.email, first.name, first.password]);
				expect(run.stderr).not.toContain('no such table');
				expect(run.status).toBe(0);

				const db = createDb(url);
				try {
					const auth = createAuth({ db, baseURL: 'http://localhost:3000', secret: SECRET });
					const signedIn = await auth.api.signInEmail({
						body: { email: first.email, password: first.password }
					});
					expect(signedIn.user.email).toBe(first.email);
				} finally {
					db.$client.close();
				}
			} finally {
				removeTempDir(dir);
			}
		},
		CLI_TIMEOUT_MS
	);
});
