// DNS-rebinding and cross-site guard: the server only answers requests addressed
// to a loopback name, and only takes state-changing requests from its own pages.
// Pure checks + a handle factory, with no $app/* imports so it can be unit-tested
// without a running SvelteKit server and behaves the same under `vite dev`.
import type { Handle } from '@sveltejs/kit/hooks';

// Exact names only, so look-alikes (localhost.evil.example, 127.0.0.1.nip.io,
// localhost.) never match. The port is optional; when present it must be digits.
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/i;

/** True when a Host header value names localhost or 127.0.0.1, with an optional port 1-65535. */
export function isLoopbackHost(host: string | null): host is string {
	if (host === null) return false;
	const match = LOOPBACK_HOST.exec(host);
	if (!match) return false;
	const port = match[1];
	if (port === undefined) return true;
	const n = Number(port);
	return n >= 1 && n <= 65535;
}

/** Methods that can change state: each must carry the page's own Origin. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * True when an unsafe request's Origin is exactly http://<Host>: the page the
 * server itself served. Missing, 'null', https, another port or another name
 * all fail. The app is only ever served over plain http on loopback.
 */
export function isSameOrigin(origin: string | null, host: string): boolean {
	return origin !== null && origin === `http://${host}`;
}

function forbidden(): Response {
	return new Response('Forbidden', {
		status: 403,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'x-frame-options': 'DENY' }
	});
}

/**
 * The server's whole request guard, in every mode — `vite dev` included, where
 * Kit compiles its own CSRF check out — with no dev or building branch:
 *
 * - Every request whose Host header is not a loopback name gets a plain 403
 *   before any route runs, /health included. It reads the Host header itself,
 *   never event.url: adapter-node builds that from ORIGIN when it is set, so it
 *   would say localhost whatever the browser actually addressed. X-Forwarded-Host
 *   is ignored: there is no proxy in front of a local install.
 * - A POST, PUT, PATCH or DELETE whose Origin is not exactly http://<Host> gets
 *   the same 403, whatever its body's content type (form, multipart, text/plain
 *   or JSON), so a cross-site page can never drive an action.
 * - Every response carries X-Frame-Options: DENY, so no other origin can frame
 *   the app.
 */
export function createLocalRequestHandle(): Handle {
	return async ({ event, resolve }) => {
		const host = event.request.headers.get('host');
		if (!isLoopbackHost(host)) return forbidden();
		if (
			UNSAFE_METHODS.has(event.request.method) &&
			!isSameOrigin(event.request.headers.get('origin'), host)
		) {
			return forbidden();
		}
		const response = await resolve(event);
		response.headers.set('x-frame-options', 'DENY');
		return response;
	};
}
