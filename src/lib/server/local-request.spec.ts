import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { createLocalRequestHandle, isLoopbackHost } from './local-request.ts';
import localRequestSource from './local-request.ts?raw';

describe('isLoopbackHost', () => {
	// Both ends of the port range, on both names.
	const accepted = [
		'localhost',
		'localhost:4173',
		'localhost:1',
		'localhost:65535',
		'127.0.0.1',
		'127.0.0.1:1',
		'127.0.0.1:65535',
		'LocalHost:80'
	];
	const rejected = [
		null,
		'',
		'evil.example',
		'evil.example:4173',
		'localhost.evil.example',
		'evil.com:localhost',
		'127.0.0.1.nip.io',
		'localhost.',
		'[::1]',
		'[::1]:4173',
		'0.0.0.0',
		'127.0.0.2',
		'localhost:',
		'localhost:abc',
		'localhost:123456',
		'localhost:0',
		'localhost:65536',
		'user@localhost',
		'localhost, evil.com',
		' localhost',
		'localhost '
	];

	it.each(accepted)('accepts %j', (host) => {
		expect(isLoopbackHost(host)).toBe(true);
	});

	it.each(rejected)('rejects %j', (host) => {
		expect(isLoopbackHost(host)).toBe(false);
	});
});

describe('createLocalRequestHandle', () => {
	function fakeEvent(url: string, headers: Record<string, string>) {
		const parsed = new URL(url);
		return {
			url: parsed,
			route: { id: parsed.pathname === '/health' ? '/health' : '/' },
			request: new Request(parsed, { headers }),
			locals: {}
		} as unknown as RequestEvent;
	}

	async function run(event: RequestEvent) {
		const resolve = vi.fn(async () => new Response('ok'));
		const res = await createLocalRequestHandle()({ event, resolve });
		return { res, resolve };
	}

	it('resolves loopback requests', async () => {
		for (const host of ['localhost:4173', '127.0.0.1:5000', 'localhost']) {
			const event = fakeEvent('http://localhost:4173/', { host });
			const { res, resolve } = await run(event);

			expect(res.status, host).toBe(200);
			expect(resolve, host).toHaveBeenCalledExactlyOnceWith(event);
		}
	});

	it('reads the Host header, not event.url', async () => {
		const { res, resolve } = await run(fakeEvent('http://localhost/', { host: 'evil.example' }));

		expect(res.status).toBe(403);
		expect(await res.text()).toBe('Forbidden');
		expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('ignores X-Forwarded-Host', async () => {
		const { res, resolve } = await run(
			fakeEvent('http://localhost/', { host: 'evil.example', 'x-forwarded-host': 'localhost' })
		);

		expect(res.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('guards /health too', async () => {
		const { res, resolve } = await run(
			fakeEvent('http://localhost:4173/health', { host: 'evil.example:4173' })
		);

		expect(res.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('rejects a foreign Host on a 127.0.0.1 URL', async () => {
		const event = fakeEvent('http://127.0.0.1:4173/', { host: 'rebind.example:4173' });
		const { res, resolve } = await run(event);

		expect(res.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});

	const ORIGIN = 'http://127.0.0.1:4173';
	const HOST = '127.0.0.1:4173';

	/** The bodies a cross-site page can send without a preflight, plus JSON. */
	function bodies(): [string, () => { body: BodyInit; headers: Record<string, string> }][] {
		return [
			[
				'form',
				() => ({
					body: new URLSearchParams({ url: 'https://shop.invalid/1' }),
					headers: { 'content-type': 'application/x-www-form-urlencoded' }
				})
			],
			[
				'multipart',
				() => {
					const form = new FormData();
					form.set('url', 'https://shop.invalid/1');
					return { body: form, headers: {} };
				}
			],
			[
				'text/plain',
				() => ({ body: 'url=https://shop.invalid/1', headers: { 'content-type': 'text/plain' } })
			],
			[
				'JSON',
				() => ({
					body: JSON.stringify({ url: 'https://shop.invalid/1' }),
					headers: { 'content-type': 'application/json' }
				})
			]
		];
	}

	function post(origin: string | undefined, body: ReturnType<ReturnType<typeof bodies>[0][1]>) {
		const url = new URL(`${ORIGIN}/?/add`);
		const headers: Record<string, string> = { host: HOST, ...body.headers };
		if (origin !== undefined) headers.origin = origin;
		return {
			url,
			route: { id: '/' },
			request: new Request(url, { method: 'POST', headers, body: body.body }),
			locals: {}
		} as unknown as RequestEvent;
	}

	it('foreign Origin refused', async () => {
		const origins: [string, string | undefined][] = [
			['evil', 'https://evil.example'],
			["'null'", 'null'],
			['other port', 'http://127.0.0.1:4174'],
			['https same host', `https://${HOST}`],
			['other loopback name', 'http://localhost:4173'],
			['none', undefined]
		];
		for (const [what, origin] of origins) {
			for (const [kind, body] of bodies()) {
				const { res, resolve } = await run(post(origin, body()));
				expect(res.status, `${what} ${kind}`).toBe(403);
				expect(await res.text(), `${what} ${kind}`).toBe('Forbidden');
				expect(res.headers.get('x-frame-options'), `${what} ${kind}`).toBe('DENY');
				expect(resolve, `${what} ${kind}`).not.toHaveBeenCalled();
			}
		}
	});

	it('foreign Origin refused for every unsafe method', async () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			const event = {
				url: new URL(`${ORIGIN}/`),
				route: { id: '/' },
				request: new Request(`${ORIGIN}/`, {
					method,
					headers: { host: HOST, origin: 'https://evil.example' }
				}),
				locals: {}
			} as unknown as RequestEvent;
			const { res, resolve } = await run(event);
			expect(res.status, method).toBe(403);
			expect(resolve, method).not.toHaveBeenCalled();
		}
	});

	it('same-origin posts and foreign-Origin reads are served', async () => {
		for (const [kind, body] of bodies()) {
			const event = post(ORIGIN, body());
			const { res, resolve } = await run(event);
			expect(res.status, kind).toBe(200);
			expect(resolve, kind).toHaveBeenCalledExactlyOnceWith(event);
		}
		for (const method of ['GET', 'HEAD', 'OPTIONS']) {
			const event = {
				url: new URL(`${ORIGIN}/`),
				route: { id: '/' },
				request: new Request(`${ORIGIN}/`, {
					method,
					headers: { host: HOST, origin: 'https://evil.example' }
				}),
				locals: {}
			} as unknown as RequestEvent;
			const { res, resolve } = await run(event);
			expect(res.status, method).toBe(200);
			expect(resolve, method).toHaveBeenCalledExactlyOnceWith(event);
		}
	});

	it('every response denies framing', async () => {
		for (const status of [200, 404, 500]) {
			const resolve = vi.fn(async () => new Response('page', { status }));
			const res = await createLocalRequestHandle()({
				event: fakeEvent(`${ORIGIN}/`, { host: HOST }),
				resolve
			});
			expect(res.status, String(status)).toBe(status);
			expect(res.headers.get('x-frame-options'), String(status)).toBe('DENY');
		}
		// A refusal too.
		const { res } = await run(fakeEvent(`${ORIGIN}/`, { host: 'evil.example' }));
		expect(res.headers.get('x-frame-options')).toBe('DENY');
	});

	it('has no dev or building branch', () => {
		const code = localRequestSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
		expect(code).not.toMatch(/\$app\//);
		expect(code).not.toMatch(/\b(?:dev|building)\b/);
		expect(code).not.toMatch(/import\.meta\.env/);
	});
});
