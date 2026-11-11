// Runs before the e2e server starts (playwright.config.ts webServer): a fresh,
// migrated database holding exactly the seeded users and their rows. Plain Node
// type stripping: explicit .ts imports, no $app/*.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createAuth } from '../src/lib/server/auth-factory.ts';
import { createDb } from '../src/lib/server/db/client.ts';
import { alertChannel, checkFailure, pricePoint, watch } from '../src/lib/server/db/schema.ts';
import {
	E2E_ORIGIN,
	E2E_SECRET,
	SEEDED_ADMIN,
	SEEDED_DESIGN,
	SEEDED_DESIGN_TOPIC_URL,
	SEEDED_FAILURES,
	SEEDED_LONG_ACCOUNT,
	SEEDED_MEMBER,
	SEEDED_OTHER,
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
	const auth = createAuth({ db, baseURL: E2E_ORIGIN, secret: E2E_SECRET });
	const ids: Record<string, string> = {};
	// Order matters: harness 'fresh seed' counts the users created up to the member,
	// so every later seed user must come after it.
	for (const [key, { email, name, password, role }] of Object.entries({
		admin: SEEDED_ADMIN,
		member: SEEDED_MEMBER,
		other: SEEDED_OTHER,
		design: SEEDED_DESIGN,
		longAccount: SEEDED_LONG_ACCOUNT
	})) {
		const { user } = await auth.api.createUser({ body: { email, name, password, role } });
		ids[key] = user.id;
	}
	for (const seeded of Object.values(SEEDED_WATCHES)) {
		const lastCheckedAt = stamp(seeded.lastCheckedAt);
		await db.insert(watch).values({
			id: seeded.id,
			userId: ids[seeded.owner],
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
	// A legacy plaintext row with a token, as an upgraded install has it: the
	// server's startup backfill moves it into encrypted storage.
	await db.insert(alertChannel).values({
		userId: ids.design,
		ntfyUrl: SEEDED_DESIGN_TOPIC_URL,
		ntfyToken: 'tk_e2eDesignSeedToken0123456789ab' // token-shaped, test-only
	});
	process.stdout.write(`seed: ${dbFile} ready (users, watches, history, alert channel)\n`);
} finally {
	db.$client.close();
}
