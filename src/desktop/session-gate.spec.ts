import { describe, expect, it } from 'vitest';
import gateSource from './session-gate.ts?raw';
import {
	SESSION_COOKIE,
	cookieDetails,
	createSessionSecret,
	isAuthorized,
	type GateRequest
} from './session-gate.ts';

const SECRET = createSessionSecret();
const COOKIE = `${SESSION_COOKIE}=${SECRET}`;

const req = (method: string, url: string, cookieHeader?: GateRequest['cookieHeader']) => ({
	method,
	url,
	cookieHeader
});

describe('isAuthorized', () => {
	it('only GET /health is exempt', () => {
		const gated: [string, string][] = [
			['GET', '/account/alerts/__data.json'],
			['POST', '/account/alerts?/save'],
			['GET', '/_app/immutable/x.js'],
			['HEAD', '/health'],
			['POST', '/health'],
			['GET', '/health/'],
			['GET', '/Health'],
			['GET', '/health/../account/alerts/__data.json'],
			['GET', '/health/..%2faccount'],
			['GET', '//health'],
			['GET', 'http://127.0.0.1:1/account'],
			['GET', 'http://127.0.0.1:1/health'],
			['GET', '/'],
			['GET', '']
		];
		for (const [method, url] of gated) {
			expect(isAuthorized(req(method, url), SECRET), `${method} ${url}`).toBe(false);
			// The same request with the cookie is let through: only the cookie was missing.
			expect(isAuthorized(req(method, url, COOKIE), SECRET), `${method} ${url} + cookie`).toBe(
				true
			);
		}
		expect(
			isAuthorized({ method: undefined, url: undefined, cookieHeader: undefined }, SECRET)
		).toBe(false);
	});

	it('GET /health is exempt, with any query', () => {
		for (const url of ['/health', '/health?x=1', '/health?']) {
			expect(isAuthorized(req('GET', url), SECRET), url).toBe(true);
		}
	});

	it('only the exact cookie authorises', () => {
		const flipped = SECRET.slice(0, -1) + (SECRET.endsWith('A') ? 'B' : 'A');
		const refused: [string, GateRequest['cookieHeader']][] = [
			['missing', undefined],
			['null', null],
			['empty header', ''],
			['empty value', `${SESSION_COOKIE}=`],
			['wrong value', `${SESSION_COOKIE}=${createSessionSecret()}`],
			['one byte changed', `${SESSION_COOKIE}=${flipped}`],
			['prefix', `${SESSION_COOKIE}=${SECRET.slice(0, -1)}`],
			['longer', `${SESSION_COOKIE}=${SECRET}x`],
			['other name', `pc=${SECRET}`],
			['name as prefix', `x${SESSION_COOKIE}=${SECRET}`],
			['malformed', 'pc=;;='],
			['bare secret', SECRET],
			['300 KB junk', `${'a=b; ;=;'.repeat(40_000)}`],
			['empty array', []]
		];
		for (const [what, cookieHeader] of refused) {
			expect(() => isAuthorized(req('GET', '/', cookieHeader), SECRET), what).not.toThrow();
			expect(isAuthorized(req('GET', '/', cookieHeader), SECRET), what).toBe(false);
		}

		const accepted: [string, GateRequest['cookieHeader']][] = [
			['alone', COOKIE],
			['among others', `theme=dark; ${COOKIE}; other=1`],
			['spaced', `a=1;  ${SESSION_COOKIE} = ${SECRET} ;b=2`],
			['after a wrong copy', `${SESSION_COOKIE}=nope; ${COOKIE}`],
			['split headers', ['a=1', COOKIE]]
		];
		for (const [what, cookieHeader] of accepted) {
			expect(isAuthorized(req('GET', '/', cookieHeader), SECRET), what).toBe(true);
		}
	});

	it('fails closed without a secret', () => {
		expect(isAuthorized(req('GET', '/', `${SESSION_COOKIE}=`), '')).toBe(false);
		expect(isAuthorized(req('GET', '/'), '')).toBe(false);
		expect(isAuthorized(req('GET', '/health'), '')).toBe(true);
	});

	it('compares with timingSafeEqual, never === on the secret', () => {
		const code = gateSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
		expect(code).toMatch(/\btimingSafeEqual\(/);
		expect(code).toMatch(
			/given\.length === expected\.length && timingSafeEqual\(given, expected\)/
		);
		expect(code).not.toMatch(/===\s*(?:secret|expected)\b(?!\.length)/);
		expect(code).not.toMatch(/\b(?:secret|expected)\s*===/);
		expect(code).not.toMatch(/\.includes\(/);
		expect(code).not.toMatch(/from ['"]electron['"]/);
	});
});

describe('cookieDetails', () => {
	it('is an HttpOnly, SameSite=Strict session cookie for the origin', () => {
		const details = cookieDetails('http://127.0.0.1:43123', SECRET);
		expect(details).toEqual({
			url: 'http://127.0.0.1:43123',
			name: SESSION_COOKIE,
			value: SECRET,
			path: '/',
			httpOnly: true,
			secure: false,
			sameSite: 'strict'
		});
		expect(details).not.toHaveProperty('expirationDate');
	});
});

describe('createSessionSecret', () => {
	it('is fresh and at least 32 bytes', () => {
		const a = createSessionSecret();
		const b = createSessionSecret();
		expect(a).not.toBe(b);
		for (const secret of [a, b]) {
			expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(Buffer.from(secret, 'base64url').length).toBeGreaterThanOrEqual(32);
		}
	});
});
