import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	CHECK_COOLDOWN_MS,
	COOLDOWN_MESSAGE,
	checkIntervalFromEnv,
	checkNow,
	checkWatch,
	dueWatches,
	failureHistory,
	priceHistory,
	recordCheck,
	type CheckDeps
} from './checks.ts';
import { checkFailure, pricePoint, watch } from './db/schema.ts';
import { failure, type CheckResult, type FailureReason } from './shops/types.ts';
import { createAuthHarness, type AuthHarness } from './testing/auth-harness.ts';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let h: AuthHarness;
let alice: string;
let bob: string;
let ids = 0;
const newId = () => `p${++ids}`;

function ok(pricePence = 1999, extra: Partial<CheckResult> = {}): CheckResult {
	return {
		ok: true,
		shop: 'amazon-uk',
		productId: 'B0ABC12345',
		canonicalUrl: 'https://www.amazon.co.uk/dp/B0ABC12345',
		title: 'Fresh Title',
		pricePence,
		imageUrl: 'https://img.example/fresh.jpg',
		...extra
	} as CheckResult;
}

async function addWatchRow(
	id: string,
	userId: string,
	fields: Partial<typeof watch.$inferInsert> = {}
) {
	await h.db.insert(watch).values({
		id,
		userId,
		shop: 'amazon-uk',
		productId: `B0${id.padEnd(8, '0')}`.slice(0, 10),
		canonicalUrl: `https://www.amazon.co.uk/dp/${id}`,
		title: 'Old Title',
		imageUrl: 'https://img.example/old.jpg',
		pricePence: 2500,
		...fields
	});
}

const stored = async (id: string) => (await h.db.select().from(watch).where(eq(watch.id, id)))[0];
const points = (watchId: string) =>
	h.db.select().from(pricePoint).where(eq(pricePoint.watchId, watchId));
const failures = (watchId: string) =>
	h.db.select().from(checkFailure).where(eq(checkFailure.watchId, watchId));

beforeEach(async () => {
	ids = 0;
	h = await createAuthHarness();
	alice = (await h.createUser({ email: 'alice@example.test' })).id;
	bob = (await h.createUser({ email: 'bob@example.test' })).id;
});
afterEach(() => h.cleanup());

