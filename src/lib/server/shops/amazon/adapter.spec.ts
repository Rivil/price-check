import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRateLimitedClient } from '../http-client.ts';
import { checkUrl, getSharedClient } from '../index.ts';
import type { ShopClient, ShopRequestOptions, ShopResponse } from '../types.ts';
import { amazonAdapter, createAmazonAdapter, REQUEST_HEADERS } from './adapter.ts';
import { classifyProductPage } from './classify.ts';
import { clickThroughUrl } from './wall.ts';

const fixtures = Object.fromEntries(
	Object.entries(
		// Stryker disable next-line all: import.meta.glob needs literal args for Vite's static transform
		import.meta.glob<string>('./fixtures/*.html', { query: '?raw', import: 'default', eager: true })
	).map(([path, html]) => [path.replace(/^\.\/fixtures\//, '').replace(/\.html$/, ''), html])
);

const PLAIN_ASIN = 'B0TESTPLN1';
const PLAIN_URL = `https://www.amazon.co.uk/dp/${PLAIN_ASIN}`;
/** What the adapter requests: the canonical URL plus psc=1, so variants resolve. */
const PLAIN_FETCH = `${PLAIN_URL}?psc=1`;

type Reply =
	| { status: number; body?: string | null; location?: string; url?: string; setCookies?: string[] }
	| Error;

/** A fake client answering from a URL table; it records every call and never touches the network. */
function fakeClient(replies: Record<string, Reply | Reply[]> = {}) {
	const request = vi.fn(
		async (url: string, options?: ShopRequestOptions): Promise<ShopResponse> => {
			void options;
			const entry = replies[url];
			// An array answers one call each, in order; running out is an unexpected request.
			const reply = Array.isArray(entry) ? entry.shift() : entry;
			if (reply === undefined) throw new Error(`unexpected request to ${url}`);
			if (reply instanceof Error) throw reply;
			const headers = new Headers();
			if (reply.location !== undefined) headers.set('location', reply.location);
			for (const cookie of reply.setCookies ?? []) headers.append('set-cookie', cookie);
			return { status: reply.status, url: reply.url ?? url, headers, body: reply.body ?? null };
		}
	);
	const client: ShopClient = { request };
	return { client, request, urls: () => request.mock.calls.map(([url]) => url) };
}

function clientError(kind: 'timeout' | 'network') {
	return Object.assign(new Error(kind), { kind });
}

const plainPage = (): Reply => ({ status: 200, body: fixtures['synthetic-plain'] });

describe('amazonAdapter', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('unsupported', async () => {
		const { client, request } = fakeClient();

		for (const input of [
			'https://www.amazon.com/dp/B0ABC12345',
			'https://www.amazon.de/dp/B0ABC12345',
			'https://shop.example/p/1',
			'https://www.amazon.co.uk/s?k=tv',
			'garbage'
		]) {
			expect(await checkUrl(input, { client }), input).toStrictEqual({
				ok: false,
				reason: 'unsupported',
				message: 'unsupported URL'
			});
		}
		expect(request).toHaveBeenCalledTimes(0);
	});

	it('identify', () => {
		const ASIN = 'B0ABC12345';
		const canonicalUrl = `https://www.amazon.co.uk/dp/${ASIN}`;
		for (const input of [
			`https://www.amazon.co.uk/dp/${ASIN}`,
			`https://www.amazon.co.uk/gp/product/${ASIN}?psc=1`,
			`https://www.amazon.co.uk/Some-Product-Title/dp/${ASIN}/ref=sr_1_1?tag=x-21&th=1`,
			`https://amazon.co.uk/dp/${ASIN}`,
			`http://smile.amazon.co.uk/dp/${ASIN}?ref_=x`
		]) {
			expect(amazonAdapter.identify?.(new URL(input)), input).toStrictEqual({
				productId: ASIN,
				canonicalUrl
			});
		}
		for (const input of ['https://amzn.eu/d/abc1234', 'https://amzn.to/3xYzAbc']) {
			expect(amazonAdapter.identify?.(new URL(input)), input).toBeNull();
		}
	});

	it('identify is offline', async () => {
		// A fresh module graph in which every http-client function throws and is
		// recorded: creating a client (getSharedClient, createRateLimitedClient) or
		// reading its config fails at the call, and fetch is trapped as well.
		const calls: string[] = [];
		vi.resetModules();
		vi.doMock('../http-client.ts', async (importOriginal) => {
			const real = await importOriginal<Record<string, unknown>>();
			const trapped: Record<string, unknown> = { ...real };
			for (const [name, value] of Object.entries(real)) {
				if (typeof value === 'function' && name !== 'ClientError') {
					trapped[name] = (...args: unknown[]) => {
						calls.push(name);
						throw new Error(`identify reached http-client ${name}(${args.length} args)`);
					};
				}
			}
			return trapped;
		});
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			calls.push('fetch');
			throw new Error('identify must not make a request');
		});
		try {
			const { amazonAdapter: fresh } = await import('./adapter.ts');
			const { createShopRegistry: freshRegistry } = await import('../registry.ts');
			const registry = freshRegistry([fresh]);

			expect(registry.identify('https://www.amazon.co.uk/dp/B0ABC12345?tag=x')).toStrictEqual({
				kind: 'product',
				shop: 'amazon-uk',
				productId: 'B0ABC12345',
				canonicalUrl: 'https://www.amazon.co.uk/dp/B0ABC12345'
			});
			expect(registry.identify('https://amzn.eu/d/abc1234')).toStrictEqual({
				kind: 'needs_check'
			});
			expect(fresh.identify?.(new URL('https://amzn.to/3xYzAbc'))).toBeNull();

			// Let any fire-and-forget request reach fetch before asserting.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(calls).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.doUnmock('../http-client.ts');
			vi.resetModules();
		}
	});

	it('canonical fetch', async () => {
		const { client, urls } = fakeClient({ [PLAIN_FETCH]: plainPage() });

		const result = await checkUrl(
			`https://www.amazon.co.uk/Acme-Water-Bottle/dp/${PLAIN_ASIN}?tag=x-21&psc=1`,
			{ client }
		);

		expect(result).toMatchObject({ ok: true, productId: PLAIN_ASIN, pricePence: 1999 });
		expect(urls()).toEqual([PLAIN_FETCH]);
	});

	it('variant fetch', async () => {
		const child = 'B0TESTVAR2';
		const { client, urls } = fakeClient({
			[`https://www.amazon.co.uk/dp/${child}?psc=1`]: plainPage()
		});

		const result = await checkUrl(
			`https://www.amazon.co.uk/Multi-Gym-Weights/dp/${child}/ref=rvi_d_sccl_6?th=1&psc=1&tag=x-21`,
			{ client }
		);

		expect(urls()).toEqual([`https://www.amazon.co.uk/dp/${child}?psc=1`]);
		expect(result).toMatchObject({
			ok: true,
			productId: child,
			canonicalUrl: `https://www.amazon.co.uk/dp/${child}`
		});
	});

	it('short link', async () => {
		const { client, request, urls } = fakeClient({
			'https://amzn.eu/d/abc': {
				status: 301,
				location: `https://www.amazon.co.uk/Acme/dp/${PLAIN_ASIN}?ref=cm_sw_r`
			},
			[PLAIN_FETCH]: plainPage()
		});

		expect(await checkUrl('https://amzn.eu/d/abc', { client })).toMatchObject({
			ok: true,
			productId: PLAIN_ASIN,
			canonicalUrl: PLAIN_URL
		});
		expect(urls()).toEqual(['https://amzn.eu/d/abc', PLAIN_FETCH]);
		expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'manual', readBody: false });
		expect(request.mock.calls[1][1]?.method).toBe('GET');

		const offSite = fakeClient({
			'https://amzn.eu/d/off': { status: 301, location: `https://www.amazon.com/dp/${PLAIN_ASIN}` }
		});
		expect(await checkUrl('https://amzn.eu/d/off', { client: offSite.client })).toStrictEqual({
			ok: false,
			reason: 'unsupported',
			message: 'unsupported URL'
		});
		expect(offSite.urls()).toEqual(['https://amzn.eu/d/off']);
	});

	it('503 captcha', async () => {
		for (const status of [503, 200]) {
			const { client } = fakeClient({
				[PLAIN_FETCH]: { status, body: fixtures['synthetic-captcha'] }
			});
			expect(await checkUrl(PLAIN_URL, { client }), String(status)).toMatchObject({
				ok: false,
				reason: 'blocked'
			});
		}

		const { client } = fakeClient({ [PLAIN_FETCH]: { status: 503, body: 'Service Unavailable' } });
		expect(await checkUrl(PLAIN_URL, { client })).toMatchObject({
			ok: false,
			reason: 'fetch_failed',
			message: expect.stringContaining('503')
		});
	});

	it('status mapping', async () => {
		const cases: [Reply, string, string][] = [
			[{ status: 404, body: 'Not Found' }, 'not_found', '404'],
			[{ status: 403, body: 'Forbidden' }, 'fetch_failed', '403'],
			[{ status: 500, body: 'oops' }, 'fetch_failed', '500'],
			// A non-2xx must never be classified, even when its body is a priced page.
			[{ status: 403, body: fixtures['synthetic-plain'] }, 'fetch_failed', '403'],
			[{ status: 500, body: fixtures['synthetic-plain'] }, 'fetch_failed', '500'],
			// 300 is the first status past the 2xx range.
			[{ status: 300, body: fixtures['synthetic-plain'] }, 'fetch_failed', '300'],
			[clientError('timeout'), 'fetch_failed', 'timed out'],
			[clientError('network'), 'fetch_failed', 'network']
		];
		for (const [reply, reason, text] of cases) {
			const { client } = fakeClient({ [PLAIN_FETCH]: reply });
			const result = await checkUrl(PLAIN_URL, { client });

			expect(result, `${reason} ${text}`).toMatchObject({
				ok: false,
				reason,
				message: expect.stringContaining(text)
			});
			expect('pricePence' in result).toBe(false);
		}

		// 299 is the last status inside the 2xx range: the page is classified.
		const { client } = fakeClient({
			[PLAIN_FETCH]: { status: 299, body: fixtures['synthetic-plain'] }
		});
		expect(await checkUrl(PLAIN_URL, { client })).toMatchObject({ ok: true, pricePence: 1999 });
	});

	/** Checks PLAIN_URL with the plain fixture served from a given final URL. */
	async function landedAt(finalUrl: string) {
		const { client } = fakeClient({
			[PLAIN_FETCH]: { status: 200, body: fixtures['synthetic-plain'], url: finalUrl }
		});
		return checkUrl(PLAIN_URL, { client });
	}

	it('final url host', async () => {
		for (const finalUrl of [
			`https://www.amazon.com/dp/${PLAIN_ASIN}`,
			`https://evilamazon.co.uk/dp/${PLAIN_ASIN}`,
			`https://www.amazon.co.uk.evil.example/dp/${PLAIN_ASIN}`,
			`ftp://www.amazon.co.uk/dp/${PLAIN_ASIN}`,
			''
		]) {
			expect(await landedAt(finalUrl), finalUrl).toStrictEqual({
				ok: false,
				reason: 'fetch_failed',
				message: 'product page redirected off amazon.co.uk'
			});
		}
		for (const finalUrl of [
			`https://amazon.co.uk/dp/${PLAIN_ASIN}`,
			`https://smile.amazon.co.uk/dp/${PLAIN_ASIN}`
		]) {
			expect(await landedAt(finalUrl), finalUrl).toMatchObject({ ok: true, pricePence: 1999 });
		}
	});

	it('final url asin', async () => {
		for (const finalUrl of [
			'https://www.amazon.co.uk/dp/B0OTHERASN?psc=1',
			'https://www.amazon.co.uk/ap/signin?x=1',
			// Still amazon.co.uk: over http:, on the bare host, and on smile.
			'http://www.amazon.co.uk/ap/signin',
			'https://amazon.co.uk/ap/signin',
			'https://smile.amazon.co.uk/gp/help'
		]) {
			expect(await landedAt(finalUrl), finalUrl).toStrictEqual({
				ok: false,
				reason: 'fetch_failed',
				message: 'product page redirected to a different page'
			});
		}
		expect(
			await landedAt(`https://www.amazon.co.uk/Some-Slug/dp/${PLAIN_ASIN}?psc=1&th=1`)
		).toMatchObject({ ok: true, productId: PLAIN_ASIN, pricePence: 1999 });
	});

	it('failure passthrough', async () => {
		for (const name of [
			'synthetic-unavailable',
			'synthetic-variant-parent',
			'synthetic-no-price'
		]) {
			const body = fixtures[name];
			const { client } = fakeClient({ [PLAIN_FETCH]: { status: 200, body } });
			const expected = classifyProductPage(body);

			expect(expected.ok, name).toBe(false);
			expect(await checkUrl(PLAIN_URL, { client }), name).toStrictEqual(expected);
		}
	});

	it('direct unsupported', async () => {
		const { client, request } = fakeClient();

		expect(
			await amazonAdapter.check(new URL(`https://www.amazon.com/dp/${PLAIN_ASIN}`), { client })
		).toStrictEqual({ ok: false, reason: 'unsupported', message: 'unsupported URL' });
		expect(request).toHaveBeenCalledTimes(0);
	});

	it('headers', async () => {
		const { client, request } = fakeClient({ [PLAIN_FETCH]: plainPage() });

		await checkUrl(PLAIN_URL, { client });
		const headers = request.mock.calls[0][1]?.headers ?? {};
		const names = Object.keys(headers).map((name) => name.toLowerCase());

		expect(headers['accept-language']).toMatch(/^en-GB/);
		expect(headers['accept']).toMatch(/^text\/html/);
		expect(headers['user-agent']).toMatch(/^Mozilla\/5\.0 /);
		expect(headers['user-agent']).not.toMatch(/node|undici/i);
		expect(names).not.toContain('cookie');
	});

	it('ok shape', async () => {
		const { client } = fakeClient({ [PLAIN_FETCH]: plainPage() });

		expect(await checkUrl(PLAIN_URL, { client })).toStrictEqual({
			ok: true,
			shop: 'amazon-uk',
			productId: PLAIN_ASIN,
			canonicalUrl: PLAIN_URL,
			title: 'Acme Stainless Steel Water Bottle 750ml & Carry Loop',
			pricePence: 1999,
			imageUrl: 'https://m.media-amazon.com/images/I/71TestPlnA._AC_SL1500_.jpg'
		});
		expect(amazonAdapter.fixturesDir).toMatch(/[/\\]amazon[/\\]fixtures[/\\]?$/);
		expect(existsSync(amazonAdapter.fixturesDir)).toBe(true);
	});

	it('shared client', async () => {
		const shared = getSharedClient();
		const request = vi.spyOn(shared, 'request').mockImplementation(async (url) => ({
			status: 200,
			url,
			headers: new Headers(),
			body: fixtures['synthetic-plain']
		}));

		await checkUrl(PLAIN_URL);
		await checkUrl(PLAIN_URL);

		expect(getSharedClient()).toBe(shared);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('real client timeout', async () => {
		vi.useFakeTimers();
		const neverResolves = vi.fn(() => new Promise<Response>(() => {}));
		const client = createRateLimitedClient({ fetch: neverResolves, timeoutMs: 15000 });

		const pending = checkUrl(PLAIN_URL, { client });
		await vi.advanceTimersByTimeAsync(15000);

		expect(await pending).toMatchObject({
			ok: false,
			reason: 'fetch_failed',
			message: expect.stringContaining('timed out')
		});
		expect(neverResolves).toHaveBeenCalledOnce();
	});
});

