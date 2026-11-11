import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { migrateDb } from '../db/migrate.ts';
import { alertChannel, notifyChannel, priceDropDelivery, user } from '../db/schema.ts';
import { MIGRATIONS_FOLDER } from '../testing/auth-harness.ts';
import { backfillLegacyNtfy } from './backfill.ts';
import { channelsFor, listChannels, loadChannelConfig, saveChannel } from './channels.ts';

// Encryption fails on demand for one user, to prove the others still move.
// nonError throws a plain object instead, as a non-Error rejection would arrive.
const control = vi.hoisted(() => ({ failFor: null as string | null, nonError: false }));
vi.mock('./crypto.ts', async (importOriginal) => {
	const real = await importOriginal<typeof import('./crypto.ts')>();
	return {
		...real,
		encryptSecret: (key: Buffer, plaintext: string, aad: string) => {
			if (control.failFor !== null && aad === real.channelAad(control.failFor, 'ntfy')) {
				if (control.nonError) throw { detail: `could not seal ${plaintext}` };
				throw new Error(`could not seal ${plaintext}`);
			}
			return real.encryptSecret(key, plaintext, aad);
		}
	};
});

const KEY = randomBytes(32);
const ALICE_TOPIC = 'https://ntfy.sh/alice-legacy-topic';
const ALICE_TOKEN = 'tk_aliceLegacyToken0123456789abcd'; // token-shaped, not a real one
const BOB_TOPIC = 'https://ntfy.sh/bob-legacy-topic';

let dir: string;
let db: Db;
let logs: string[];
const log = (message: string) => logs.push(message);

/** A database as it stood before 0007: the real migrations cut off at 0006. */
async function migrateTo0006() {
	const folder = join(dir, 'drizzle');
	cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
	const journalFile = join(folder, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
	journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 6);
	writeFileSync(journalFile, JSON.stringify(journal));
	await migrateDb(db, folder);
}

async function addUsers() {
	await db.insert(user).values([
		{ id: 'alice', name: 'Alice', email: 'alice@example.test' },
		{ id: 'bob', name: 'Bob', email: 'bob@example.test' }
	]);
}

const addLegacy = (userId: string, ntfyUrl: string, ntfyToken: string | null = null) =>
	db.insert(alertChannel).values({ userId, ntfyUrl, ntfyToken });

const legacyUsers = async () =>
	(await db.select({ userId: alertChannel.userId }).from(alertChannel)).map((r) => r.userId).sort();

