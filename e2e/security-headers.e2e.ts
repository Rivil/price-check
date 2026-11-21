// c-6 and c-23 on the preview build (SEC-05, SEC-15): every page carries a strict
// Content-Security-Policy that forbids framing, allows scripts only from the app
// itself and Kit's per-response nonce, and images only from the app and Amazon's
// CDN. Kit writes the header from kit.csp in vite.config.ts; the server hook adds
// X-Frame-Options: DENY. Read-only: plain GETs, no form posts, no live fetch (r-01).
import { expect, test, type APIResponse } from '@playwright/test';
import { SEEDED_WATCHES } from './accounts.ts';

const PAGES: [what: string, path: string, status: number][] = [
	['watchlist', '/', 200],
	['alerts', '/account/alerts', 200],
	['watch', `/watches/${SEEDED_WATCHES.pageDetail.id}`, 200],
	['404', '/no-such-page-e2e', 404]
];

/** The policy as directive name → its sources, in order. */
function parseCsp(header: string): Map<string, string[]> {
	const directives = new Map<string, string[]>();
	for (const part of header.split(';')) {
		const [name, ...sources] = part.trim().split(/\s+/);
		if (name) directives.set(name.toLowerCase(), sources);
	}
	return directives;
}

async function policy(res: APIResponse, what: string): Promise<Map<string, string[]>> {
	const header = res.headers()['content-security-policy'];
	expect(header, `${what}: Content-Security-Policy`).toBeTruthy();
	return parseCsp(header!);
}

const NONCE = /^'nonce-[A-Za-z0-9+/_=-]+'$/;
const HASH = /^'sha256-[A-Za-z0-9+/_=-]+'$/;

for (const [what, path, status] of PAGES) {
	test(`${what} page has a strict CSP`, async ({ request }) => {
		const res = await request.get(path, { maxRedirects: 0 });
		expect(res.status(), what).toBe(status);
		expect(res.headers()['x-frame-options'], what).toBe('DENY');
		const csp = await policy(res, what);

		expect(csp.get('frame-ancestors'), what).toEqual(["'none'"]);
		expect(csp.get('default-src'), what).toEqual(["'self'"]);
		expect(csp.get('style-src'), what).toEqual(["'self'", "'unsafe-inline'"]);
		expect(new Set(csp.get('img-src')), what).toEqual(
			new Set(["'self'", 'https://m.media-amazon.com'])
		);
		expect(csp.get('img-src'), what).toHaveLength(2);

		// script-src: only 'self' and Kit's nonce or hash, never a scheme, host,
		// 'unsafe-inline' or 'unsafe-eval'.
		const scripts = csp.get('script-src') ?? [];
		for (const source of scripts) {
			expect(
				source === "'self'" || NONCE.test(source) || HASH.test(source),
				`${what}: script-src ${source}`
			).toBe(true);
		}
		expect(
			scripts.some((source) => NONCE.test(source) || HASH.test(source)),
			`${what}: script-src has a nonce or hash (${scripts.join(' ')})`
		).toBe(true);
	});
}

test('the favicon is a file, not a data: URI img-src would block', async ({ request }) => {
	const res = await request.get('/');
	expect(res.status()).toBe(200);
	const html = await res.text();
	const icon = /<link\b[^>]*\brel="icon"[^>]*>/.exec(html)?.[0];
	expect(icon, 'rel=icon link').toBeTruthy();
	const href = /\bhref="([^"]*)"/.exec(icon!)?.[1];
	expect(href, 'rel=icon href').toBeTruthy();
	expect(href!.startsWith('data:'), `rel=icon href ${href}`).toBe(false);
	const file = await request.get(new URL(href!, res.url()).toString());
	expect(file.status(), href).toBe(200);
});