describe('click-through wall', () => {
	const wallHtml = fixtures['recorded-captcha-continue'];
	const SUBMIT = clickThroughUrl(wallHtml) as string;
	const wall = (): Reply => ({ status: 200, body: wallHtml });
	const cleared = (): Reply => ({
		status: 302,
		location: '/',
		setCookies: ['x-amz-captcha-1=one; path=/; secure', 'x-amz-captcha-2=two; path=/']
	});
	const check = (adapter: ReturnType<typeof createAmazonAdapter>, client: ShopClient) =>
		adapter.check(new URL(PLAIN_URL), { client });

	it('submits the wall and retries the page with its cookies', async () => {
		const { client, request, urls } = fakeClient({
			[PLAIN_FETCH]: [wall(), plainPage()],
			[SUBMIT]: cleared()
		});

		expect(await check(createAmazonAdapter(), client)).toMatchObject({
			ok: true,
			pricePence: 1999
		});
		expect(urls()).toEqual([PLAIN_FETCH, SUBMIT, PLAIN_FETCH]);
		expect(request.mock.calls[0][1]?.headers).toEqual(REQUEST_HEADERS);
		expect(request.mock.calls[1][1]).toEqual({
			method: 'GET',
			redirect: 'manual',
			readBody: false,
			headers: { ...REQUEST_HEADERS, referer: PLAIN_FETCH }
		});
		expect(request.mock.calls[2][1]?.headers).toEqual({
			...REQUEST_HEADERS,
			cookie: 'x-amz-captcha-1=one; x-amz-captcha-2=two'
		});
	});

	it('reuses the cookies on later checks', async () => {
		const adapter = createAmazonAdapter();
		await check(
			adapter,
			fakeClient({ [PLAIN_FETCH]: [wall(), plainPage()], [SUBMIT]: cleared() }).client
		);

		const { client, request, urls } = fakeClient({ [PLAIN_FETCH]: plainPage() });
		expect(await check(adapter, client)).toMatchObject({ ok: true });
		expect(urls()).toEqual([PLAIN_FETCH]);
		expect(request.mock.calls[0][1]?.headers).toMatchObject({
			cookie: 'x-amz-captcha-1=one; x-amz-captcha-2=two'
		});
	});

	it('keeps cookies a page sets', async () => {
		const adapter = createAmazonAdapter();
		const page: Reply = {
			status: 200,
			body: fixtures['synthetic-plain'],
			setCookies: ['session-id=abc; path=/']
		};
		await check(adapter, fakeClient({ [PLAIN_FETCH]: page }).client);

		const { client, request } = fakeClient({ [PLAIN_FETCH]: plainPage() });
		await check(adapter, client);
		expect(request.mock.calls[0][1]?.headers).toMatchObject({ cookie: 'session-id=abc' });
	});

	it('never submits a real captcha', async () => {
		const { client, urls } = fakeClient({
			[PLAIN_FETCH]: { status: 200, body: fixtures['synthetic-captcha'] }
		});

		expect(await check(createAmazonAdapter(), client)).toMatchObject({ reason: 'blocked' });
		expect(urls()).toEqual([PLAIN_FETCH]);
	});

	it('stops at a second wall', async () => {
		const { client, urls } = fakeClient({
			[PLAIN_FETCH]: [wall(), wall()],
			[SUBMIT]: cleared()
		});

		expect(await check(createAmazonAdapter(), client)).toMatchObject({ reason: 'blocked' });
		expect(urls()).toEqual([PLAIN_FETCH, SUBMIT, PLAIN_FETCH]);
	});

	it('does not retry when the submit is refused', async () => {
		const { client, urls } = fakeClient({ [PLAIN_FETCH]: wall(), [SUBMIT]: { status: 200 } });

		expect(await check(createAmazonAdapter(), client)).toMatchObject({ reason: 'blocked' });
		expect(urls()).toEqual([PLAIN_FETCH, SUBMIT]);
	});

	it('reports a submit that times out as a fetch failure', async () => {
		const { client } = fakeClient({
			[PLAIN_FETCH]: wall(),
			[SUBMIT]: clientError('timeout')
		});

		expect(await check(createAmazonAdapter(), client)).toStrictEqual({
			ok: false,
			reason: 'fetch_failed',
			message: 'product page request timed out'
		});
	});
});