describe('recordCheck', () => {
	it('success', async () => {
		await addWatchRow('w1', alice, {
			lastCheckedAt: ago(HOUR),
			lastCheckReason: 'blocked',
			lastCheckMessage: 'captcha'
		});

		await recordCheck(h.db, 'w1', ok(1799), NOW, newId);

		expect(await stored('w1')).toMatchObject({
			title: 'Fresh Title',
			imageUrl: 'https://img.example/fresh.jpg',
			pricePence: 1799,
			lastCheckedAt: NOW,
			lastCheckReason: null,
			lastCheckMessage: null
		});
		expect(await points('w1')).toEqual([
			{ id: 'p1', watchId: 'w1', pricePence: 1799, checkedAt: NOW }
		]);

		// An unchanged price is still a point (every_success_is_a_point).
		await recordCheck(h.db, 'w1', ok(1799), new Date(NOW.getTime() + HOUR), newId);
		expect(await points('w1')).toHaveLength(2);
	});

	it('failure', async () => {
		const reasons: FailureReason[] = [
			'blocked',
			'unavailable',
			'parse_failed',
			'fetch_failed',
			'not_found',
			'variant_required',
			'unsupported'
		];
		for (const reason of reasons) {
			await addWatchRow(reason, alice, { lastCheckedAt: ago(HOUR) });

			await recordCheck(h.db, reason, failure(reason, `${reason} message`), NOW, newId);

			expect(await stored(reason), reason).toMatchObject({
				title: 'Old Title',
				imageUrl: 'https://img.example/old.jpg',
				pricePence: 2500,
				lastCheckedAt: NOW,
				lastCheckReason: reason,
				lastCheckMessage: `${reason} message`
			});
			expect(await points(reason), reason).toEqual([]);
		}
	});

	it('failure recorded', async () => {
		await addWatchRow('w1', alice);

		await recordCheck(h.db, 'w1', failure('blocked', 'captcha'), NOW, newId);

		const { lastCheckedAt } = await stored('w1');
		expect(lastCheckedAt).toEqual(NOW);
		expect(await failures('w1')).toEqual([
			{ id: 'p1', watchId: 'w1', reason: 'blocked', message: 'captcha', checkedAt: lastCheckedAt }
		]);
	});

	it('consecutive failures', async () => {
		await addWatchRow('w1', alice);

		// The same reason and message each time: every one is still its own row.
		for (const at of [ago(3 * HOUR), ago(2 * HOUR), ago(1 * HOUR)]) {
			await recordCheck(h.db, 'w1', failure('blocked', 'captcha'), at, newId);
		}

		expect(await failureHistory(h.db, alice, 'w1')).toEqual([
			{ reason: 'blocked', message: 'captcha', checkedAt: ago(1 * HOUR) },
			{ reason: 'blocked', message: 'captcha', checkedAt: ago(2 * HOUR) },
			{ reason: 'blocked', message: 'captcha', checkedAt: ago(3 * HOUR) }
		]);
	});

	it('success keeps failures', async () => {
		await addWatchRow('w1', alice);
		await recordCheck(h.db, 'w1', failure('blocked', 'captcha'), ago(HOUR), newId);
		const before = await failures('w1');
		expect(before).toHaveLength(1);

		await recordCheck(h.db, 'w1', ok(1799), NOW, newId);

		expect(await stored('w1')).toMatchObject({ lastCheckReason: null, lastCheckMessage: null });
		expect(await failures('w1')).toEqual(before);
	});

	it('atomic', async () => {
		await addWatchRow('w1', alice);
		await recordCheck(h.db, 'w1', failure('blocked', 'captcha'), ago(HOUR), () => 'same-id');
		const before = await stored('w1');

		await expect(
			recordCheck(h.db, 'w1', failure('unavailable', 'gone'), NOW, () => 'same-id')
		).rejects.toThrow();

		expect(await stored('w1')).toEqual(before);
		expect(before.lastCheckedAt).toEqual(ago(HOUR));
		expect(await failures('w1')).toHaveLength(1);
	});

	it('only the checked watch changes', async () => {
		await addWatchRow('w1', alice);
		await addWatchRow('w2', alice);

		await recordCheck(h.db, 'w1', ok(1000), NOW, newId);
		await recordCheck(h.db, 'w1', failure('blocked', 'captcha'), NOW, newId);

		expect(await stored('w2')).toMatchObject({
			pricePence: 2500,
			lastCheckedAt: null,
			lastCheckReason: null
		});
		expect(await points('w2')).toEqual([]);
	});
});

describe('dueWatches', () => {
	it('due', async () => {
		await addWatchRow('fresh', alice, { lastCheckedAt: ago(HOUR) });
		await addWatchRow('edge', alice, { lastCheckedAt: ago(6 * HOUR) });
		await addWatchRow('old', bob, { lastCheckedAt: ago(30 * HOUR) });
		await addWatchRow('older', alice, { lastCheckedAt: ago(40 * HOUR) });
		await addWatchRow('never2', bob);
		await addWatchRow('never1', alice);

		const due = await dueWatches(h.db, NOW, 6 * HOUR);

		expect(due.map((w) => w.id)).toEqual(['never1', 'never2', 'older', 'old', 'edge']);
		expect(due[0]).toEqual({ id: 'never1', canonicalUrl: 'https://www.amazon.co.uk/dp/never1' });
		// A longer interval excludes the edge watch.
		expect((await dueWatches(h.db, NOW, 7 * HOUR)).map((w) => w.id)).not.toContain('edge');
	});

	it('due after failure', async () => {
		for (const reason of ['not_found', 'variant_required', 'blocked'] as const) {
			await addWatchRow(reason, alice, {
				lastCheckedAt: ago(7 * HOUR),
				lastCheckReason: reason,
				lastCheckMessage: 'x'
			});
		}

		const due = await dueWatches(h.db, NOW, 6 * HOUR);

		expect(due.map((w) => w.id).sort()).toEqual(['blocked', 'not_found', 'variant_required']);
	});
});

