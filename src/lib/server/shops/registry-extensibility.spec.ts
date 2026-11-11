// c-6: a second shop slots in with no change to the Amazon adapter or the
// caller-facing API. Imports only the public exports of index.ts, registry.ts
// and types.ts.
import { describe, expect, it, vi } from 'vitest';
import { amazonAdapter, createShopRegistry } from './index.ts';
import type { ShopRegistry } from './registry.ts';
import type { CheckResult, ShopAdapter, ShopClient } from './types.ts';

/** A shop that exists only in this test. */
const stubShop: ShopAdapter = {
	id: 'stub-shop',
	fixturesDir: '/nonexistent/stub-shop/fixtures',
	claims: (url) => url.hostname === 'shop.example',
	async check(url, { client }): Promise<CheckResult> {
		const response = await client.request(url.href);
		return {
			ok: true,
			shop: 'stub-shop',
			productId: url.pathname.split('/').at(-1) ?? '',
			canonicalUrl: url.href,
			title: response.body ?? '',
			pricePence: 4200,
			imageUrl: null
		};
	}
};

function fakeClient() {
	const request = vi.fn<ShopClient['request']>(async (url) => ({
		status: 200,
		url,
		headers: new Headers(),
		body: 'Stub Product'
	}));
	return { client: { request } satisfies ShopClient, request };
}

describe('registry extensibility', () => {
	const registry: ShopRegistry = createShopRegistry([amazonAdapter, stubShop]);

	it('resolves and checks a stub shop', async () => {
		const { client, request } = fakeClient();

		const resolution = registry.resolve('https://shop.example/p/1');
		expect(resolution.kind === 'adapter' && resolution.adapter.id).toBe('stub-shop');

		expect(await registry.check('https://shop.example/p/1', { client })).toStrictEqual({
			ok: true,
			shop: 'stub-shop',
			productId: '1',
			canonicalUrl: 'https://shop.example/p/1',
			title: 'Stub Product',
			pricePence: 4200,
			imageUrl: null
		});
		expect(request.mock.calls.map(([url]) => url)).toEqual(['https://shop.example/p/1']);
	});

	it('amazon still routes to amazon-uk', () => {
		for (const input of ['https://www.amazon.co.uk/dp/B0ABC12345', 'https://amzn.eu/d/AbC123']) {
			const resolution = registry.resolve(input);
			expect(resolution.kind === 'adapter' && resolution.adapter.id, input).toBe('amazon-uk');
		}
	});

	it('other marketplaces stay unsupported', async () => {
		const { client, request } = fakeClient();

		expect(registry.resolve('https://www.amazon.com/dp/B0ABC12345')).toEqual({
			kind: 'unsupported'
		});
		expect(await registry.check('https://www.amazon.com/dp/B0ABC12345', { client })).toStrictEqual({
			ok: false,
			reason: 'unsupported',
			message: 'unsupported URL'
		});
		expect(request).toHaveBeenCalledTimes(0);
	});
});
