import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { createLocalRequestHandle, isLoopbackHost } from './local-request.ts';

describe('isLoopbackHost', () => {
	const accepted = ['localhost', 'localhost:4173', '127.0.0.1', '127.0.0.1:65535', 'LocalHost:80'];
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
});