describe('checkWatch', () => {
	it('checks the canonical URL and records the result', async () => {
		await addWatchRow('w1', alice);
		const check = vi.fn<CheckDeps['check']>(async () => ok(1500));

		const result = await checkWatch(
			h.db,
			{ id: 'w1', canonicalUrl: 'https://www.amazon.co.uk/dp/w1' },
			{ check, now: () => NOW, newId }
		);

		expect(result).toEqual(ok(1500));
		expect(check).toHaveBeenCalledExactlyOnceWith('https://www.amazon.co.uk/dp/w1');
		expect(await stored('w1')).toMatchObject({ pricePence: 1500, lastCheckedAt: NOW });
		expect(await points('w1')).toHaveLength(1);
	});

	it('after success', async () => {
		await addWatchRow('w1', alice);
		await addWatchRow('w2', alice);
		const afterSuccess = vi.fn(async () => {});
		const due = (id: string) => ({ id, canonicalUrl: `https://www.amazon.co.uk/dp/${id}` });

		await checkWatch(h.db, due('w1'), {
			check: async () => ok(),
			afterSuccess,
			now: () => NOW,
			newId
		});
		expect(afterSuccess).toHaveBeenCalledExactlyOnceWith('w1');

		// A failed check: no call.
		await checkWatch(h.db, due('w2'), {
			check: async () => failure('blocked', 'captcha'),
			afterSuccess,
			now: () => NOW
		});
		expect(afterSuccess).toHaveBeenCalledOnce();

		// A throwing hook never fails the check; the result is still recorded and returned.
		afterSuccess.mockRejectedValueOnce(
			new Error('alert exploded for https://ntfy.sh/secret-topic')
		);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(
				await checkWatch(h.db, due('w2'), { check: async () => ok(1111), afterSuccess, newId })
			).toEqual(ok(1111));
			expect(await stored('w2')).toMatchObject({ pricePence: 1111 });
			expect(consoleError).toHaveBeenCalledOnce();
			expect(String(consoleError.mock.calls[0])).toMatch(
				/after-success hook for watch .+ failed \(Error\)$/
			);
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret-topic');
		} finally {
			consoleError.mockRestore();
		}

		// 'Check now' passes the hook through.
		await addWatchRow('w3', alice);
		await checkNow(h.db, alice, 'w3', {
			check: async () => ok(),
			afterSuccess,
			now: () => NOW,
			newId
		});
		expect(afterSuccess).toHaveBeenLastCalledWith('w3');
	});

	it('after failure', async () => {
		await addWatchRow('w1', alice);
		await addWatchRow('w2', alice);
		const blocked = failure('blocked', 'captcha');
		const afterFailure = vi.fn(async () => {});
		const due = (id: string) => ({ id, canonicalUrl: `https://www.amazon.co.uk/dp/${id}` });

		// Called once the failure is on record.
		afterFailure.mockImplementationOnce(async () => {
			expect(await stored('w1')).toMatchObject({ lastCheckReason: 'blocked' });
		});
		await checkWatch(h.db, due('w1'), {
			check: async () => blocked,
			afterFailure,
			now: () => NOW,
			newId
		});
		expect(afterFailure).toHaveBeenCalledExactlyOnceWith('w1', blocked);

		// A successful check: no call.
		await checkWatch(h.db, due('w2'), { check: async () => ok(), afterFailure, newId });
		expect(afterFailure).toHaveBeenCalledOnce();

		// A throwing hook never changes the check's result.
		afterFailure.mockRejectedValueOnce(
			new Error('alert exploded for https://ntfy.sh/secret-topic')
		);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(
				await checkWatch(h.db, due('w2'), { check: async () => blocked, afterFailure, newId })
			).toEqual(blocked);
			expect(consoleError).toHaveBeenCalledOnce();
			expect(String(consoleError.mock.calls[0])).toMatch(
				/after-failure hook for watch .+ failed \(Error\)$/
			);
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret-topic');
		} finally {
			consoleError.mockRestore();
		}

		// 'Check now' passes the hook through.
		await addWatchRow('w3', alice);
		await checkNow(h.db, alice, 'w3', {
			check: async () => blocked,
			afterFailure,
			now: () => NOW,
			newId
		});
		expect(afterFailure).toHaveBeenLastCalledWith('w3', blocked);
	});

	it('default clock and id', async () => {
		await addWatchRow('w1', alice);
		const before = Date.now();

		await checkWatch(
			h.db,
			{ id: 'w1', canonicalUrl: 'https://www.amazon.co.uk/dp/w1' },
			{ check: async () => ok() }
		);

		const [point] = await points('w1');
		expect(point.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(point.checkedAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(point.checkedAt.getTime()).toBeLessThanOrEqual(Date.now());
	});
});

