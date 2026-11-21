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
//   v015      {key, smtp}         a v0.1.5 install: migrates, saves an SMTP channel
//                                 sealed under `key` (base64), writes alerts.key raw
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, inArray } from 'drizzle-orm';
import { createDb } from '../../src/lib/server/db/client.ts';
import { migrateDb, migrationsFolder } from '../../src/lib/server/db/migrate.ts';
import { notifyChannel, watch } from '../../src/lib/server/db/schema.ts';
import { saveChannel } from '../../src/lib/server/alerts/channels.ts';
import { DB_FILE_NAME, KEY_FILE_NAME } from '../../src/desktop/app-paths.ts';
import { databaseUrl } from '../../src/desktop/server-env.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OPS = ['insert', 'age', 'snapshot', 'urls', 'v015'] as const;
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
		case 'v015': {
			const input = parsed(
				(v): v is { key: string; smtp: Record<string, string> } =>
					isRecord(v) &&
					typeof v.key === 'string' &&
					isRecord(v.smtp) &&
					Object.values(v.smtp).every((field) => typeof field === 'string')
			);
			const key = Buffer.from(input.key, 'base64');
			if (key.length !== 32) throw new Error('seed-child v015: key must be 32 bytes of base64');
			await migrateDb(db, migrationsFolder(REPO_ROOT));
			const saved = await saveChannel(db, key, 'smtp', input.smtp);
			if (!saved.ok) throw new Error(`seed-child v015: SMTP channel refused: ${saved.message}`);
			// v0.1.5 wrote the key as plain base64, owner-only.
			writeFileSync(join(userData, KEY_FILE_NAME), key.toString('base64'), { mode: 0o600 });
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
