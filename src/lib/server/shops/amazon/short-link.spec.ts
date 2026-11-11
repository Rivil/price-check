import { describe, expect, it, vi } from 'vitest';
import type { ShopClient, ShopRequestOptions, ShopResponse } from '../types.ts';
import { resolveShortLink } from './short-link.ts';

const ASIN = 'B0ABC12345';
const CANONICAL = `https://www.amazon.co.uk/dp/${ASIN}`;

type Reply = { status: number; location?: string } | Error;

/** A client answering each URL from a table; any unlisted URL is a test failure. */
function fakeClient(replies: Record<string, Reply>) {
	const request = vi.fn(
		async (url: string, options?: ShopRequestOptions): Promise<ShopResponse> => {
			void options;
			const reply = replies[url];
			if (reply === undefined) throw new Error(`unexpected request to ${url}`);
			if (reply instanceof Error) throw reply;
			const headers = new Headers();
			if (reply.location !== undefined) headers.set('location', reply.location);
			return { status: reply.status, url, headers, body: null };
		}
	);
	const client: ShopClient = { request };
	return { client, request, urls: () => request.mock.calls.map(([url]) => url) };
}

function clientError(kind: 'timeout' | 'network') {
	return Object.assign(new Error(kind), { kind });
}

describe('resolveShortLink', () => {
	it('single hop', async () => {
		const { client, request, urls } = fakeClient({
			'https://amzn.eu/d/x': {
				status: 301,
				location: `https://www.amazon.co.uk/Some-Title/dp/${ASIN}?ref=cm_sw_r_cp&th=1`
			}
		});

		const result = await resolveShortLink('https://amzn.eu/d/x', client);

		expect(result).toEqual({ ok: true, asin: ASIN, canonicalUrl: CANONICAL });
		expect(urls()).toEqual(['https://amzn.eu/d/x']);
		expect(request.mock.calls[0][1]).toEqual({
			method: 'GET',
			redirect: 'manual',
			readBody: false
		});
	});

	it('multi hop', async () => {
		const { client, request, urls } = fakeClient({
			'https://amzn.to/3xYz': { status: 301, location: 'https://amzn.eu/d/abc' },
			'https://amzn.eu/d/abc': { status: 302, location: `https://www.amazon.co.uk/dp/${ASIN}` }
		});

		const result = await resolveShortLink('https://amzn.to/3xYz', client);

		expect(result).toEqual({ ok: true, asin: ASIN, canonicalUrl: CANONICAL });
		expect(urls()).toEqual(['https://amzn.to/3xYz', 'https://amzn.eu/d/abc']);
		for (const [, options] of request.mock.calls) {
			expect(options).toMatchObject({ redirect: 'manual', readBody: false });
		}
	});

	it('relative location', async () => {
		const { client, urls } = fakeClient({
			'https://amzn.eu/d/rel': { status: 302, location: '/d/next' },
			'https://amzn.eu/d/next': { status: 301, location: `/dp/${ASIN}` }
		});

		// '/dp/X' against an amzn.eu hop is amzn.eu/dp/X: not a product host, not a short link.
		expect(await resolveShortLink('https://amzn.eu/d/rel', client)).toEqual({
			ok: false,
			reason: 'unsupported',
			message: 'unsupported URL'
		});
		expect(urls()).toEqual(['https://amzn.eu/d/rel', 'https://amzn.eu/d/next']);

		const coUk = fakeClient({
			'https://amzn.eu/d/co': { status: 301, location: '//www.amazon.co.uk/dp/' + ASIN }
		});
		expect(await resolveShortLink('https://amzn.eu/d/co', coUk.client)).toEqual({
			ok: true,
			asin: ASIN,
			canonicalUrl: CANONICAL
		});
	});

	it('off-site', async () => {
		for (const location of [
			`https://www.amazon.com/dp/${ASIN}`,
			`https://www.amazon.de/dp/${ASIN}`,
			'https://www.amazon.co.uk/s?k=tv',
			'https://shop.example/p/1'
		]) {
			const { client, urls } = fakeClient({ 'https://amzn.eu/d/off': { status: 301, location } });

			expect(await resolveShortLink('https://amzn.eu/d/off', client), location).toEqual({
				ok: false,
				reason: 'unsupported',
				message: 'unsupported URL'
			});
			expect(urls()).toEqual(['https://amzn.eu/d/off']);
		}
	});

	it('too many redirects', async () => {
		const loop = fakeClient({ 'https://amzn.to/loop': { status: 301, location: '/loop' } });
		expect(await resolveShortLink('https://amzn.to/loop', loop.client)).toEqual({
			ok: false,
			reason: 'fetch_failed',
			message: 'too many redirects'
		});
		expect(loop.request).toHaveBeenCalledTimes(5);

		const chain = fakeClient(
			Object.fromEntries(
				[1, 2, 3, 4, 5].map((n) => [
					`https://amzn.to/h${n}`,
					{ status: 301, location: `https://amzn.to/h${n + 1}` }
				])
			)
		);
		expect(await resolveShortLink('https://amzn.to/h1', chain.client)).toMatchObject({
			reason: 'fetch_failed',
			message: 'too many redirects'
		});
		expect(chain.urls()).toEqual([1, 2, 3, 4, 5].map((n) => `https://amzn.to/h${n}`));
	});

	it('hop errors', async () => {
		const cases: [Reply, string][] = [
			[{ status: 301 }, 'fetch_failed'],
			[{ status: 200 }, 'fetch_failed'],
			[{ status: 500 }, 'fetch_failed'],
			[{ status: 404 }, 'not_found'],
			[clientError('timeout'), 'fetch_failed'],
			[clientError('network'), 'fetch_failed']
		];
		for (const [reply, reason] of cases) {
			const { client, request } = fakeClient({ 'https://amzn.eu/d/err': reply });
			const result = await resolveShortLink('https://amzn.eu/d/err', client);

			expect(result, JSON.stringify(reply)).toMatchObject({ ok: false, reason });
			expect('pricePence' in result).toBe(false);
			expect(request).toHaveBeenCalledOnce();
		}

		const timedOut = fakeClient({ 'https://amzn.eu/d/t': clientError('timeout') });
		expect(await resolveShortLink('https://amzn.eu/d/t', timedOut.client)).toMatchObject({
			message: expect.stringContaining('timed out')
		});
	});

	it('failure messages', async () => {
		const cases: [Reply, { reason: string; message: string }][] = [
			[clientError('network'), { reason: 'fetch_failed', message: 'short link request failed' }],
			[clientError('timeout'), { reason: 'fetch_failed', message: 'short link request timed out' }],
			[
				{ status: 200 },
				{ reason: 'fetch_failed', message: 'short link did not redirect (HTTP 200)' }
			],
			[{ status: 404 }, { reason: 'not_found', message: 'short link not found (HTTP 404)' }],
			[
				{ status: 301 },
				{ reason: 'fetch_failed', message: 'short link redirect had no Location header' }
			],
			[
				{ status: 301, location: '   ' },
				{ reason: 'fetch_failed', message: 'short link redirect had no Location header' }
			],
			[
				{ status: 301, location: 'http://[' },
				{ reason: 'unsupported', message: 'unsupported URL' }
			]
		];
		for (const [reply, expected] of cases) {
			const { client, urls } = fakeClient({ 'https://amzn.eu/d/msg': reply });

			expect(
				await resolveShortLink('https://amzn.eu/d/msg', client),
				JSON.stringify(reply)
			).toEqual({ ok: false, ...expected });
			// Only the short link itself was requested; no product page.
			expect(urls()).toEqual(['https://amzn.eu/d/msg']);
		}
	});

	it('bad scheme', async () => {
		for (const location of ['javascript:alert(1)', `ftp://www.amazon.co.uk/dp/${ASIN}`]) {
			const { client, urls } = fakeClient({ 'https://amzn.eu/d/bad': { status: 302, location } });

			expect(await resolveShortLink('https://amzn.eu/d/bad', client), location).toEqual({
				ok: false,
				reason: 'unsupported',
				message: 'unsupported URL'
			});
			expect(urls()).toEqual(['https://amzn.eu/d/bad']);
		}
	});

	it('non-short input', async () => {
		for (const input of [CANONICAL, `https://www.amazon.com/dp/${ASIN}`, 'not a url']) {
			const { client, request } = fakeClient({});

			expect(await resolveShortLink(input, client), input).toEqual({
				ok: false,
				reason: 'unsupported',
				message: 'unsupported URL'
			});
			expect(request).not.toHaveBeenCalled();
		}
	});
});