describe('checkNow', () => {
	it('check now', async () => {
		await addWatchRow('recent', alice, { lastCheckedAt: ago(CHECK_COOLDOWN_MS - 1) });
		await addWatchRow('future', alice, { lastCheckedAt: new Date(NOW.getTime() + HOUR) });
		await addWatchRow('stale', alice, { lastCheckedAt: ago(CHECK_COOLDOWN_MS) });
		await addWatchRow('never', alice);
		await addWatchRow('theirs', bob);
		const check = vi.fn<CheckDeps['check']>(async () => ok(1234));
		const deps: CheckDeps = { check, now: () => NOW, newId };

		for (const id of ['recent', 'future']) {
			expect(await checkNow(h.db, alice, id, deps), id).toEqual({
				kind: 'cooldown',
				message: COOLDOWN_MESSAGE
			});
		}
		expect(check).not.toHaveBeenCalled();

		expect(await checkNow(h.db, alice, 'theirs', deps)).toEqual({ kind: 'not_found' });
		expect(await checkNow(h.db, alice, 'missing', deps)).toEqual({ kind: 'not_found' });
		expect(check).not.toHaveBeenCalled();
		expect(await stored('theirs')).toMatchObject({ lastCheckedAt: null });

		for (const id of ['stale', 'never']) {
			expect(await checkNow(h.db, alice, id, deps), id).toEqual({
				kind: 'checked',
				result: ok(1234)
			});
			expect(await stored(id), id).toMatchObject({ pricePence: 1234, lastCheckedAt: NOW });
			expect(await points(id), id).toHaveLength(1);
		}
		expect(check).toHaveBeenCalledTimes(2);

		// A manual check counts for the cooldown too.
		expect(await checkNow(h.db, alice, 'stale', deps)).toMatchObject({ kind: 'cooldown' });
	});

	it('check now failure', async () => {
		await addWatchRow('w1', alice);
		const check = vi.fn<CheckDeps['check']>(async () => failure('blocked', 'captcha'));
		const deps: CheckDeps = { check, now: () => NOW, newId };

		expect(await checkNow(h.db, alice, 'w1', deps)).toMatchObject({ kind: 'checked' });
		expect(await failures('w1')).toMatchObject([
			{ reason: 'blocked', message: 'captcha', checkedAt: NOW }
		]);

		// The failed check started the cooldown: the refusal is not a failed check.
		expect(await checkNow(h.db, alice, 'w1', deps)).toMatchObject({ kind: 'cooldown' });
		expect(check).toHaveBeenCalledOnce();
		expect(await failures('w1')).toHaveLength(1);
	});
});

