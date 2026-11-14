import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { asc, eq, inArray } from 'drizzle-orm';
import playwrightConfig from '../playwright.config.ts';
import { loadChannelConfig } from '../src/lib/server/alerts/channels.ts';
import { parseTopicUrl } from '../src/lib/server/alerts/ntfy.ts';
import { createDb } from '../src/lib/server/db/client.ts';
import { checkFailure, notifyChannel, pricePoint, watch } from '../src/lib/server/db/schema.ts';
import {
	E2E_ALERTS_KEY,
	E2E_DATABASE_URL,
	SEEDED_DESIGN_TOPIC_URL,
	SEEDED_WATCHES
} from './accounts.ts';
import { freePort, startNodeServer } from './node-server.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Runs `read` against the seeded database, measuring ages from now. */
async function withDb<T>(read: (db: ReturnType<typeof createDb>) => Promise<T>) {
	const db = createDb(E2E_DATABASE_URL);
	try {
		return await read(db);
	} finally {
		db.$client.close();
	}
}

const pointsOf = (db: ReturnType<typeof createDb>, watchId: string) =>
	db
		.select()
		.from(pricePoint)
		.where(eq(pricePoint.watchId, watchId))
		.orderBy(asc(pricePoint.checkedAt));

const failuresOf = (db: ReturnType<typeof createDb>, watchId: string) =>
	db
		.select()
		.from(checkFailure)
		.where(eq(checkFailure.watchId, watchId))
		.orderBy(asc(checkFailure.checkedAt));

const ageOf = (at: Date) => Date.now() - at.getTime();

test('serial workers', () => {
	expect(test.info().config.workers).toBe(1);
});

// Runs before every route spec (e2e/ sorts first, one worker), so the database is
// still exactly what seed.ts wrote: one install's rows, no accounts (data_scope).
test('fresh seed', async () => {
	await withDb(async (db) => {
		const tables = await db.$client.execute("select name from sqlite_master where type = 'table'");
		const names = tables.rows.map((row) => String(row.name));
		expect(names).toContain('watch');
		for (const gone of ['user', 'session', 'account', 'verification']) {
			expect(names, `${gone} table`).not.toContain(gone);
		}

		const ids = (await db.select({ id: watch.id }).from(watch)).map((row) => row.id);
		expect(ids.sort()).toStrictEqual(
			Object.values(SEEDED_WATCHES)
				.map(({ id }) => id)
				.sort()
		);

		// The install's one channel, readable with the key the e2e server runs with.
		expect(await db.select({ kind: notifyChannel.kind }).from(notifyChannel)).toStrictEqual([
			{ kind: 'ntfy' }
		]);
		const key = Buffer.from(E2E_ALERTS_KEY, 'base64');
		expect(await loadChannelConfig(db, key, 'ntfy')).toMatchObject({
			url: SEEDED_DESIGN_TOPIC_URL,
			token: expect.any(String)
		});
	});
});

test('seed refuses a non-file database', () => {
	// .invalid, so a seed that stopped refusing could never reach a real server.
	const run = spawnSync(process.execPath, ['e2e/seed.ts'], {
		cwd: REPO_ROOT,
		env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'libsql://seed-guard.invalid' },
		encoding: 'utf8'
	});
	expect(run.status).not.toBe(0);
	expect(run.stderr).toContain('DATABASE_URL must be a file: URL');
});

