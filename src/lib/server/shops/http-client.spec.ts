import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ClientError,
	clientConfigFromEnv,
	createRateLimitedClient,
	getSharedClient,
	type FetchLike
} from './http-client.ts';

const CO_UK = 'https://www.amazon.co.uk/dp/B0ABC12345';
const SHORT = 'https://amzn.eu/d/AbC123';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Call = { url: string; init: RequestInit; at: number };

/** A fetch spy recording when each call starts and how many overlap. */
function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
	const calls: Call[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const fetch = vi.fn<FetchLike>(async (url, init) => {
		calls.push({ url, init, at: Date.now() });
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			return await handler(url, init);
		} finally {
			inFlight -= 1;
		}
	});
	return { fetch, calls, maxInFlight: () => maxInFlight };
}

function sequence(values: number[]) {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)];
}

describe('createRateLimitedClient', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('serial FIFO', async () => {
		const settledAt: number[] = [];
		const { fetch, calls, maxInFlight } = fakeFetch(async (url) => {
			await delay(100);
			return new Response(url);
		});
		const client = createRateLimitedClient({ fetch });
		const urls = [1, 2, 3, 4, 5].map((n) => `https://shop${n}.example/p/${n}`);

		const results = urls.map((url, i) =>
			client.request(url).then((response) => {
				settledAt[i] = Date.now();
				return response;
			})
		);
		await vi.runAllTimersAsync();
		const responses = await Promise.all(results);

		expect(maxInFlight()).toBe(1);
		expect(calls.map((call) => call.url)).toEqual(urls);
		expect(responses.map((response) => response.body)).toEqual(urls);
		for (let i = 1; i < urls.length; i++) {
			expect(calls[i].at).toBeGreaterThanOrEqual(settledAt[i - 1]);
		}
	});

	it('gap after settle', async () => {
		const { fetch, calls } = fakeFetch(async () => {
			if (calls.length === 1) await delay(3000);
			return new Response('ok');
		});
		const client = createRateLimitedClient({
			fetch,
			minGapMs: 5000,
			jitterMs: 2000,
			random: () => 0.5
		});

		const both = Promise.all([client.request(CO_UK), client.request(CO_UK)]);
		await vi.runAllTimersAsync();
		await both;

		expect(calls.map((call) => call.at)).toEqual([0, 9000]);
	});

	it('per-request jitter', async () => {
		const { fetch, calls } = fakeFetch(() => new Response('ok'));
		const client = createRateLimitedClient({
			fetch,
			minGapMs: 5000,
			jitterMs: 2000,
			random: sequence([0, 0.5])
		});

		const all = Promise.all([client.request(CO_UK), client.request(CO_UK), client.request(CO_UK)]);
		await vi.runAllTimersAsync();
		await all;

		expect(calls.map((call) => call.at)).toEqual([0, 5000, 11000]);
	});

	it('cross-host', async () => {
		const { fetch, calls, maxInFlight } = fakeFetch(async (url) => {
			if (url === CO_UK) await delay(3000);
			return new Response('ok');
		});
		const client = createRateLimitedClient({ fetch, minGapMs: 5000, jitterMs: 0 });

		const all = Promise.all([client.request(CO_UK), client.request(SHORT)]);
		await vi.runAllTimersAsync();
		await all;

		expect(calls.map((call) => [call.url, call.at])).toEqual([
			[CO_UK, 0],
			[SHORT, 3000]
		]);
		expect(maxInFlight()).toBe(1);
	});

	it('failure releases queue', async () => {
		const { fetch, calls } = fakeFetch(() => {
			if (calls.length === 1) throw new TypeError('fetch failed');
			return new Response('second');
		});
		const client = createRateLimitedClient({
			fetch,
			minGapMs: 5000,
			jitterMs: 2000,
			random: () => 0
		});

		const first = client.request(CO_UK).catch((error: unknown) => error);
		const second = client.request(CO_UK);
		await vi.runAllTimersAsync();

		const error = await first;
		expect(error).toBeInstanceOf(ClientError);
		expect((error as ClientError).kind).toBe('network');
		expect((await second).body).toBe('second');
		expect(calls.map((call) => call.at)).toEqual([0, 5000]);
	});

	it('timeout', async () => {
		const signals: AbortSignal[] = [];
		const { fetch, calls } = fakeFetch((_url, init) => {
			signals.push(init.signal as AbortSignal);
			if (calls.length === 1) return new Promise<Response>(() => {});
			if (calls.length === 2) {
				// Headers arrive, then the body stalls forever.
				return new Response(new ReadableStream({ start() {} }), { status: 200 });
			}
			return new Response('third');
		});
		const client = createRateLimitedClient({
			fetch,
			minGapMs: 1,
			jitterMs: 0,
			timeoutMs: 15000
		});
		const rejectedAt: number[] = [];
		const capture = (promise: Promise<unknown>) =>
			promise.catch((error: unknown) => {
				rejectedAt.push(Date.now());
				return error;
			});

		const hung = capture(client.request('https://a.example/1'));
		const stalled = capture(client.request('https://b.example/2'));
		const third = client.request('https://c.example/3');
		await vi.runAllTimersAsync();

		for (const error of [await hung, await stalled]) {
			expect(error).toBeInstanceOf(ClientError);
			expect((error as ClientError).kind).toBe('timeout');
		}
		expect(rejectedAt).toEqual([15000, 30000]);
		expect(signals[0].aborted).toBe(true);
		expect(signals[1].aborted).toBe(true);
		expect((await third).body).toBe('third');
		expect(calls[2].at).toBe(30000);
	});

	it('redirect-only', async () => {
		const cancel = vi.fn();
		const { fetch, calls } = fakeFetch(
			() =>
				new Response(new ReadableStream({ cancel }), {
					status: 301,
					headers: { location: CO_UK }
				})
		);
		const client = createRateLimitedClient({ fetch });

		const pending = client.request(SHORT, {
			method: 'GET',
			redirect: 'manual',
			readBody: false,
			headers: { 'accept-language': 'en-GB' }
		});
		await vi.runAllTimersAsync();
		const response = await pending;

		expect(response.body).toBeNull();
		expect(response.status).toBe(301);
		expect(response.headers.get('location')).toBe(CO_UK);
		expect(response.url).toBe(SHORT);
		expect(cancel).toHaveBeenCalledOnce();
		expect(calls[0].init.redirect).toBe('manual');
		expect(calls[0].init.method).toBe('GET');
		expect(calls[0].init.headers).toEqual({ 'accept-language': 'en-GB' });
	});

	it('defaults', async () => {
		const { fetch, calls } = fakeFetch(() => new Response('body'));
		const client = createRateLimitedClient({ fetch });

		const pending = client.request(CO_UK);
		await vi.runAllTimersAsync();

		expect((await pending).body).toBe('body');
		expect(calls[0].init.method).toBe('GET');
		expect(calls[0].init.redirect).toBe('follow');
	});

	it('default gap', async () => {
		// 5000ms minimum gap plus up to 2000ms jitter when the options leave them out.
		const cases: [Parameters<typeof createRateLimitedClient>[0], number][] = [];
		for (const [random, gap] of [
			[1, 7000],
			[0, 5000]
		]) {
			cases.push([{ random: () => random }, gap]);
			cases.push([{ random: () => random, minGapMs: undefined, jitterMs: undefined }, gap]);
		}

		for (const [options, gap] of cases) {
			vi.setSystemTime(0);
			const { fetch, calls } = fakeFetch(() => new Response('ok'));
			const client = createRateLimitedClient({ ...options, fetch });

			const both = Promise.all([client.request(CO_UK), client.request(CO_UK)]);
			await vi.runAllTimersAsync();
			await both;

			expect(
				calls.map((call) => call.at),
				JSON.stringify(options)
			).toEqual([0, gap]);
		}
	});

	it('default timeout', async () => {
		for (const options of [{}, { timeoutMs: undefined }]) {
			vi.setSystemTime(0);
			const { fetch } = fakeFetch(() => new Promise<Response>(() => {}));
			const client = createRateLimitedClient({ ...options, fetch });
			let settled: unknown = 'pending';

			const pending = client.request(CO_UK).catch((error: unknown) => {
				settled = error;
			});
			await vi.advanceTimersByTimeAsync(14999);
			expect(settled, JSON.stringify(options)).toBe('pending');

			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(settled).toBeInstanceOf(ClientError);
			expect((settled as ClientError).kind).toBe('timeout');
		}
	});

	it('no needless sleep', async () => {
		// The first request settles at 0; the second starts exactly at, or after, its slot.
		for (const startedAt of [5000, 100000]) {
			const sleep = vi.fn(async () => {});
			const { fetch } = fakeFetch(() => new Response('ok'));
			const client = createRateLimitedClient({
				fetch,
				sleep,
				now: sequence([0, startedAt]),
				random: () => 0,
				minGapMs: 5000,
				jitterMs: 2000
			});

			await client.request(CO_UK);
			const second = client.request(CO_UK);
			await vi.runAllTimersAsync();
			await second;

			expect(sleep, String(startedAt)).not.toHaveBeenCalled();
		}
	});

	it('default fetch', async () => {
		const stub = vi.fn<FetchLike>(async () => new Response('stubbed'));
		vi.stubGlobal('fetch', stub);
		try {
			const client = createRateLimitedClient({});
			const pending = client.request(CO_UK, { method: 'GET', redirect: 'manual' });
			await vi.runAllTimersAsync();

			expect((await pending).body).toBe('stubbed');
			expect(stub).toHaveBeenCalledOnce();
			expect(stub.mock.calls[0][0]).toBe(CO_UK);
			expect(stub.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('redirect-only without a body', async () => {
		const { fetch } = fakeFetch(
			() => new Response(null, { status: 302, headers: { location: CO_UK } })
		);
		const client = createRateLimitedClient({ fetch });

		const pending = client.request(SHORT, { redirect: 'manual', readBody: false });
		await vi.runAllTimersAsync();
		const response = await pending;

		expect(response.status).toBe(302);
		expect(response.body).toBeNull();
	});

	it('invalid url', async () => {
		const { fetch } = fakeFetch(() => new Response('ok'));
		const client = createRateLimitedClient({ fetch });

		const bad = client.request('not a url').catch((error: unknown) => error);
		const good = client.request(CO_UK);
		await vi.runAllTimersAsync();

		expect(await bad).toBeInstanceOf(ClientError);
		expect((await good).body).toBe('ok');
		expect(fetch).toHaveBeenCalledOnce();
	});

	// Every other timing test passes the defaults, so these use values that differ from them.
	it('configured gap', async () => {
		const { fetch, calls } = fakeFetch(() => new Response('ok'));
		const client = createRateLimitedClient({
			fetch,
			minGapMs: 1000,
			jitterMs: 400,
			random: () => 0.5
		});

		const both = Promise.all([client.request(CO_UK), client.request(CO_UK)]);
		await vi.runAllTimersAsync();
		await both;

		expect(calls.map((call) => call.at)).toEqual([0, 1200]);
	});

	it('configured timeout', async () => {
		const { fetch } = fakeFetch(() => new Promise<Response>(() => {}));
		const client = createRateLimitedClient({ fetch, timeoutMs: 3000 });
		let settled: unknown = 'pending';

		const pending = client.request(CO_UK).catch((error: unknown) => {
			settled = error;
		});
		await vi.advanceTimersByTimeAsync(2999);
		expect(settled).toBe('pending');

		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(settled).toBeInstanceOf(ClientError);
		expect((settled as ClientError).kind).toBe('timeout');
	});

	it('timer cleanup', async () => {
		// A leaked deadline timer would hold the adapter:check process open after a check.
		const { fetch, calls } = fakeFetch(() => {
			if (calls.length === 2) throw new TypeError('fetch failed');
			return new Response('ok');
		});
		const client = createRateLimitedClient({ fetch });

		expect((await client.request('https://a.example/1')).body).toBe('ok');
		expect(vi.getTimerCount()).toBe(0);

		const error = await client.request('https://b.example/2').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ClientError);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('error shapes', async () => {
		const boom = new TypeError('fetch failed');
		const { fetch, calls } = fakeFetch(() => {
			if (calls.length === 1) throw boom;
			return new Promise<Response>(() => {});
		});
		const client = createRateLimitedClient({ fetch, timeoutMs: 3000 });
		const shape = (error: unknown) => {
			expect(error).toBeInstanceOf(ClientError);
			const { name, kind, message, cause } = error as ClientError;
			return { name, kind, message, cause };
		};

		const network = client.request('https://a.example/1').catch((e: unknown) => e);
		const timeout = client.request('https://b.example/2').catch((e: unknown) => e);
		const invalid = client.request('not a url').catch((e: unknown) => e);
		await vi.runAllTimersAsync();

		expect(shape(await network)).toEqual({
			name: 'ClientError',
			kind: 'network',
			message: 'request failed: fetch failed',
			cause: boom
		});
		expect(shape(await timeout)).toEqual({
			name: 'ClientError',
			kind: 'timeout',
			message: 'request timed out after 3000ms',
			cause: undefined
		});
		const bad = shape(await invalid);
		expect(bad).toMatchObject({
			name: 'ClientError',
			kind: 'network',
			message: 'invalid URL: not a url'
		});
		expect(bad.cause).toBeInstanceOf(TypeError);
	});
});

describe('clientConfigFromEnv', () => {
	it('clientConfigFromEnv', () => {
		expect(clientConfigFromEnv({})).toEqual({ minGapMs: 5000, jitterMs: 2000, timeoutMs: 15000 });
		expect(clientConfigFromEnv({ SHOP_MIN_GAP_MS: '8000' }).minGapMs).toBe(8000);
		expect(clientConfigFromEnv({ SHOP_JITTER_MS: '0' }).jitterMs).toBe(0);
		expect(clientConfigFromEnv({ SHOP_TIMEOUT_MS: '30000' }).timeoutMs).toBe(30000);

		for (const name of ['SHOP_MIN_GAP_MS', 'SHOP_JITTER_MS', 'SHOP_TIMEOUT_MS']) {
			// 2147483648 is one past the longest delay setTimeout honours.
			expect(clientConfigFromEnv({ [name]: '2147483647' })).toBeTruthy();
			for (const raw of ['abc', '-5', '', '0.5e', '1.5', ' 100', '2147483648', '3000000000']) {
				expect(() => clientConfigFromEnv({ [name]: raw }), `${name}=${raw}`).toThrow(name);
			}
		}
		expect(() => clientConfigFromEnv({ SHOP_MIN_GAP_MS: '0' })).toThrow('SHOP_MIN_GAP_MS');
		expect(() => clientConfigFromEnv({ SHOP_TIMEOUT_MS: '0' })).toThrow('SHOP_TIMEOUT_MS');

		// Zero is a valid jitter but not a valid gap or timeout; the message says which.
		const limit = 'whole number of milliseconds up to 2147483647';
		expect(() => clientConfigFromEnv({ SHOP_JITTER_MS: 'abc' })).toThrow(
			`SHOP_JITTER_MS must be a non-negative ${limit}, got "abc"`
		);
		expect(() => clientConfigFromEnv({ SHOP_MIN_GAP_MS: '0' })).toThrow(
			`SHOP_MIN_GAP_MS must be a positive ${limit}, got "0"`
		);
		expect(() => clientConfigFromEnv({ SHOP_TIMEOUT_MS: '-1' })).toThrow(
			`SHOP_TIMEOUT_MS must be a positive ${limit}, got "-1"`
		);
	});
});

describe('getSharedClient', () => {
	it('shared instance', () => {
		expect(getSharedClient()).toBe(getSharedClient());
	});
});
