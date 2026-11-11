import { expect, test } from '@playwright/test';

test('health public', async ({ request }) => {
	const res = await request.get('/health', { maxRedirects: 0 });

	expect(res.status()).toBe(200);
	expect(res.headers()['cache-control']).toBe('no-store');
	expect(await res.text()).toBe('{"status":"ok"}');
});

test('health exact path', async ({ request }) => {
	for (const path of ['/healthx', '/health/anything']) {
		const res = await request.get(path, { maxRedirects: 0 });

		expect(res.status(), path).toBe(303);
		expect(res.headers().location, path).toBe('/login');
	}
});
