// Test-only: a real better-auth instance over a fresh, migrated temp-FILE SQLite
// database. Never :memory: — libsql opens a new connection per transaction, and
// an in-memory database is per-connection, so transactional writes would vanish.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createAuth } from '../auth-factory.ts';
import { createDb } from '../db/client.ts';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../drizzle', import.meta.url));
export const HARNESS_BASE_URL = 'http://localhost:3000';
export const HARNESS_PASSWORD = 'correct-horse-battery';
const HARNESS_SECRET = 'test-only-harness-secret-0123456789abcdef';

export interface HarnessUserInput {
	email: string;
	name?: string;
	password?: string;
	role?: 'user' | 'admin';
}

export interface HarnessRequestInit {
	method?: 'GET' | 'POST';
	body?: unknown;
	cookie?: string;
}

export async function createAuthHarness() {
	const dir = mkdtempSync(join(tmpdir(), 'apc-auth-'));
	const file = join(dir, 'auth.db');
	const url = `file:${file}`;
	const db = createDb(url);
	await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	const auth = createAuth({ db, baseURL: HARNESS_BASE_URL, secret: HARNESS_SECRET });

	/** Headerless server call: the admin plugin allows it with no session (trusted caller). */
	async function createUser({ email, name, password, role }: HarnessUserInput) {
		const { user } = await auth.api.createUser({
			body: {
				email,
				name: name ?? email,
				password: password ?? HARNESS_PASSWORD,
				role: role ?? 'user'
			}
		});
		return user;
	}

	/** Signs in and returns the session cookie as a request `cookie` header value. */
	async function signIn(email: string, password: string = HARNESS_PASSWORD) {
		const { headers, response } = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true
		});
		const cookie = headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ');
		return { cookie, headers: new Headers({ cookie }), token: response.token, user: response.user };
	}

	/** Drives auth.handler like an HTTP client would (same-origin). */
	function request(path: string, { method = 'GET', body, cookie }: HarnessRequestInit = {}) {
		const headers = new Headers({ origin: HARNESS_BASE_URL });
		if (cookie) headers.set('cookie', cookie);
		if (body !== undefined) headers.set('content-type', 'application/json');
		return auth.handler(
			new Request(new URL(path, HARNESS_BASE_URL), {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			})
		);
	}

	function cleanup() {
		db.$client.close();
		rmSync(dir, { recursive: true, force: true });
	}

	return { auth, db, url, file, createUser, signIn, request, cleanup };
}

export type AuthHarness = Awaited<ReturnType<typeof createAuthHarness>>;
