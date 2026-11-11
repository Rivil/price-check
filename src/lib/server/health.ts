// The /health probe. No $app/* imports, so it can be tested against a real temp-file
// database. The route is public, so a response says up or down and nothing else
// (decision health_body).
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './db/client.ts';
import * as schema from './db/schema.ts';
import { formatError } from './error-log.ts';

// Well under the 5s compose timeout (decision busy_read).
const BUSY_RETRY_WINDOW_MS = 1000;
const BUSY_RETRY_DELAY_MS = 100;

// From the schema, so a new table is probed without touching this file. The filter
// drops the relations auth.schema.ts also exports.
const TABLES = Object.values<unknown>(schema).filter((value): value is SQLiteTable =>
	is(value, SQLiteTable)
);

function respond(status: number, body: 'ok' | 'unavailable') {
	return Response.json({ status: body }, { status, headers: { 'cache-control': 'no-store' } });
}

/** One attempt: a pass over every table, which stops at the first failed read. */
async function readTables(db: Db) {
	for (const table of TABLES) {
		await db.select().from(table).limit(1);
	}
}

/**
 * The SQLite code on the error's cause. Drizzle wraps the driver's error, so the code
 * is never on the error itself. The pattern keeps anything but a real code out of the log.
 */
function sqliteCode(error: unknown): string | undefined {
	const cause = error instanceof Error ? error.cause : undefined;
	const code = (cause as { code?: unknown } | null | undefined)?.code;
	return typeof code === 'string' && /^SQLITE_[A-Z0-9_]+$/.test(code) ? code : undefined;
}

/** One line, so only formatError's first: the rest of its output is stack frames. */
function logFailure(error: unknown) {
	const [type] = formatError(error).split('\n', 1);
	const code = sqliteCode(error);
	console.error(`[health] read failed: ${code ? `${type} ${code}` : type}`);
}

/**
 * 200 when every table can be read, otherwise 503. Only a locked database is retried:
 * the app has no WAL or busy timeout, so a scheduler write could otherwise report the
 * site down. Anything else gives up at once.
 */
export async function healthResponse(db: Db): Promise<Response> {
	const deadline = Date.now() + BUSY_RETRY_WINDOW_MS;
	for (;;) {
		try {
			await readTables(db);
			return respond(200, 'ok');
		} catch (error) {
			if (sqliteCode(error) !== 'SQLITE_BUSY' || Date.now() >= deadline) {
				logFailure(error);
				return respond(503, 'unavailable');
			}
		}
		await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
	}
}
