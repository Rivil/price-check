import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dueWatches, type DueWatch } from './checks.ts';
import { watch } from './db/schema.ts';
import { saveChannel } from './alerts/channels.ts';
import { setAlertsKey } from './alerts/crypto.ts';
import { STOP_DRAIN_MS, TICK_MS, createScheduler, startScheduler } from './scheduler.ts';
import type { CheckResult } from './shops/types.ts';
import { createTestDb, type TestDb } from './testing/test-db.ts';

const w = (id: string): DueWatch => ({ id, canonicalUrl: `https://www.amazon.co.uk/dp/${id}` });

/** A promise plus the function that settles it. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

describe('createScheduler', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('isolation', async () => {
		const checked: string[] = [];
		const log = vi.fn();
		const scheduler = createScheduler({
			due: async () => [w('a'), w('b'), w('c')],
			checkOne: async (watch) => {
				checked.push(watch.id);
				if (watch.id === 'b') throw new Error('boom');
			},
			log
		});

		await scheduler.tick();

		expect(checked).toEqual(['a', 'b', 'c']);
		expect(log).toHaveBeenCalledExactlyOnceWith(
			expect.stringMatching(/^check of watch b failed: Error\n {4}at /)
		);
	});

	it('a failing due query is logged, not thrown', async () => {
		const log = vi.fn();
		const scheduler = createScheduler({
			due: async () => {
				throw new Error('db down');
			},
			checkOne: vi.fn(),
			log
		});

		await expect(scheduler.tick()).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledExactlyOnceWith(
			expect.stringMatching(/^pass failed: Error\n {4}at /)
		);
		// The next tick runs again.
		expect(scheduler.tick()).not.toBeNull();
	});

	it('default log', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const topic = 'https://ntfy.sh/alice-secret-topic';
			const token = 'tk_abcdefghijklmnopqrstuvwxyz012'; // token-shaped, not a real one
			await createScheduler({
				due: async () => [w('a')],
				checkOne: async () => {
					throw new TypeError(`Failed query\nparams: ${topic},${token}`);
				}
			}).tick();
			await createScheduler({
				due: async () => {
					throw new RangeError(`Failed query\nparams: ${topic},${token}`);
				},
				checkOne: vi.fn()
			}).tick();
			await createScheduler({
				due: async () => {
					throw `not an error object: ${topic}`;
				},
				checkOne: vi.fn()
			}).tick();

			expect(consoleError.mock.calls).toEqual([
				[expect.stringMatching(/^\[scheduler\] check of watch a failed: TypeError\n {4}at /)],
				[expect.stringMatching(/^\[scheduler\] pass failed: RangeError\n {4}at /)],
				['[scheduler] pass failed: string']
			]);
			const logged = consoleError.mock.calls.flat().join('\n');
			expect(logged).not.toContain('alice-secret-topic');
			expect(logged).not.toContain(token);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('no overlap', async () => {
		const gate = deferred();
		const due = vi.fn(async () => [w('a')]);
		const scheduler = createScheduler({ due, checkOne: () => gate.promise });

		const first = scheduler.tick();
		expect(first).not.toBeNull();
		await vi.advanceTimersByTimeAsync(0);
		expect(scheduler.tick()).toBeNull();
		expect(due).toHaveBeenCalledOnce();

		gate.resolve();
		await first;
		expect(scheduler.tick()).not.toBeNull();
		expect(due).toHaveBeenCalledTimes(2);
	});

	it('serial', async () => {
		const gates = { a: deferred(), b: deferred() };
		let inFlight = 0;
		let maxInFlight = 0;
		const started: string[] = [];
		const scheduler = createScheduler({
			due: async () => [w('a'), w('b')],
			checkOne: async (watch) => {
				started.push(watch.id);
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await gates[watch.id as 'a' | 'b'].promise;
				inFlight--;
			}
		});

		const pass = scheduler.tick();
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(['a']);
		gates.a.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(['a', 'b']);
		gates.b.resolve();
		await pass;
		expect(maxInFlight).toBe(1);
	});

	it('ticks every 5 minutes until stopped', async () => {
		expect(TICK_MS).toBe(5 * 60 * 1000);
		const due = vi.fn(async () => []);
		const scheduler = createScheduler({ due, checkOne: vi.fn() });
		scheduler.start();

		await vi.advanceTimersByTimeAsync(0);
		expect(due).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(TICK_MS - 1);
		expect(due).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(due).toHaveBeenCalledTimes(2);

		await scheduler.stop();
		await vi.advanceTimersByTimeAsync(TICK_MS * 3);
		expect(due).toHaveBeenCalledTimes(2);
		expect(scheduler.tick()).toBeNull();
	});

	it('resume mid-pass', async () => {
		const asleep = new Date('2026-11-02T12:00:00Z');
		const awake = new Date('2026-11-02T20:00:00Z');
		vi.setSystemTime(asleep);
		const gate = deferred();
		const seen: Date[] = [];
		const due = vi.fn(async (now: Date) => {
			seen.push(now);
			return [w('a')];
		});
		const checkOne = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
		const scheduler = createScheduler({ due, checkOne });

		const first = scheduler.tick();
		await vi.advanceTimersByTimeAsync(0);
		expect(checkOne).toHaveBeenCalledOnce();

		// The OS resumes while that pass still waits on its check.
		vi.setSystemTime(awake);
		scheduler.requestPass();
		expect(due).toHaveBeenCalledOnce();

		gate.resolve();
		await first;
		await vi.advanceTimersByTimeAsync(0);
		expect(due).toHaveBeenCalledTimes(2);
		expect(seen).toEqual([asleep, awake]);
		expect(checkOne).toHaveBeenCalledTimes(2);

		// Exactly one follow-up: nothing else runs afterwards.
		await vi.advanceTimersByTimeAsync(TICK_MS * 3);
		expect(due).toHaveBeenCalledTimes(2);
	});

	it('due during sleep', async () => {
		const HOUR = 60 * 60 * 1000;
		const interval = 12 * HOUR;
		const t0 = new Date('2026-11-02T12:00:00Z').getTime();
		// 'slept' comes due 6h into an 8h sleep; 'fresh' only after it.
		const lastChecked = { slept: t0 - 6 * HOUR, fresh: t0 };
		const due = vi.fn(async (now: Date) =>
			Object.entries(lastChecked)
				.filter(([, at]) => at + interval <= now.getTime())
				.map(([id]) => w(id))
		);
		const checked: string[] = [];
		const scheduler = createScheduler({
			due,
			checkOne: async (watch) => {
				checked.push(watch.id);
			}
		});

		vi.setSystemTime(t0);
		await scheduler.tick();
		expect(checked).toEqual([]);

		vi.setSystemTime(t0 + 8 * HOUR);
		scheduler.requestPass();
		await vi.advanceTimersByTimeAsync(0);

		expect(due).toHaveBeenLastCalledWith(new Date(t0 + 8 * HOUR));
		expect(checked).toEqual(['slept']);
	});

	it('requestPass while idle starts a pass at once', () => {
		const due = vi.fn(async () => []);
		const scheduler = createScheduler({ due, checkOne: vi.fn() });

		scheduler.requestPass();

		// Synchronously: no timer, no microtask in between.
		expect(due).toHaveBeenCalledOnce();
	});

	it('requests during a pass do not pile up', async () => {
		const gate = deferred();
		const due = vi.fn(async () => [w('a')]);
		const checkOne = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
		const scheduler = createScheduler({ due, checkOne });

		scheduler.requestPass();
		await vi.advanceTimersByTimeAsync(0);
		scheduler.requestPass();
		scheduler.requestPass();
		expect(due).toHaveBeenCalledOnce();

		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(TICK_MS * 3);
		expect(due).toHaveBeenCalledTimes(2);
	});

	it('stop drains', async () => {
		const gate = deferred();
		const due = vi.fn(async () => [w('a')]);
		const scheduler = createScheduler({ due, checkOne: () => gate.promise });
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(due).toHaveBeenCalledOnce();

		let stopped = false;
		const stopping = scheduler.stop(1000).then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		// The check is still pending: quit must not close the db under it.
		expect(stopped).toBe(false);

		gate.resolve();
		await stopping;
		expect(stopped).toBe(true);

		// The interval is gone, and a request after stop does nothing.
		await vi.advanceTimersByTimeAsync(TICK_MS * 3);
		scheduler.requestPass();
		expect(due).toHaveBeenCalledOnce();
	});

	it('stop drops a queued follow-up', async () => {
		const gate = deferred();
		const due = vi.fn(async () => [w('a')]);
		const scheduler = createScheduler({ due, checkOne: () => gate.promise });

		scheduler.requestPass();
		await vi.advanceTimersByTimeAsync(0);
		scheduler.requestPass();
		const stopping = scheduler.stop(1000);
		gate.resolve();
		await stopping;
		await vi.advanceTimersByTimeAsync(TICK_MS);

		expect(due).toHaveBeenCalledOnce();
	});

	it('stop gives up on a pass that never settles', async () => {
		const log = vi.fn();
		const scheduler = createScheduler({
			due: async () => [w('a')],
			checkOne: () => new Promise(() => {}),
			log
		});
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);

		let stopped = false;
		const stopping = scheduler.stop(1000).then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(stopped).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await stopping;
		expect(stopped).toBe(true);
		expect(log).toHaveBeenCalledExactlyOnceWith(
			'stop: the pass in flight did not finish within 1000ms'
		);
	});

	it('stop waits STOP_DRAIN_MS by default', async () => {
		const scheduler = createScheduler({
			due: async () => [w('a')],
			checkOne: () => new Promise(() => {}),
			log: vi.fn()
		});
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);

		let stopped = false;
		void scheduler.stop().then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS - 1);
		expect(stopped).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(stopped).toBe(true);
	});

	it('stop while idle resolves at once', async () => {
		const due = vi.fn(async () => []);
		const scheduler = createScheduler({ due, checkOne: vi.fn() });
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);

		await expect(scheduler.stop()).resolves.toBeUndefined();
	});
});

describe('catch-up after sleep', () => {
	const HOUR = 60 * 60 * 1000;
	const INTERVAL = 4 * HOUR;
	const t0 = new Date('2026-11-02T12:00:00Z');
	let h: TestDb;

	beforeEach(async () => {
		h = await createTestDb();
		vi.useFakeTimers({ now: t0, toFake: ['Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
		h.dispose();
	});

	it('catch-up after sleep', async () => {
		for (const id of ['one', 'two', 'three']) {
			await h.db.insert(watch).values({
				id,
				shop: 'amazon-uk',
				productId: `B0${id.toUpperCase()}`.padEnd(10, '0'),
				canonicalUrl: `https://www.amazon.co.uk/dp/${id}`,
				lastCheckedAt: t0
			});
		}
		const due = vi.fn((now: Date) => dueWatches(h.db, now, INTERVAL));
		const checked: string[] = [];
		const scheduler = createScheduler({
			due,
			checkOne: async (watch) => {
				checked.push(watch.id);
			}
		});

		// The machine sleeps through three intervals, then resumes.
		vi.setSystemTime(t0.getTime() + 3 * INTERVAL);
		scheduler.requestPass();
		await scheduler.stop(10_000);

		expect(due).toHaveBeenCalledOnce();
		expect([...checked].sort()).toEqual(['one', 'three', 'two']);
	});
});

describe('startScheduler', () => {
	let h: TestDb;
	const HOUR = 60 * 60 * 1000;

	beforeEach(async () => {
		h = await createTestDb();
		vi.useFakeTimers({
			now: new Date('2026-11-02T12:00:00Z'),
			toFake: ['setInterval', 'clearInterval', 'Date']
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		h.dispose();
	});

	it('gating', async () => {
		const check = vi.fn();
		const base = { db: h.db, check };

		expect(startScheduler({ ...base, env: {}, building: true })).toBeNull();
		expect(startScheduler({ ...base, env: { VITEST: 'true' }, building: false })).toBeNull();
		expect(
			startScheduler({ ...base, env: { SCHEDULER_DISABLED: '1' }, building: false })
		).toBeNull();
		expect(check).not.toHaveBeenCalled();

		const controls = startScheduler({ ...base, env: { SCHEDULER_DISABLED: '' }, building: false });
		expect(controls).toEqual({ requestPass: expect.any(Function), stop: expect.any(Function) });
		await controls?.stop();
	});

	it('interval wiring', async () => {
		const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
		for (const [id, hoursAgo] of [
			['two', 2],
			['five', 5]
		] as const) {
			await h.db.insert(watch).values({
				id,
				shop: 'amazon-uk',
				productId: `B0${id.toUpperCase()}`.padEnd(10, '0'),
				canonicalUrl: `https://www.amazon.co.uk/dp/${id}`,
				lastCheckedAt: at(hoursAgo)
			});
		}
		const check = vi.fn(async (): Promise<CheckResult> => ({
			ok: false,
			reason: 'blocked',
			message: 'x'
		}));

		// 4h interval: only the watch checked 5h ago is due.
		const controls = startScheduler({
			db: h.db,
			check,
			env: { CHECK_INTERVAL_HOURS: '4' },
			building: false
		});
		await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
		expect(check).toHaveBeenCalledWith('https://www.amazon.co.uk/dp/five');
		await controls?.stop();

		expect(() =>
			startScheduler({ db: h.db, check, env: { CHECK_INTERVAL_HOURS: '0' }, building: false })
		).toThrow('CHECK_INTERVAL_HOURS');
		expect(() =>
			startScheduler({ db: h.db, check, env: { CHECK_INTERVAL_HOURS: 'abc' }, building: false })
		).toThrow('CHECK_INTERVAL_HOURS');
	});
});

describe('startScheduler alerts', () => {
	const KEY = randomBytes(32);
	let h: TestDb;

	beforeEach(async () => {
		h = await createTestDb();
		setAlertsKey(KEY);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		h.dispose();
	});

	it('alerts', async () => {
		// Global fetch is stubbed: the alert never reaches a real ntfy server.
		const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetch);
		await saveChannel(h.db, KEY, 'ntfy', { topic: 'https://ntfy.sh/sched-topic' });
		await h.db.insert(watch).values({
			id: 'w1',
			shop: 'amazon-uk',
			productId: 'B0ABC12345',
			canonicalUrl: 'https://www.amazon.co.uk/dp/B0ABC12345',
			targetPence: 2000
		});
		const check = vi.fn(async (): Promise<CheckResult> => ({
			ok: true,
			shop: 'amazon-uk',
			productId: 'B0ABC12345',
			canonicalUrl: 'https://www.amazon.co.uk/dp/B0ABC12345',
			title: 'Acme Kettle',
			pricePence: 1800,
			imageUrl: null
		}));

		const controls = startScheduler({ db: h.db, check, env: {}, building: false });
		try {
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		} finally {
			await controls?.stop();
		}
		const [target, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(target).toBe('https://ntfy.sh/');
		expect(JSON.parse(String(init.body))).toMatchObject({ topic: 'sched-topic' });
	});
});

describe('wiring', () => {
	const root = fileURLToPath(new URL('../../../', import.meta.url));

	it('init hook', () => {
		// Matched loosely on purpose: Stryker instruments this file in its sandbox
		// (coverage calls inside function bodies), and the test must still hold there.
		const hooks = readFileSync(`${root}src/hooks.server.ts`, 'utf8');
		const start = hooks.search(/export const init\b/);
		expect(start).toBeGreaterThanOrEqual(0);
		const init = hooks.slice(start);
		expect(init).toMatch(/startScheduler\(/);
		expect(init).toMatch(/CHECK_INTERVAL_HOURS/);
		expect(init).toMatch(/SCHEDULER_DISABLED/);
	});

	it('e2e never schedules', async () => {
		const { default: config } = await import('../../../playwright.config.ts');
		const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
		expect(webServer?.env?.SCHEDULER_DISABLED).toBe('1');
	});
});
