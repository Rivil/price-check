// Runs before the e2e server starts (playwright.config.ts webServer): a fresh,
// migrated database holding exactly one install's seeded rows — watches, history,
// failures and the ntfy channel, with no owner (decision data_scope). Plain Node
// type stripping: explicit .ts imports, no $app/*.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { saveChannel } from '../src/lib/server/alerts/channels.ts';
import { createDb } from '../src/lib/server/db/client.ts';
import { checkFailure, pricePoint, watch } from '../src/lib/server/db/schema.ts';
import {
	E2E_ALERTS_KEY,
	SEEDED_DESIGN_TOPIC_URL,
	SEEDED_FAILURES,
	SEEDED_POINTS,
	SEEDED_RELATIVE_POINTS,
	SEEDED_WATCHES,
	type Ago
} from './accounts.ts';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.startsWith('file:')) {
	throw new Error(`seed: DATABASE_URL must be a file: URL, got ${databaseUrl ?? '(unset)'}`);
}
const dbFile = resolve(databaseUrl.slice('file:'.length));

// Delete the previous run's database (and SQLite side files) so every run starts clean.
for (const suffix of ['', '-wal', '-shm', '-journal'])
	rmSync(`${dbFile}${suffix}`, { force: true });
mkdirSync(dirname(dbFile), { recursive: true });

const seededAt = Date.now();

function stamp(at: string | Ago) {
	if (at === 'one day after seeding') return new Date(seededAt + 24 * 60 * 60 * 1000);
	return new Date(typeof at === 'string' ? at : seededAt - at.msAgo);
}

const db = createDb(`file:${dbFile}`);
try {
	await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	for (const seeded of Object.values(SEEDED_WATCHES)) {
		const lastCheckedAt = stamp(seeded.lastCheckedAt);
		await db.insert(watch).values({
			id: seeded.id,
			shop: 'amazon-uk',
			productId: seeded.productId,
			canonicalUrl: `https://www.amazon.co.uk/dp/${seeded.productId}`,
			title: seeded.title,
			imageUrl: seeded.imageUrl,
			pricePence: seeded.pricePence,
			targetPence: seeded.targetPence,
			lastCheckedAt,
			lastCheckReason: seeded.lastCheckReason,
			lastCheckMessage: seeded.lastCheckMessage
		});
		if (seeded.lastCheckReason !== null) {
			await db.insert(checkFailure).values({
				id: `${seeded.id}-failure`,
				watchId: seeded.id,
				reason: seeded.lastCheckReason,
				message: seeded.lastCheckMessage,
				checkedAt: lastCheckedAt
			});
		}
	}
	for (const point of SEEDED_POINTS) {
		await db.insert(pricePoint).values({ ...point, checkedAt: new Date(point.checkedAt) });
	}
	await db.insert(pricePoint).values(
		SEEDED_RELATIVE_POINTS.map(({ msAgo, ...point }) => ({
			...point,
			checkedAt: stamp({ msAgo })
		}))
	);
	await db
		.insert(checkFailure)
		.values(SEEDED_FAILURES.map((row) => ({ ...row, checkedAt: stamp(row.checkedAt) })));
	// The install's one ntfy channel, sealed with the key the e2e server runs with.
	const saved = await saveChannel(db, Buffer.from(E2E_ALERTS_KEY, 'base64'), 'ntfy', {
		topic: SEEDED_DESIGN_TOPIC_URL,
		token: 'tk_e2eDesignSeedToken0123456789ab' // token-shaped, test-only
	});
	if (!saved.ok) throw new Error(`seed: ntfy channel refused: ${saved.message}`);
	process.stdout.write(`seed: ${dbFile} ready (watches, history, alert channel)\n`);
} finally {
	db.$client.close();
}