test('design seed', async () => {
	const { layoutLong, layoutCooldown, layoutAtTarget } = SEEDED_WATCHES;
	const unbrokenAtLeast = (value: string | null | undefined, min: number, what: string) => {
		expect(value?.length ?? 0, `${what} length`).toBeGreaterThanOrEqual(min);
		expect(value, `${what} has whitespace`).not.toMatch(/\s/);
	};

	await withDb(async (db) => {
		const designIds = [layoutLong.id, layoutCooldown.id, layoutAtTarget.id];
		const rows = await db.select().from(watch).where(inArray(watch.id, designIds));
		expect(rows.map((r) => r.id).sort()).toStrictEqual([...designIds].sort());
		const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

		const long = byId[layoutLong.id];
		unbrokenAtLeast(long.title, 200, 'layoutLong title');
		unbrokenAtLeast(long.lastCheckMessage, 150, 'layoutLong failure message');
		expect(long.lastCheckReason).not.toBeNull();
		const history = await db.select().from(pricePoint).where(eq(pricePoint.watchId, long.id));
		expect(history).toHaveLength(3);

		const failures = await failuresOf(db, long.id);
		expect(failures).toHaveLength(2);
		unbrokenAtLeast(failures[1].message, 150, 'layoutLong failure row message');
		const lastPoint = Math.max(...history.map((point) => point.checkedAt.getTime()));
		for (const failure of failures) {
			expect(failure.checkedAt.getTime(), 'a success between the failures').toBeGreaterThan(
				lastPoint
			);
		}

		// In the future, so Check now is refused and can never live-fetch (r-01).
		expect(byId[layoutCooldown.id].lastCheckedAt!.getTime()).toBeGreaterThan(Date.now());

		const atTarget = byId[layoutAtTarget.id];
		expect(atTarget.lastCheckReason, 'layoutAtTarget latest check failed').toBeNull();
		expect(atTarget.pricePence).not.toBeNull();
		expect(atTarget.targetPence).not.toBeNull();
		expect(atTarget.pricePence!).toBeLessThanOrEqual(atTarget.targetPence!);

		// Image hosts are .invalid, so rendering the list never reaches Amazon (r-01).
		for (const row of rows) {
			if (row.imageUrl) expect(new URL(row.imageUrl).hostname).toMatch(/\.invalid$/);
		}

		const key = Buffer.from(E2E_ALERTS_KEY, 'base64');
		const config = (await loadChannelConfig(db, key, 'ntfy')) as { url: string } | null;
		expect(config).toMatchObject({ url: SEEDED_DESIGN_TOPIC_URL });
		const topicUrl = config!.url;
		unbrokenAtLeast(topicUrl, 140, 'design topic URL');
		expect(new URL(topicUrl).hostname).toMatch(/\.invalid$/);
		// Resubmitting it unchanged must save it unchanged.
		expect(parseTopicUrl(topicUrl)).toMatchObject({ ok: true, url: topicUrl });
	});
});

test('chart seed', async () => {
	await withDb(async (db) => {
		const points = await pointsOf(db, SEEDED_WATCHES.chartFull.id);
		const ages = points.map((point) => ageOf(point.checkedAt));
		expect(ages.some((age) => age < 30 * DAY)).toBe(true);
		expect(ages.some((age) => age > 30 * DAY && age < 90 * DAY)).toBe(true);
		expect(ages.some((age) => age > 90 * DAY)).toBe(true);

		const failures = await failuresOf(db, SEEDED_WATCHES.chartFull.id);
		const pairs = failures.slice(1).filter(({ checkedAt }, i) => {
			const [from, to] = [failures[i].checkedAt, checkedAt];
			const between = points.some((p) => p.checkedAt > from && p.checkedAt < to);
			return ageOf(from) < 30 * DAY && !between;
		});
		expect(pairs.length).toBeGreaterThan(0);

		const [target] = await db
			.select({ targetPence: watch.targetPence })
			.from(watch)
			.where(eq(watch.id, SEEDED_WATCHES.chartFull.id));
		expect(target.targetPence).not.toBeNull();
	});
});

test('failure seed', async () => {
	await withDb(async (db) => {
		const failing = await db.select().from(watch);
		for (const row of failing.filter((w) => w.lastCheckReason !== null)) {
			const failures = await failuresOf(db, row.id);
			expect(
				failures.filter(
					(failure) =>
						failure.reason === row.lastCheckReason &&
						failure.message === row.lastCheckMessage &&
						failure.checkedAt.getTime() === row.lastCheckedAt?.getTime()
				),
				row.id
			).toHaveLength(1);
		}
	});
});