const configEncOf = async (userId: string) =>
	(
		await db
			.select({ configEnc: notifyChannel.configEnc })
			.from(notifyChannel)
			.where(and(eq(notifyChannel.userId, userId), eq(notifyChannel.kind, 'ntfy')))
	)[0]?.configEnc;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'apc-backfill-ntfy-'));
	db = createDb(`file:${join(dir, 'app.db')}`);
	logs = [];
	control.failFor = null;
	control.nonError = false;
});
afterEach(() => {
	db.$client.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('backfillLegacyNtfy', () => {
	it('upgrade', async () => {
		await migrateTo0006();
		await addUsers();
		await addLegacy('alice', ALICE_TOPIC, ALICE_TOKEN);
		await db.$client.execute({
			sql: `insert into watch (id, user_id, shop, product_id, canonical_url, target_pence, alerted_at)
				values ('w1', 'alice', 'amazon-uk', 'w1', 'https://www.amazon.co.uk/dp/w1', 2000, 1700000000000)`,
			args: []
		});
		await migrateDb(db, MIGRATIONS_FOLDER);

		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 1 });

		expect(await listChannels(db, KEY, 'alice')).toEqual({
			ntfy: {
				enabled: true,
				priceDrops: true,
				checkFailures: true,
				unreadable: false,
				view: { topic: ALICE_TOPIC, tokenSet: true }
			}
		});
		const routed = await channelsFor(db, KEY, 'alice', 'price_drop');
		expect(routed.map(({ kind, config }) => ({ kind, config }))).toEqual([
			{ kind: 'ntfy', config: { url: ALICE_TOPIC, token: ALICE_TOKEN } }
		]);
		expect(
			await db
				.select({ watchId: priceDropDelivery.watchId, targetPence: priceDropDelivery.targetPence })
				.from(priceDropDelivery)
		).toEqual([{ watchId: 'w1', targetPence: 2000 }]);
		expect(await listChannels(db, KEY, 'bob')).toEqual({});
	});

	it('late legacy', async () => {
		// The e2e seed inserts its legacy row after migrating: no channel row exists yet.
		await migrateDb(db, MIGRATIONS_FOLDER);
		await addUsers();
		await addLegacy('bob', BOB_TOPIC);

		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 1 });
		expect(await loadChannelConfig(db, KEY, 'bob', 'ntfy')).toEqual({
			url: BOB_TOPIC,
			token: null
		});
		expect(await db.select().from(notifyChannel)).toMatchObject([
			{ userId: 'bob', kind: 'ntfy', enabled: true, priceDrops: true, checkFailures: true }
		]);
	});

	it('idempotent', async () => {
		await migrateDb(db, MIGRATIONS_FOLDER);
		await addUsers();
		await addLegacy('alice', ALICE_TOPIC, ALICE_TOKEN);
		await addLegacy('bob', BOB_TOPIC);
		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 2 });

		const aliceBefore = await configEncOf('alice');
		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 0 });
		expect(await configEncOf('alice')).toBe(aliceBefore);

		// Bob re-saves a new topic; a stale legacy row (say, restored from an old
		// backup) must not overwrite it — it is only scrubbed.
		expect(
			await saveChannel(db, KEY, 'bob', 'ntfy', { topic: 'https://ntfy.sh/bob-new', token: '' })
		).toEqual({ ok: true });
		const bobSaved = await configEncOf('bob');
		await addLegacy('bob', BOB_TOPIC);
		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 0 });
		expect(await legacyUsers()).toEqual([]);
		expect(await configEncOf('bob')).toBe(bobSaved);
		expect(await loadChannelConfig(db, KEY, 'bob', 'ntfy')).toEqual({
			url: 'https://ntfy.sh/bob-new',
			token: null
		});
	});

	it('partial', async () => {
		await migrateDb(db, MIGRATIONS_FOLDER);
		await addUsers();
		await addLegacy('alice', ALICE_TOPIC, ALICE_TOKEN);
		await addLegacy('bob', BOB_TOPIC);
		control.failFor = 'alice';

		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 1 });
		expect(await loadChannelConfig(db, KEY, 'bob', 'ntfy')).toEqual({
			url: BOB_TOPIC,
			token: null
		});
		expect(await configEncOf('alice')).toBeUndefined();
		// partial keeps legacy: alice's plaintext row stays until it can be moved.
		expect(await legacyUsers()).toEqual(['alice']);
		for (const line of logs) {
			for (const secret of [ALICE_TOPIC, 'alice-legacy-topic', ALICE_TOKEN, BOB_TOPIC]) {
				expect(line).not.toContain(secret);
			}
		}
		expect(logs).toContain('[alerts] could not move the ntfy channel of user alice (Error)');

		// Once encryption works again, the next start moves alice.
		control.failFor = null;
		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 1 });
		expect(await loadChannelConfig(db, KEY, 'alice', 'ntfy')).toEqual({
			url: ALICE_TOPIC,
			token: ALICE_TOKEN
		});
	});

	it('names a non-Error failure generically', async () => {
		await migrateDb(db, MIGRATIONS_FOLDER);
		await addUsers();
		await addLegacy('alice', ALICE_TOPIC, ALICE_TOKEN);
		control.failFor = 'alice';
		control.nonError = true;

		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 0 });
		expect(logs).toEqual(['[alerts] could not move the ntfy channel of user alice (error)']);
		expect(await legacyUsers()).toEqual(['alice']);
	});

	it('lossless', async () => {
		await migrateDb(db, MIGRATIONS_FOLDER);
		await addUsers();
		// Saved under an older, looser parser; today's would refuse the space.
		const oldStyle = 'https://ntfy.sh/has%20space';
		await addLegacy('alice', oldStyle);

		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 1 });
		expect(await loadChannelConfig(db, KEY, 'alice', 'ntfy')).toEqual({
			url: oldStyle,
			token: null
		});
	});

	it('log', async () => {
		await migrateDb(db, MIGRATIONS_FOLDER);
		await addUsers();
		await addLegacy('alice', ALICE_TOPIC, ALICE_TOKEN);

		await backfillLegacyNtfy(db, KEY, log);
		expect(logs).toEqual(['[alerts] moved 1 ntfy channel(s) to encrypted storage']);

		// Nothing to move: nothing logged.
		logs = [];
		await backfillLegacyNtfy(db, KEY, log);
		expect(logs).toEqual([]);
	});

	it('scrub', async () => {
		await migrateDb(db, MIGRATIONS_FOLDER);
		await addUsers();
		await addLegacy('alice', ALICE_TOPIC, ALICE_TOKEN);
		await addLegacy('bob', BOB_TOPIC);

		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 2 });
		expect(await legacyUsers()).toEqual([]);
	});

	it('no plaintext left', async () => {
		const file = join(dir, 'app.db');
		const fileBytes = () =>
			[file, `${file}-wal`, `${file}-journal`]
				.filter((path) => existsSync(path))
				.map((path) => readFileSync(path).toString('latin1'))
				.join('');

		await migrateDb(db, MIGRATIONS_FOLDER);
		await addUsers();
		await addLegacy('alice', ALICE_TOPIC, ALICE_TOKEN);
		db.$client.close();
		// Control: the plaintext really is in the file before the scrub.
		expect(fileBytes()).toContain('alice-legacy');
		expect(fileBytes()).toContain(ALICE_TOKEN);

		db = createDb(`file:${file}`);
		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 1 });
		db.$client.close();
		const after = fileBytes();
		expect(after).not.toContain('alice-legacy');
		expect(after).not.toContain(ALICE_TOKEN);
		db = createDb(`file:${file}`);
	});

	it('idempotent after scrub', async () => {
		await migrateDb(db, MIGRATIONS_FOLDER);
		await addUsers();
		await addLegacy('alice', ALICE_TOPIC, ALICE_TOKEN);
		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 1 });
		const sealed = await configEncOf('alice');

		expect(await backfillLegacyNtfy(db, KEY, log)).toEqual({ moved: 0 });
		expect(await configEncOf('alice')).toBe(sealed);
		expect(await loadChannelConfig(db, KEY, 'alice', 'ntfy')).toEqual({
			url: ALICE_TOPIC,
			token: ALICE_TOKEN
		});
	});
});
