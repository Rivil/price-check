import { expect, test } from '@playwright/test';
import { asc, count, eq, inArray, lte } from 'drizzle-orm';
import { loadChannelConfig } from '../src/lib/server/alerts/channels.ts';
import { parseTopicUrl } from '../src/lib/server/alerts/ntfy.ts';
import { createDb } from '../src/lib/server/db/client.ts';
import {
	alertChannel,
	checkFailure,
	pricePoint,
	user,
	watch
} from '../src/lib/server/db/schema.ts';
import {
	E2E_ALERTS_KEY,
	E2E_DATABASE_URL,
	E2E_ORIGIN,
	SEEDED_ADMIN,
	SEEDED_DESIGN,
	SEEDED_DESIGN_TOPIC_URL,
	SEEDED_LONG_ACCOUNT,
	SEEDED_MEMBER,
	SEEDED_OTHER,
	SEEDED_WATCHES,
	uniqueEmail
} from './accounts.ts';

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

test('fresh seed', async () => {
	const db = createDb(E2E_DATABASE_URL);
	try {
		const seeded = await db
			.select({ createdAt: user.createdAt })
			.from(user)
			.where(inArray(user.email, [SEEDED_ADMIN.email, SEEDED_MEMBER.email]));
		expect(seeded).toHaveLength(2);

		// Later e2e files add users, so count what existed when seeding finished:
		// anything older (a previous run's leftovers) would push this above 2.
		const seedDone = new Date(Math.max(...seeded.map((r) => r.createdAt.getTime())));
		const [{ n }] = await db.select({ n: count() }).from(user).where(lte(user.createdAt, seedDone));
		expect(n).toBe(2);

		// The later seed users exist and were all created after the member.
		const later = await db
			.select({ email: user.email, createdAt: user.createdAt })
			.from(user)
			.where(
				inArray(user.email, [SEEDED_OTHER.email, SEEDED_DESIGN.email, SEEDED_LONG_ACCOUNT.email])
			);
		expect(later).toHaveLength(3);
		for (const row of later) {
			expect(row.createdAt.getTime(), row.email).toBeGreaterThan(seedDone.getTime());
		}
	} finally {
		db.$client.close();
	}
});

test('design seed', async () => {
	const { layoutLong, layoutCooldown, layoutAtTarget } = SEEDED_WATCHES;
	const unbrokenAtLeast = (value: string | null | undefined, min: number, what: string) => {
		expect(value?.length ?? 0, `${what} length`).toBeGreaterThanOrEqual(min);
		expect(value, `${what} has whitespace`).not.toMatch(/\s/);
	};

	const db = createDb(E2E_DATABASE_URL);
	try {
		const [design] = await db.select().from(user).where(eq(user.email, SEEDED_DESIGN.email));
		expect(design).toBeDefined();

		// The layout watches belong to the design user only, never the member or other.
		const designIds = [layoutLong.id, layoutCooldown.id, layoutAtTarget.id];
		const rows = await db.select().from(watch).where(inArray(watch.id, designIds));
		expect(rows.map((r) => [r.id, r.userId]).sort()).toStrictEqual(
			designIds.map((id) => [id, design.id]).sort()
		);
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

		// The seed writes the design user's channel to the legacy plaintext table after
		// migrating; the preview server's startup backfill moved it into encrypted
		// storage (and scrubbed the legacy row — see 'design seed scrubbed').
		const key = Buffer.from(E2E_ALERTS_KEY, 'base64');
		const config = (await loadChannelConfig(db, key, design.id, 'ntfy')) as {
			url: string;
			token: string | null;
		} | null;
		expect(config).toMatchObject({ url: SEEDED_DESIGN_TOPIC_URL });
		const topicUrl = config!.url;
		unbrokenAtLeast(topicUrl, 140, 'design topic URL');
		expect(new URL(topicUrl).hostname).toMatch(/\.invalid$/);
		// Resubmitting it unchanged must save it unchanged.
		expect(parseTopicUrl(topicUrl)).toMatchObject({ ok: true, url: topicUrl });

		const [longAccount] = await db
			.select()
			.from(user)
			.where(eq(user.email, SEEDED_LONG_ACCOUNT.email));
		unbrokenAtLeast(longAccount?.email, 80, 'long account email');
		unbrokenAtLeast(longAccount?.name, 60, 'long account name');
	} finally {
		db.$client.close();
	}
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

test('seeded admin signs in', async ({ request }) => {
	const signIn = await request.post('/api/auth/sign-in/email', {
		headers: { Origin: E2E_ORIGIN },
		data: { email: SEEDED_ADMIN.email, password: SEEDED_ADMIN.password }
	});
	expect(signIn.status()).toBe(200);

	const session = await request.get('/api/auth/get-session');
	expect(session.status()).toBe(200);
	expect((await session.json())?.user?.role).toBe('admin');
});

test('sign-up rejected', async ({ request }) => {
	const res = await request.post('/api/auth/sign-up/email', {
		headers: { Origin: E2E_ORIGIN },
		data: { email: uniqueEmail('signup'), password: 'long-enough-password', name: 'Nope' }
	});
	expect(res.status()).toBe(400);
});

test('design seed scrubbed', async () => {
	await withDb(async (db) => {
		const [design] = await db.select().from(user).where(eq(user.email, SEEDED_DESIGN.email));
		expect(await db.select().from(alertChannel).where(eq(alertChannel.userId, design.id))).toEqual(
			[]
		);
	});
});
