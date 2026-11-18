import { building } from '$app/env';
import { DATABASE_URL } from '$app/env/private';
import { createDb, type Db } from './client.ts';

// No client while `vite build` analyses the server code: a libsql client still open
// at process exit crashes the build intermittently on Windows (0xC0000005, seen in
// 01-public-ci CI), and a build must never touch the database anyway.
if (!building && !DATABASE_URL) throw new Error('DATABASE_URL is not set');

// Stands in for the client during the build: touching it fails loudly with a clear
// message instead of a TypeError on undefined.
const buildTimeDb = new Proxy({} as Db, {
	get() {
		throw new Error('db is not available while vite build analyses the server code');
	}
});

export const db: Db = building ? buildTimeDb : createDb(DATABASE_URL);
