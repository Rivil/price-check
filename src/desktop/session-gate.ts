// The per-launch session gate (decision session_secret, SEC-02): main makes a random
// secret each launch and sets it as an HttpOnly, SameSite=Strict cookie on the
// window's session before loadURL; the desktop server answers 403 to any request
// without it. Another local process can reach 127.0.0.1:<port>, but it cannot read
// the window's cookie, so it cannot drive the app. Exact GET /health is the only
// exemption, for the readiness probe.
//
// Pure, with no electron import, so it runs under vitest. The secret is a required
// parameter of every check: without one, nothing but GET /health is authorised.
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** The cookie that carries the launch's secret. */
export const SESSION_COOKIE = 'pc_session';

/** Bytes of randomness in a secret. */
const SECRET_BYTES = 32;

/** A fresh secret for this launch: 32 random bytes, base64url (cookie-safe). */
export function createSessionSecret(): string {
	return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * The fields session.cookies.set takes for the gate's cookie. No expirationDate, so
 * it is a session cookie that never reaches disk; http on loopback, so not secure.
 */
export type SessionCookieDetails = {
	url: string;
	name: string;
	value: string;
	path: '/';
	httpOnly: true;
	secure: false;
	sameSite: 'strict';
};

/** The gate's cookie for the window's origin (http://127.0.0.1:<port>). */
export function cookieDetails(origin: string, secret: string): SessionCookieDetails {
	return {
		url: origin,
		name: SESSION_COOKIE,
		value: secret,
		path: '/',
		httpOnly: true,
		secure: false,
		sameSite: 'strict'
	};
}

export type GateRequest = {
	method: string | undefined;
	/** The raw request-target (node's req.url): origin-form path and query. */
	url: string | undefined;
	cookieHeader: string | string[] | undefined | null;
};

/** Exactly GET /health, with or without a query: nothing else is exempt. */
function isHealthProbe(method: string | undefined, url: string | undefined): boolean {
	if (method !== 'GET' || url === undefined) return false;
	const query = url.indexOf('?');
	return (query === -1 ? url : url.slice(0, query)) === '/health';
}

/** Every value the Cookie header gives SESSION_COOKIE, in order. */
function sessionCookieValues(header: string | string[] | undefined | null): string[] {
	if (header === undefined || header === null) return [];
	const values: string[] = [];
	for (const line of Array.isArray(header) ? header : [header]) {
		for (const pair of line.split(';')) {
			const eq = pair.indexOf('=');
			if (eq === -1) continue;
			if (pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
			values.push(pair.slice(eq + 1).trim());
		}
	}
	return values;
}

/** Constant-time match of one candidate against the secret. */
function matches(candidate: string, expected: Buffer): boolean {
	const given = Buffer.from(candidate, 'utf8');
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Whether the request may reach the app: exact GET /health always, anything else
 * only with this launch's secret in the SESSION_COOKIE cookie. Never throws.
 */
export function isAuthorized(request: GateRequest, secret: string): boolean {
	if (isHealthProbe(request.method, request.url)) return true;
	const expected = Buffer.from(secret, 'utf8');
	if (expected.length === 0) return false;
	return sessionCookieValues(request.cookieHeader).some((value) => matches(value, expected));
}
