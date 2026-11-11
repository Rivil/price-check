import { describe, expect, it, vi } from 'vitest';
import { amazonAdapter } from './amazon/adapter.ts';
import { createShopRegistry } from './registry.ts';
import {
	clientErrorKind,
	failure,
	type CheckResult,
	type FailureReason,
	type ShopAdapter,
	type ShopClient
} from './types.ts';

// Compile-time: adding a reason to the union without listing it here fails svelte-check.
const REASONS = {
	unsupported: true,
	blocked: true,
	unavailable: true,
	variant_required: true,
	parse_failed: true,
	not_found: true,
	fetch_failed: true
} satisfies Record<FailureReason, true>;

function fakeClient() {
	const request = vi.fn<ShopClient['request']>(async (url) => ({
		status: 200,
		url,
		headers: new Headers(),
		body: ''
	}));
	return { client: { request } satisfies ShopClient, request };
}

function stubShop(id: string, host: string, result?: Partial<CheckResult>) {
	const claims = vi.fn((url: URL) => url.hostname === host);
	const check = vi.fn<ShopAdapter['check']>(
		async (url): Promise<CheckResult> =>
			({
				ok: true,
				shop: id,
				productId: url.pathname,
				canonicalUrl: url.href,
				title: `${id} product`,
				pricePence: 100,
				imageUrl: null,
				...result
			}) as CheckResult
	);
	const adapter: ShopAdapter = { id, fixturesDir: `/fixtures/${id}`, claims, check };
	return { adapter, claims, check };
}

describe('failure', () => {
	it('failure shape', () => {
		const result = failure('blocked', 'captcha page');

		expect(Object.keys(result)).toEqual(['ok', 'reason', 'message']);
		expect(result).toEqual({ ok: false, reason: 'blocked', message: 'captcha page' });
		expect('pricePence' in result).toBe(false);
	});

	it('failure validation', () => {
		for (const reason of Object.keys(REASONS) as FailureReason[]) {
			expect(failure(reason, 'why').reason).toBe(reason);
		}
		expect(failure('blocked', 'x'.repeat(120)).message).toHaveLength(120);

		expect(() => failure('blocked', '')).toThrow();
		expect(() => failure('blocked', '   ')).toThrow();
		expect(() => failure('blocked', 'x'.repeat(121))).toThrow();
		expect(() => failure('bogus' as FailureReason, 'why')).toThrow();
		expect(() => failure('toString' as FailureReason, 'why')).toThrow();
	});

	it('client error kind', () => {
		expect(clientErrorKind(Object.assign(new Error('t'), { kind: 'timeout' }))).toBe('timeout');
		expect(clientErrorKind(Object.assign(new Error('n'), { kind: 'network' }))).toBe('network');
		expect(clientErrorKind(Object.assign(new Error('x'), { kind: 'other' }))).toBeNull();
		expect(clientErrorKind(new Error('plain'))).toBeNull();
		expect(clientErrorKind({ kind: 'timeout' })).toBeNull();
	});
});

