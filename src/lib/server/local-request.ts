// DNS-rebinding guard: the server only answers requests addressed to a loopback
// name. Pure check + a handle factory, with no $app/* imports so it can be
// unit-tested without a running SvelteKit server.
import type { Handle } from '@sveltejs/kit/hooks';

// Exact names only, so look-alikes (localhost.evil.example, 127.0.0.1.nip.io,
// localhost.) never match. The port is optional; when present it must be digits.
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/i;

/** True when a Host header value names localhost or 127.0.0.1, with an optional port 1-65535. */
export function isLoopbackHost(host: string | null): boolean {
	if (host === null) return false;
	const match = LOOPBACK_HOST.exec(host);
	if (!match) return false;
	const port = match[1];
	if (port === undefined) return true;
	const n = Number(port);
	return n >= 1 && n <= 65535;
}

/**
 * Rejects every request whose Host header is not a loopback name with a plain
 * 403, before any route runs — /health included. Reads the Host header itself,
 * never event.url: adapter-node builds that from ORIGIN when it is set, so it
 * would say localhost whatever the browser actually addressed. X-Forwarded-Host
 * is ignored: there is no proxy in front of a local install.
 */
export function createLocalRequestHandle(): Handle {
	return ({ event, resolve }) => {
		if (!isLoopbackHost(event.request.headers.get('host'))) {
			return new Response('Forbidden', {
				status: 403,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}
		return resolve(event);
	};
}