test('card seed', async () => {
	const { cardFresh, cardOverdue, cardInGrace, cardStale } = SEEDED_WATCHES;
	await withDb(async (db) => {
		const rows = await db
			.select()
			.from(watch)
			.where(inArray(watch.id, [cardFresh.id, cardOverdue.id, cardInGrace.id, cardStale.id]));
		const age = (id: string) => ageOf(rows.find((row) => row.id === id)!.lastCheckedAt!);

		expect(age(cardFresh.id)).toBeLessThan(6 * HOUR);
		expect(age(cardOverdue.id)).toBeGreaterThan(7 * HOUR);
		expect(age(cardInGrace.id)).toBeGreaterThan(6 * HOUR);
		expect(age(cardInGrace.id)).toBeLessThan(6 * HOUR + HOUR / 2);

		const stale = rows.find((row) => row.id === cardStale.id)!;
		expect(stale.pricePence).not.toBeNull();
		const points = await pointsOf(db, cardStale.id);
		expect(points.length).toBeGreaterThan(0);
		for (const point of points) expect(ageOf(point.checkedAt)).toBeGreaterThan(30 * DAY);
	});
});

test('edge seed', async () => {
	await withDb(async (db) => {
		const { id } = SEEDED_WATCHES.chartFull;
		const failures = await failuresOf(db, id);
		const points = await pointsOf(db, id);
		const latest = failures[failures.length - 1];

		expect(latest.checkedAt.getTime()).toBeGreaterThan(
			points[points.length - 1].checkedAt.getTime()
		);
		expect(ageOf(latest.checkedAt)).toBeLessThan(HOUR);
		expect(latest.message?.length ?? 0).toBeGreaterThanOrEqual(150);
		expect(latest.message).not.toMatch(/\s/);
	});
});

test('dense seed', async () => {
	await withDb(async (db) => {
		const points = await pointsOf(db, SEEDED_WATCHES.chartDense.id);

		expect(points).toHaveLength(1460);
		for (let i = 1; i < points.length; i++) {
			expect(points[i].checkedAt.getTime() - points[i - 1].checkedAt.getTime()).toBe(6 * HOUR);
		}
		expect(ageOf(points[points.length - 1].checkedAt)).toBeLessThan(6 * HOUR);
	});
});

// c-2: the server needs only DATABASE_URL and ALERTS_ENCRYPTION_KEY.
test('webServer env', () => {
	const servers = [playwrightConfig.webServer ?? []].flat();
	expect(servers).toHaveLength(1);
	const env = servers[0].env ?? {};
	expect(Object.keys(env)).not.toContain('BETTER_AUTH_SECRET');
	expect(Object.keys(env)).not.toContain('ORIGIN');
	expect(env).toMatchObject({
		DATABASE_URL: E2E_DATABASE_URL,
		ALERTS_ENCRYPTION_KEY: E2E_ALERTS_KEY
	});
});

/** Answers every request with the names of the variables it was started with. */
const ENV_PROBE = `import { createServer } from 'node:http';
createServer((req, res) => {
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify(Object.keys(process.env)));
}).listen(Number(process.env.PORT), process.env.HOST);
`;

test('node-server env', async () => {
	// Set in this process only: a child that sees them got a process.env spread.
	const parentOnly = ['BETTER_AUTH_SECRET', 'ORIGIN', 'NODE_SERVER_PARENT_ONLY'];
	const saved = parentOnly.map((name) => [name, process.env[name]] as const);
	for (const name of parentOnly) process.env[name] = `parent-only-${name}`;
	const dir = mkdtempSync(join(tmpdir(), 'node-server-probe-'));
	try {
		const probe = join(dir, 'probe.mjs');
		writeFileSync(probe, ENV_PROBE);
		const server = await startNodeServer({
			port: await freePort(),
			dbFile: join(dir, 'probe.db'),
			env: { ALERTS_ENCRYPTION_KEY: E2E_ALERTS_KEY },
			entry: probe
		});
		let names: string[];
		try {
			names = await (await fetch(`${server.url}/health`)).json();
		} finally {
			await server.stop();
		}
		for (const name of parentOnly) expect(names, name).not.toContain(name);
		for (const name of ['PATH', 'PORT', 'DATABASE_URL', 'ALERTS_ENCRYPTION_KEY']) {
			expect(names, name).toContain(name);
		}
		// stop() resolved only once the child was gone: nothing answers any more.
		await expect(fetch(`${server.url}/health`)).rejects.toThrow();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test('node-server needs a build', async () => {
	await expect(
		startNodeServer({
			port: await freePort(),
			dbFile: 'unused.db',
			entry: 'build/no-such-entry.js'
		})
	).rejects.toThrow('run pnpm build first');
});
