// The desktop e2e suite's DB access, run as its own short-lived Node process by
// launch.ts (insertWatches, seedWatches, ageLastChecks, dbSnapshot, watchUrls) and
// never imported by a test. On Windows a libsql handle keeps the DB file locked after
// close(), so a test process that opened it could not remove its temp userData
// (EPERM). Here the lock dies with this process, which has exited before the test
// removes anything.
//
//   node e2e/desktop/seed-child.ts <op> <userData> [<json payload>]
//
//   insert    {migrate, watches}  migrates first if asked, then inserts the watch rows
//   age       {ids, at}           sets lastCheckedAt (epoch ms) on the given watches
//   snapshot                      prints {watches, channels} as stored, as JSON
//   urls                          prints every watch's canonical URL as a JSON array
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, inArray } from 'drizzle-orm';
import { createDb } from '../../src/lib/server/db/client.ts';
import { migrateDb, migrationsFolder } from '../../src/lib/server/db/migrate.ts';
import { notifyChannel, watch } from '../../src/lib/server/db/schema.ts';
import { DB_FILE_NAME } from '../../src/desktop/app-paths.ts';
import { databaseUrl } from '../../src/desktop/server-env.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OPS = ['insert', 'age', 'snapshot', 'urls'] as const;
type Op = (typeof OPS)[number];

const [op, userData, payload] = process.argv.slice(2);
if (!userData || !OPS.includes(op as Op)) {
	throw new Error(`seed-child: usage: <${OPS.join('|')}> <userData> [<json payload>]`);
}

function parsed<T>(check: (value: unknown) => value is T): T {
	const value: unknown = JSON.parse(payload ?? 'null');
	if (!check(value)) throw new Error(`seed-child ${op}: bad payload: ${payload}`);
	return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const db = createDb(databaseUrl(join(userData, DB_FILE_NAME)));
try {
	switch (op as Op) {
		case 'insert': {
			const input = parsed(
				(v): v is { migrate: boolean; watches: (typeof watch.$inferInsert)[] } =>
					isRecord(v) &&
					typeof v.migrate === 'boolean' &&
					Array.isArray(v.watches) &&
					v.watches.every(isRecord)
			);
			if (input.migrate) await migrateDb(db, migrationsFolder(REPO_ROOT));
			if (input.watches.length > 0) await db.insert(watch).values(input.watches);
			break;
		}
		case 'age': {
			const input = parsed(
				(v): v is { ids: string[]; at: number } =>
					isRecord(v) &&
					Array.isArray(v.ids) &&
					v.ids.every((id) => typeof id === 'string') &&
					typeof v.at === 'number'
			);
			await db
				.update(watch)
				.set({ lastCheckedAt: new Date(input.at) })
				.where(inArray(watch.id, input.ids));
			break;
		}
		case 'snapshot': {
			const watches = await db.select().from(watch).orderBy(asc(watch.id));
			const channels = await db.select().from(notifyChannel).orderBy(asc(notifyChannel.kind));
			process.stdout.write(JSON.stringify({ watches, channels }));
			break;
		}
		case 'urls': {
			const rows = await db.select({ url: watch.canonicalUrl }).from(watch);
			process.stdout.write(JSON.stringify(rows.map((row) => row.url)));
			break;
		}
	}
} finally {
	db.$client.close();
}
