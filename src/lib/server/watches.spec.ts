import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { checkFailure, notifyChannel, pricePoint, priceDropDelivery, watch } from './db/schema.ts';
import { amazonAdapter } from './shops/amazon/adapter.ts';
import { createShopRegistry } from './shops/registry.ts';
import { failure, type CheckResult, type FailureReason, type ShopClient } from './shops/types.ts';
import { createTestDb, type TestDb } from './testing/test-db.ts';
import {
	ALREADY_WATCHED,
	URL_REQUIRED,
	addWatch,
	deleteWatch,
	getWatch,
	listWatches,
	setTarget,
	type WatchDeps
} from './watches.ts';

const fixtures = Object.fromEntries(
	Object.entries(
		// Stryker disable next-line all: import.meta.glob needs literal args for Vite's static transform
		import.meta.glob<string>('./shops/amazon/fixtures/*.html', {
			query: '?raw',
			import: 'default',
			eager: true
		})
	).map(([path, html]) => [path.replace(/^.*\/fixtures\//, '').replace(/\.html$/, ''), html])
);

const registry = createShopRegistry([amazonAdapter]);
const ASIN = 'B0ABC12345';
const URL_ = `https://www.amazon.co.uk/Some-Thing/dp/${ASIN}?tag=x-21`;
const CANONICAL = `https://www.amazon.co.uk/dp/${ASIN}`;
const SHORT = 'https://amzn.eu/d/abc1234';
const NOW = new Date('2026-11-02T21:00:00.000Z');

function ok(productId = ASIN, extra: Partial<CheckResult> = {}): CheckResult {
	return {
		ok: true,
		shop: 'amazon-uk',
		productId,
		canonicalUrl: `https://www.amazon.co.uk/dp/${productId}`,
		title: `Product ${productId}`,
		pricePence: 129900,
		imageUrl: `https://m.media-amazon.com/images/I/${productId}.jpg`,
		...extra
	} as CheckResult;
}

/** identify is the real, offline registry; check is a stub answering in order. */
function deps(...results: CheckResult[]) {
	const check = vi.fn<WatchDeps['check']>(async () => {
		const next = results.shift();
		if (next === undefined) throw new Error('unexpected check');
		return next;
	});
	const identify = vi.fn<WatchDeps['identify']>((url) => registry.identify(url));
	const d: WatchDeps = { identify, check, now: () => NOW, newId: () => `w${++ids}` };
	return { deps: d, check, identify };
}

let h: TestDb;
/** Watch ids handed out by deps(), unique across one test. */
let ids = 0;

beforeEach(async () => {
	ids = 0;
	h = await createTestDb();
});
afterEach(() => h.dispose());

const rows = () => h.db.select().from(watch);
const failures = () => h.db.select().from(checkFailure);

describe('addWatch', () => {
	it('add success', async () => {
		const { deps: d, check } = deps(ok());

		const result = await addWatch(h.db, { url: ` ${URL_} `, target: '24.99' }, d);

		expect(check).toHaveBeenCalledExactlyOnceWith(URL_);
		expect(result).toMatchObject({ ok: true });
		const [stored] = await rows();
		expect(stored).not.toHaveProperty('userId');
		expect(stored).toMatchObject({
			id: 'w1',
			shop: 'amazon-uk',
			productId: ASIN,
			canonicalUrl: CANONICAL,
			title: `Product ${ASIN}`,
			imageUrl: `https://m.media-amazon.com/images/I/${ASIN}.jpg`,
			pricePence: 129900,
			targetPence: 2499,
			lastCheckedAt: NOW,
			lastCheckReason: null,
			lastCheckMessage: null
		});
		expect(result.ok && result.watch).toEqual(stored);
	});

	it('add success from a recorded page', async () => {
		// The real adapter and registry, fed the synthetic-plain fixture: no network.
		const plain = 'https://www.amazon.co.uk/dp/B0TESTPLN1';
		const request = vi.fn<ShopClient['request']>(async (url) => {
			if (url !== `${plain}?psc=1`) throw new Error(`unexpected request to ${url}`);
			return { status: 200, url, headers: new Headers(), body: fixtures['synthetic-plain'] };
		});
		const d: WatchDeps = {
			identify: (url) => registry.identify(url),
			check: (url) => registry.check(url, { client: { request } }),
			now: () => NOW
		};

		const result = await addWatch(h.db, { url: `${plain}?ref=x`, target: '' }, d);

		expect(result.ok).toBe(true);
		expect(await rows()).toMatchObject([
			{
				productId: 'B0TESTPLN1',
				canonicalUrl: plain,
				title: 'Acme Stainless Steel Water Bottle 750ml & Carry Loop',
				pricePence: 1999,
				imageUrl: 'https://m.media-amazon.com/images/I/71TestPlnA._AC_SL1500_.jpg',
				targetPence: null
			}
		]);
		expect(request).toHaveBeenCalledOnce();
	});

	it('rejected adds', async () => {
		for (const reason of ['unsupported', 'not_found', 'variant_required'] as FailureReason[]) {
			const { deps: d } = deps(failure(reason, `${reason} message`));

			const result = await addWatch(h.db, { url: URL_, target: '' }, d);

			expect(result, reason).toEqual({ ok: false, field: 'url', message: `${reason} message` });
		}
		expect(await rows()).toEqual([]);
	});

	it('unsupported without a request', async () => {
		for (const url of [
			'https://www.amazon.com/dp/B0ABC12345',
			'https://www.amazon.co.uk/s?k=tv',
			'not a url'
		]) {
			const { deps: d, check } = deps();

			const result = await addWatch(h.db, { url, target: '' }, d);

			expect(result, url).toEqual({ ok: false, field: 'url', message: 'unsupported URL' });
			expect(check).not.toHaveBeenCalled();
		}
		const { deps: d, check, identify } = deps();
		expect(await addWatch(h.db, { url: '   ', target: '' }, d)).toEqual({
			ok: false,
			field: 'url',
			message: URL_REQUIRED
		});
		expect(identify).not.toHaveBeenCalled();
		expect(check).not.toHaveBeenCalled();
		expect(await rows()).toEqual([]);
	});

	it('stored failures', async () => {
		const reasons: FailureReason[] = ['blocked', 'unavailable', 'parse_failed', 'fetch_failed'];
		for (const [i, reason] of reasons.entries()) {
			const productId = `B0FAIL000${i}`;
			const { deps: d } = deps(failure(reason, `${reason} message`));

			const result = await addWatch(
				h.db,
				{ url: `https://www.amazon.co.uk/dp/${productId}?psc=1`, target: '10' },
				d
			);

			expect(result.ok, reason).toBe(true);
			const [stored] = await h.db.select().from(watch).where(eq(watch.productId, productId));
			expect(stored, reason).toMatchObject({
				shop: 'amazon-uk',
				productId,
				canonicalUrl: `https://www.amazon.co.uk/dp/${productId}`,
				title: null,
				imageUrl: null,
				pricePence: null,
				targetPence: 1000,
				lastCheckedAt: NOW,
				lastCheckReason: reason,
				lastCheckMessage: `${reason} message`
			});
		}
		expect(await rows()).toHaveLength(4);
	});

	it('short link failure', async () => {
		for (const reason of ['blocked', 'fetch_failed', 'unavailable'] as FailureReason[]) {
			const { deps: d, check } = deps(failure(reason, `${reason} message`));

			const result = await addWatch(h.db, { url: SHORT, target: '' }, d);

			expect(check).toHaveBeenCalledExactlyOnceWith(SHORT);
			expect(result, reason).toEqual({ ok: false, field: 'url', message: `${reason} message` });
		}
		expect(await rows()).toEqual([]);
	});

	it('short link success', async () => {
		const first = deps(ok());
		expect(await addWatch(h.db, { url: SHORT, target: '' }, first.deps)).toMatchObject({
			ok: true,
			watch: { productId: ASIN, canonicalUrl: CANONICAL }
		});

		// The same product again by short link: only the check can name it, then it dedupes.
		const again = deps(ok());
		const newId = vi.fn(() => 'never-used');
		again.deps.newId = newId;
		expect(await addWatch(h.db, { url: SHORT, target: '' }, again.deps)).toMatchObject({
			ok: false,
			message: ALREADY_WATCHED
		});
		expect(again.check).toHaveBeenCalledOnce();
		// Deduped before the insert: no id was drawn.
		expect(newId).not.toHaveBeenCalled();

		// And by its direct URL: deduped before any check.
		const direct = deps();
		expect(await addWatch(h.db, { url: URL_, target: '' }, direct.deps)).toMatchObject({
			ok: false,
			message: ALREADY_WATCHED
		});
		expect(direct.check).not.toHaveBeenCalled();
		expect(await rows()).toHaveLength(1);
	});

	it('duplicate', async () => {
		const first = deps(ok());
		const added = await addWatch(h.db, { url: URL_, target: '' }, first.deps);
		const existingId = added.ok ? added.watch.id : '';

		const second = deps(ok());
		expect(await addWatch(h.db, { url: CANONICAL, target: '5' }, second.deps)).toEqual({
			ok: false,
			field: 'url',
			message: ALREADY_WATCHED,
			existingId
		});
		expect(second.check).not.toHaveBeenCalled();
		expect(await rows()).toHaveLength(1);
	});

	it('concurrent adds of one product', async () => {
		// Both adds look the product up before either inserts; the checks are held
		// until both have started. A failed check skips the post-check lookup, so
		// the (shop, product_id) index has to settle it; a success may dedupe first.
		for (const result of [failure('blocked', 'captcha'), ok()]) {
			await h.db.delete(watch);
			let started = 0;
			let release!: () => void;
			const bothChecking = new Promise<void>((resolve) => (release = resolve));
			const racing = () => {
				const { deps: d } = deps();
				d.check = async () => {
					if (++started === 2) release();
					await bothChecking;
					return result;
				};
				return d;
			};

			const added = await Promise.all([
				addWatch(h.db, { url: URL_, target: '' }, racing()),
				addWatch(h.db, { url: URL_, target: '' }, racing())
			]);

			const stored = await rows();
			expect(stored, result.ok ? 'ok' : 'failed').toHaveLength(1);
			expect(added.map((r) => (r.ok ? r.watch.id : r.existingId))).toEqual([
				stored[0].id,
				stored[0].id
			]);
			expect(added.filter((r) => !r.ok)).toEqual([
				{ ok: false, field: 'url', message: ALREADY_WATCHED, existingId: stored[0].id }
			]);
		}
	});

	it('duplicate race', async () => {
		// Another add of the same product lands while this one is checking: the
		// unique index refuses the insert and the loser is told it is watched.
		const { deps: d } = deps();
		d.check = async () => {
			await h.db.insert(watch).values({
				id: 'racer',
				shop: 'amazon-uk',
				productId: ASIN,
				canonicalUrl: CANONICAL
			});
			return failure('blocked', 'captcha');
		};

		expect(await addWatch(h.db, { url: URL_, target: '' }, d)).toEqual({
			ok: false,
			field: 'url',
			message: ALREADY_WATCHED,
			existingId: 'racer'
		});
		expect(await rows()).toHaveLength(1);
	});

	it('non-product unique error', async () => {
		// A racing add of the same product lands during the check, and this insert
		// then fails for a different reason (NOT NULL is checked before unique
		// indexes). Only the product index means "already watched": this must throw.
		const { deps: d } = deps();
		d.identify = () => ({
			kind: 'product',
			shop: 'amazon-uk',
			productId: ASIN,
			canonicalUrl: null as unknown as string
		});
		d.check = async () => {
			await h.db.insert(watch).values({
				id: 'racer',
				shop: 'amazon-uk',
				productId: ASIN,
				canonicalUrl: CANONICAL
			});
			return failure('blocked', 'captcha');
		};

		const error = await addWatch(h.db, { url: URL_, target: '' }, d).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).cause).toMatchObject({
			message: expect.stringMatching(/NOT NULL constraint failed: watch\.canonical_url/)
		});
		expect((await rows()).map((r) => r.id)).toEqual(['racer']);
	});

	it('id collision', async () => {
		// The racing row for this product exists, but the insert fails on the
		// primary key (an id collision), not the product index. That is not a
		// race: the error propagates instead of 'already on your watchlist'.
		// (SQLite reports the product index when both collide, so the PK failure
		// is injected at the batch the insert runs in; reads and the racer's
		// insert hit the real database.)
		const idCollision = Object.assign(new Error('Failed query: insert into "watch"'), {
			cause: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: watch.id')
		});
		const db = new Proxy(h.db, {
			get(target, prop, receiver) {
				if (prop !== 'batch') return Reflect.get(target, prop, receiver);
				return () => Promise.reject(idCollision);
			}
		});
		const { deps: d } = deps();
		d.check = async () => {
			await h.db.insert(watch).values({
				id: 'racer',
				shop: 'amazon-uk',
				productId: ASIN,
				canonicalUrl: CANONICAL
			});
			return failure('blocked', 'captcha');
		};

		const error = await addWatch(db, { url: URL_, target: '' }, d).catch((e: unknown) => e);

		expect(error).toBe(idCollision);
		expect((await rows()).map((r) => r.id)).toEqual(['racer']);
	});

	it('default clock and id', async () => {
		const before = Date.now();
		const d: WatchDeps = {
			identify: (url) => registry.identify(url),
			check: async () => ok()
		};

		const result = await addWatch(h.db, { url: URL_, target: '' }, d);

		const after = Date.now();
		const stored = result.ok ? result.watch : null;
		expect(stored?.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		const at = stored?.lastCheckedAt?.getTime() ?? 0;
		expect(at).toBeGreaterThanOrEqual(before);
		expect(at).toBeLessThanOrEqual(after);
	});

	it('first point', async () => {
		const points = () => h.db.select().from(pricePoint);

		const added = await addWatch(h.db, { url: URL_, target: '' }, deps(ok()).deps);
		const watchId = added.ok ? added.watch.id : '';
		expect(await points()).toEqual([
			{ id: expect.any(String), watchId, pricePence: 129900, checkedAt: NOW }
		]);

		// A duplicate, a stored failure and a refused add write no point.
		await addWatch(h.db, { url: URL_, target: '' }, deps(ok()).deps);
		await addWatch(
			h.db,
			{ url: 'https://www.amazon.co.uk/dp/B0FAILPNT1', target: '' },
			deps(failure('blocked', 'captcha')).deps
		);
		await addWatch(
			h.db,
			{ url: 'https://www.amazon.co.uk/dp/B0REJECTP1', target: '' },
			deps(failure('not_found', 'gone')).deps
		);
		expect(await points()).toHaveLength(1);
		expect(await rows()).toHaveLength(2);
	});

	it('failed first check', async () => {
		const added = await addWatch(
			h.db,
			{ url: URL_, target: '' },
			deps(failure('blocked', 'captcha')).deps
		);

		expect(added).toMatchObject({ ok: true, watch: { lastCheckedAt: NOW } });
		expect(await failures()).toEqual([
			{
				id: expect.any(String),
				watchId: added.ok ? added.watch.id : '',
				reason: 'blocked',
				message: 'captcha',
				checkedAt: NOW
			}
		]);

		// An add whose check succeeded has no failure to store.
		await addWatch(
			h.db,
			{ url: 'https://www.amazon.co.uk/dp/B0FINEADD1', target: '' },
			deps(ok('B0FINEADD1')).deps
		);
		expect(await failures()).toHaveLength(1);
	});

	it('rejected add', async () => {
		for (const reason of ['unsupported', 'not_found', 'variant_required'] as FailureReason[]) {
			const { deps: d } = deps(failure(reason, `${reason} message`));

			expect(await addWatch(h.db, { url: URL_, target: '' }, d), reason).toMatchObject({
				ok: false
			});
		}
		expect(await failures()).toEqual([]);

		// The loser of a product race keeps nothing, and the winner's watch gains nothing.
		const { deps: d } = deps();
		d.check = async () => {
			await h.db.insert(watch).values({
				id: 'racer',
				shop: 'amazon-uk',
				productId: ASIN,
				canonicalUrl: CANONICAL
			});
			return failure('blocked', 'captcha');
		};
		expect(await addWatch(h.db, { url: URL_, target: '' }, d)).toMatchObject({
			ok: false,
			existingId: 'racer'
		});
		expect(await failures()).toEqual([]);
	});

	it('after success', async () => {
		const hook = vi.fn(async () => {});
		const withHook = (...results: CheckResult[]) => {
			const d = deps(...results).deps;
			d.afterSuccess = hook;
			return d;
		};

		const added = await addWatch(h.db, { url: URL_, target: '' }, withHook(ok()));
		expect(hook).toHaveBeenCalledExactlyOnceWith(added.ok ? added.watch.id : 'none');

		// Duplicate, stored failure and refused add: no call.
		await addWatch(h.db, { url: URL_, target: '' }, withHook(ok()));
		await addWatch(
			h.db,
			{ url: 'https://www.amazon.co.uk/dp/B0HOOKFAIL', target: '' },
			withHook(failure('blocked', 'captcha'))
		);
		await addWatch(
			h.db,
			{ url: 'https://www.amazon.co.uk/dp/B0HOOKGONE', target: '' },
			withHook(failure('not_found', 'gone'))
		);
		expect(hook).toHaveBeenCalledOnce();

		// A hook that throws never fails the add.
		hook.mockRejectedValueOnce(new Error('alert exploded for https://ntfy.sh/secret-topic'));
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const second = await addWatch(
				h.db,
				{ url: 'https://www.amazon.co.uk/dp/B0HOOKBOOM', target: '' },
				withHook(ok('B0HOOKBOOM'))
			);
			expect(second).toMatchObject({ ok: true, watch: { productId: 'B0HOOKBOOM' } });
			expect(consoleError).toHaveBeenCalledOnce();
			expect(String(consoleError.mock.calls[0])).toMatch(
				/after-success hook for watch .+ failed \(Error\)$/
			);
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret-topic');
		} finally {
			consoleError.mockRestore();
		}
	});

	it('no hook', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const { deps: d } = deps(ok());
			expect(d.afterSuccess).toBeUndefined();
			expect(await addWatch(h.db, { url: URL_, target: '' }, d)).toMatchObject({ ok: true });
			expect(consoleError).not.toHaveBeenCalled();

			// A hook that rejects with a non-Error is logged as 'error'.
			const second = deps(ok('B0NONERROR'));
			second.deps.afterSuccess = async () => {
				throw 'a plain string';
			};
			await addWatch(
				h.db,
				{ url: 'https://www.amazon.co.uk/dp/B0NONERROR', target: '' },
				second.deps
			);
			expect(consoleError).toHaveBeenCalledOnce();
			expect(String(consoleError.mock.calls[0])).toMatch(/failed \(error\)$/);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('no target', async () => {
		for (const [i, target] of ['', '   '].entries()) {
			const { deps: d, check } = deps(ok(`B0NOTARGE${i}`));

			const result = await addWatch(
				h.db,
				{ url: `https://www.amazon.co.uk/dp/B0NOTARGE${i}`, target },
				d
			);

			expect(check).toHaveBeenCalledOnce();
			expect(result).toMatchObject({ ok: true, watch: { targetPence: null } });
		}
	});

	it('target first', async () => {
		for (const target of ['24.999', '0', 'abc', '-1', '100000.01']) {
			const { deps: d, check, identify } = deps(ok());

			const result = await addWatch(h.db, { url: URL_, target }, d);

			expect(result, target).toMatchObject({ ok: false, field: 'target' });
			expect(result.ok === false && result.message, target).toMatch(/price/i);
			expect(identify).not.toHaveBeenCalled();
			expect(check).not.toHaveBeenCalled();
		}
		expect(await rows()).toEqual([]);
	});
});

describe('watch reads and edits', () => {
	/** Three watches, w1 oldest to w3 newest. */
	async function seed() {
		let n = 0;
		const add = async (productId: string) => {
			const d: WatchDeps = {
				identify: (url) => registry.identify(url),
				check: async () => ok(productId),
				now: () => NOW,
				newId: () => `w${++n}`
			};
			const result = await addWatch(
				h.db,
				{ url: `https://www.amazon.co.uk/dp/${productId}`, target: '20' },
				d
			);
			if (!result.ok) throw new Error(result.message);
			// Distinct, increasing created times so the newest-first order is pinned.
			await h.db
				.update(watch)
				.set({ createdAt: new Date(NOW.getTime() + n * 1000) })
				.where(eq(watch.id, result.watch.id));
			return result.watch.id;
		};
		const w1 = await add('B0FIRST001');
		const w2 = await add('B0SECOND01');
		const w3 = await add('B0THIRD001');
		return { w1, w2, w3 };
	}

	it('list, get, delete', async () => {
		const { w1, w2, w3 } = await seed();

		expect((await listWatches(h.db)).map((w) => w.id)).toEqual([w3, w2, w1]);
		expect(await getWatch(h.db, w1)).toMatchObject({ id: w1, productId: 'B0FIRST001' });

		// An unknown id is nothing, never an error.
		expect(await getWatch(h.db, 'missing')).toBeNull();
		expect(await setTarget(h.db, 'missing', '1')).toEqual({ kind: 'not_found' });
		expect(await deleteWatch(h.db, 'missing')).toBe(false);

		expect(await deleteWatch(h.db, w1)).toBe(true);
		expect(await getWatch(h.db, w1)).toBeNull();
		expect((await rows()).map((w) => w.id).sort()).toEqual([w2, w3]);
		expect(await deleteWatch(h.db, w1)).toBe(false);
	});

	it('target', async () => {
		const { w1, w2, w3 } = await seed();

		// Each watch has delivered its drop alert to an ntfy and a second channel.
		await h.db.insert(notifyChannel).values([{ kind: 'ntfy' }, { kind: 'resend' }]);
		for (const watchId of [w1, w2, w3]) {
			await h.db.insert(priceDropDelivery).values([
				{ watchId, kind: 'ntfy', targetPence: 2000 },
				{ watchId, kind: 'resend', targetPence: 2000 }
			]);
		}
		const delivered = async (watchId: string) =>
			(
				await h.db
					.select({ kind: priceDropDelivery.kind })
					.from(priceDropDelivery)
					.where(eq(priceDropDelivery.watchId, watchId))
			).length;

		// Re-saving the same value (20 -> '20.00'), an invalid one, or an unknown
		// watch: no delivery row goes, so one drop never alerts twice.
		expect(await setTarget(h.db, w1, '20.00')).toEqual({ kind: 'updated', targetPence: 2000 });
		expect(await setTarget(h.db, w1, '0')).toMatchObject({ kind: 'invalid' });
		expect(await setTarget(h.db, 'missing', '5')).toEqual({ kind: 'not_found' });
		expect([await delivered(w1), await delivered(w2), await delivered(w3)]).toEqual([2, 2, 2]);

		expect(await setTarget(h.db, w1, '19.99')).toEqual({ kind: 'updated', targetPence: 1999 });
		expect(await getWatch(h.db, w1)).toMatchObject({ targetPence: 1999 });
		// A real change re-arms that watch on every channel, and only that watch.
		expect([await delivered(w1), await delivered(w2), await delivered(w3)]).toEqual([0, 2, 2]);

		for (const bad of ['24.999', '0', 'abc']) {
			expect(await setTarget(h.db, w1, bad), bad).toMatchObject({ kind: 'invalid' });
		}
		expect(await getWatch(h.db, w1)).toMatchObject({ targetPence: 1999 });

		expect(await setTarget(h.db, w1, '  ')).toEqual({ kind: 'updated', targetPence: null });
		expect(await getWatch(h.db, w1)).toMatchObject({ targetPence: null });
		// Only the targeted watch changed.
		expect(await getWatch(h.db, w2)).toMatchObject({ targetPence: 2000 });

		// Clearing re-arms too; clearing again (no change) leaves a new row alone.
		expect(await setTarget(h.db, w2, '')).toEqual({ kind: 'updated', targetPence: null });
		expect(await delivered(w2)).toBe(0);
		await h.db.insert(priceDropDelivery).values({ watchId: w2, kind: 'ntfy', targetPence: 2000 });
		expect(await setTarget(h.db, w2, '')).toEqual({ kind: 'updated', targetPence: null });
		expect(await delivered(w2)).toBe(1);
		expect(await delivered(w3)).toBe(2);
	});
});