describe('createShopRegistry', () => {
	it('claims routing', async () => {
		const a = stubShop('a', 'a.example');
		const b = stubShop('b', 'b.example');
		const registry = createShopRegistry([a.adapter, b.adapter]);
		const { client } = fakeClient();

		const resolution = registry.resolve('https://b.example/p/1');
		expect(resolution.kind === 'adapter' && resolution.adapter).toBe(b.adapter);
		expect(resolution.kind === 'adapter' && resolution.url.href).toBe('https://b.example/p/1');

		const result = await registry.check('https://b.example/p/1', { client });
		expect(result).toMatchObject({ ok: true, shop: 'b', productId: '/p/1' });
		expect(b.check).toHaveBeenCalledOnce();
		expect(b.check.mock.calls[0][1]).toEqual({ client });
		expect(a.check).not.toHaveBeenCalled();
	});

	it('garbage input', () => {
		const a = stubShop('a', 'a.example');
		const registry = createShopRegistry([a.adapter]);

		for (const input of ['not a url', '', 'javascript:alert(1)', 'ftp://a.example/p/1']) {
			expect(registry.resolve(input), input).toEqual({ kind: 'unsupported' });
		}
		expect(a.claims).toHaveBeenCalledTimes(0);
	});

	it('input', () => {
		const a = stubShop('a', 'shop.example');
		const registry = createShopRegistry([a.adapter]);

		for (const input of [
			'  https://shop.example/p/1  ',
			// String.trim removes a no-break space; the URL parser alone would reject it.
			' https://shop.example/p/1 ',
			'https://shop.example/p/1',
			'http://shop.example/p/1'
		]) {
			const resolution = registry.resolve(input);
			expect(resolution.kind === 'adapter' && resolution.adapter.id, input).toBe('a');
		}
		a.claims.mockClear();

		for (const input of ['ftp://shop.example/p/1', 'mailto:x@shop.example']) {
			expect(registry.resolve(input), input).toEqual({ kind: 'unsupported' });
		}
		expect(a.claims).not.toHaveBeenCalled();
	});

	it('claims throws', async () => {
		const a = stubShop('a', 'shop.example');
		a.claims.mockImplementation(() => {
			throw new Error('claims blew up');
		});
		const registry = createShopRegistry([a.adapter]);
		const { client, request } = fakeClient();

		const result = await registry.check('https://shop.example/p/1', { client });

		expect(result).toStrictEqual({
			ok: false,
			reason: 'fetch_failed',
			message: 'check failed: claims blew up'
		});
		expect(a.check).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it('first claimant', () => {
		const first = stubShop('first', 'example.test');
		const second = stubShop('second', 'example.test');
		const registry = createShopRegistry([first.adapter, second.adapter]);

		const resolution = registry.resolve('https://example.test/x');
		expect(resolution.kind === 'adapter' && resolution.adapter.id).toBe('first');

		const twin = stubShop('first', 'other.test');
		expect(() => createShopRegistry([first.adapter, twin.adapter])).toThrow('first');
	});

	it('unsupported', async () => {
		const a = stubShop('a', 'a.example');
		const registry = createShopRegistry([a.adapter]);
		const { client, request } = fakeClient();

		for (const input of ['https://elsewhere.example/p/1', 'garbage']) {
			const result = await registry.check(input, { client });
			expect(result).toStrictEqual({
				ok: false,
				reason: 'unsupported',
				message: 'unsupported URL'
			});
		}
		expect(a.check).not.toHaveBeenCalled();
		expect(request).toHaveBeenCalledTimes(0);
	});

	it('identify', () => {
		const a = stubShop('a', 'a.example');
		a.adapter.identify = vi.fn((url: URL) =>
			url.pathname.startsWith('/p/')
				? { productId: url.pathname.slice(3), canonicalUrl: `https://a.example${url.pathname}` }
				: null
		);
		const registry = createShopRegistry([a.adapter]);

		expect(registry.identify(' https://a.example/p/42?ref=x ')).toStrictEqual({
			kind: 'product',
			shop: 'a',
			productId: '42',
			canonicalUrl: 'https://a.example/p/42'
		});
		// Claimed, but the adapter cannot name the product offline.
		expect(registry.identify('https://a.example/short/abc')).toStrictEqual({ kind: 'needs_check' });
		for (const input of ['https://elsewhere.example/p/1', 'garbage', 'ftp://a.example/p/1']) {
			expect(registry.identify(input), input).toStrictEqual({ kind: 'unsupported' });
		}
		expect(a.check).not.toHaveBeenCalled();
	});

	it('identify amazon', () => {
		const registry = createShopRegistry([amazonAdapter]);

		expect(registry.identify('https://www.amazon.co.uk/gp/product/B0ABC12345?psc=1')).toStrictEqual(
			{
				kind: 'product',
				shop: 'amazon-uk',
				productId: 'B0ABC12345',
				canonicalUrl: 'https://www.amazon.co.uk/dp/B0ABC12345'
			}
		);
		for (const input of ['https://amzn.eu/d/abc1234', 'https://amzn.to/3xYzAbc']) {
			expect(registry.identify(input), input).toStrictEqual({ kind: 'needs_check' });
		}
		for (const input of [
			'https://www.amazon.com/dp/B0ABC12345',
			'https://www.amazon.co.uk/s?k=tv',
			'https://www.amazon.co.uk/b?node=123'
		]) {
			expect(registry.identify(input), input).toStrictEqual({ kind: 'unsupported' });
		}
	});

	it('identify optional', () => {
		const plain = stubShop('plain', 'plain.example');
		expect(plain.adapter.identify).toBeUndefined();
		const registry = createShopRegistry([plain.adapter]);

		expect(registry.identify('https://plain.example/p/1')).toStrictEqual({ kind: 'needs_check' });
		expect(plain.check).not.toHaveBeenCalled();
	});

	it('identify never throws', () => {
		const a = stubShop('a', 'a.example');
		a.adapter.identify = () => {
			throw new Error('identify blew up');
		};
		const b = stubShop('b', 'b.example');
		b.claims.mockImplementation(() => {
			throw new Error('claims blew up');
		});
		const registry = createShopRegistry([a.adapter, b.adapter]);

		expect(registry.identify('https://a.example/p/1')).toStrictEqual({ kind: 'needs_check' });
		expect(registry.identify('https://b.example/p/1')).toStrictEqual({ kind: 'needs_check' });
	});

	it('never rejects', async () => {
		const broken = stubShop('broken', 'broken.example');
		broken.check.mockRejectedValue(new Error('boom'));
		const registry = createShopRegistry([broken.adapter]);
		const { client } = fakeClient();

		const result = await registry.check('https://broken.example/p/1', { client });

		expect(result).toEqual({ ok: false, reason: 'fetch_failed', message: 'check failed: boom' });

		broken.check.mockRejectedValue(new Error('x'.repeat(500)));
		const long = await registry.check('https://broken.example/p/1', { client });
		expect(long.ok === false && long.message.length).toBeLessThanOrEqual(120);
	});
});