describe('priceHistory', () => {
	it('history', async () => {
		await addWatchRow('w1', alice);
		await addWatchRow('w2', alice);
		await addWatchRow('b1', bob);
		await h.db.insert(pricePoint).values([
			{ id: 'a', watchId: 'w1', pricePence: 100, checkedAt: ago(3 * HOUR) },
			{ id: 'b', watchId: 'w1', pricePence: 300, checkedAt: ago(1 * HOUR) },
			{ id: 'c', watchId: 'w1', pricePence: 200, checkedAt: ago(2 * HOUR) },
			{ id: 'd', watchId: 'w2', pricePence: 999, checkedAt: ago(1 * HOUR) },
			{ id: 'e', watchId: 'b1', pricePence: 555, checkedAt: ago(1 * HOUR) }
		]);

		expect(await priceHistory(h.db, alice, 'w1')).toEqual([
			{ pricePence: 300, checkedAt: ago(1 * HOUR) },
			{ pricePence: 200, checkedAt: ago(2 * HOUR) },
			{ pricePence: 100, checkedAt: ago(3 * HOUR) }
		]);
		expect(await priceHistory(h.db, alice, 'b1')).toEqual([]);
		expect(await priceHistory(h.db, bob, 'w1')).toEqual([]);
		expect(await priceHistory(h.db, alice, 'missing')).toEqual([]);
	});
});

describe('failureHistory', () => {
	it('failure history', async () => {
		await addWatchRow('w1', alice);
		await addWatchRow('w2', alice);
		await addWatchRow('b1', bob);
		const row = (
			id: string,
			watchId: string,
			reason: string,
			checkedAt: Date,
			message: string | null
		) => ({ id, watchId, reason, message, checkedAt });
		await h.db
			.insert(checkFailure)
			.values([
				row('a', 'w1', 'blocked', ago(3 * HOUR), 'captcha'),
				row('b', 'w1', 'unavailable', ago(1 * HOUR), null),
				row('c', 'w1', 'parse_failed', ago(2 * HOUR), 'no price'),
				row('d', 'w1', 'fetch_failed', ago(2 * HOUR), 'timed out'),
				row('e', 'w2', 'blocked', ago(1 * HOUR), 'other watch'),
				row('f', 'b1', 'blocked', ago(1 * HOUR), 'other user')
			]);

		expect(await failureHistory(h.db, alice, 'w1')).toEqual([
			{ reason: 'unavailable', message: null, checkedAt: ago(1 * HOUR) },
			// One millisecond, two failures: the order is still the same on every read.
			{ reason: 'fetch_failed', message: 'timed out', checkedAt: ago(2 * HOUR) },
			{ reason: 'parse_failed', message: 'no price', checkedAt: ago(2 * HOUR) },
			{ reason: 'blocked', message: 'captcha', checkedAt: ago(3 * HOUR) }
		]);
		expect(await failureHistory(h.db, alice, 'b1')).toEqual([]);
		expect(await failureHistory(h.db, bob, 'w1')).toEqual([]);
		expect(await failureHistory(h.db, alice, 'missing')).toEqual([]);
	});
});

describe('checkIntervalFromEnv', () => {
	it('interval', () => {
		expect(checkIntervalFromEnv({})).toBe(6 * HOUR);
		expect(checkIntervalFromEnv({ CHECK_INTERVAL_HOURS: '  ' })).toBe(6 * HOUR);
		expect(checkIntervalFromEnv({ CHECK_INTERVAL_HOURS: '1' })).toBe(1 * HOUR);
		expect(checkIntervalFromEnv({ CHECK_INTERVAL_HOURS: ' 24 ' })).toBe(24 * HOUR);
		expect(checkIntervalFromEnv({ CHECK_INTERVAL_HOURS: '168' })).toBe(168 * HOUR);
		for (const bad of ['0', '169', '-1', '1.5', 'abc', '6h', '1e2']) {
			expect(() => checkIntervalFromEnv({ CHECK_INTERVAL_HOURS: bad }), bad).toThrow(
				`CHECK_INTERVAL_HOURS must be a whole number of hours from 1 to 168, got "${bad}"`
			);
		}
	});
});
