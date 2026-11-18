// Test-only: a fresh, migrated temp-FILE SQLite database per call. Never :memory: —
// libsql opens a new connection per transaction, and an in-memory database is
// per-connection, so transactional writes would vanish.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from '../db/client.ts';
import { migrateDb } from '../db/migrate.ts';
import { removeTempDir } from './temp-dir.ts';

/** The repo's real drizzle/ folder, resolved from this file rather than the cwd. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

export interface TestDb {
	db: Db;
	dir: string;
	file: string;
	url: string;
	/** Closes the client, then removes the temp dir (best-effort on win32: libsql keeps the file locked). */
	dispose(): void;
}

export async function createTestDb(): Promise<TestDb> {
	const dir = mkdtempSync(join(tmpdir(), 'apc-db-'));
	const file = join(dir, 'app.db');
	const url = `file:${file}`;
	const db = createDb(url);
	await migrateDb(db, MIGRATIONS_FOLDER);

	function dispose() {
		db.$client.close();
		removeTempDir(dir);
	}

	return { db, dir, file, url, dispose };
}
