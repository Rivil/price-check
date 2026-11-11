// No $app/* imports: run by the server's init hook. The folder is resolved from
// the working directory, not import.meta.url — the built server lives under
// build/server/chunks, while drizzle/ sits at the app root (/app in the image).
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Db } from './client.ts';

export function migrationsFolder(cwd: string = process.cwd()) {
	return resolve(cwd, 'drizzle');
}

/** Applies every pending migration; a no-op when the database is already current. */
export async function migrateDb(db: Db, folder: string = migrationsFolder()) {
	await migrate(db, { migrationsFolder: folder });
}
