import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { asc } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client.ts';
import { notifyChannel, watch } from '../src/lib/server/db/schema.ts';
import {
	E2E_ALERTS_KEY,
	E2E_DATABASE_URL,
	E2E_ORIGIN,
	SEEDED_DESIGN_TOPIC_URL,
	SEEDED_WATCHES
} from './accounts.ts';
import { ACTION_ENDPOINTS, actionUrl } from './action-endpoints.ts';
import { freePort, startNodeServer } from './node-server.ts';

// The whole access control of a local install (decision local_request_guard).
// CSRF rows (c-6) run on the preview webServer: a build, so Kit's origin check is
// compiled in (dev compiles it out). Host rows (c-7) run on `node build` with raw
// node:http requests: fetch cannot set Host, and preview.allowedHosts would 403 a
// foreign Host with no hook involved. Static /_app/immutable/* assets are served
// before hooks and are out of scope (deferred to 03-desktop-shell).
//
// Nothing here can reach a live shop (r-01): the watch is in its Check-now cooldown,
// every URL is unsupported or .invalid, and the seeded ntfy topic is .invalid.

/** Its seeded lastCheckedAt is in the future, so a forged Check now is refused. */
const WATCH = SEEDED_WATCHES.layoutCooldown;

/** One body for every action, each field one that would change seeded state if accepted. */
const FIELDS = {
	kind: 'ntfy',
	topic: 'https://ntfy.csrf.invalid/forged-topic',
	url: 'https://shop.invalid/item/1',
	target: '12.34'
};
const TEXT_BODY = Object.entries(FIELDS)
	.map(([name, value]) => `${name}=${value}`)
	.join('\r\n');

/** The page a form-action's 403 comes from: Kit's CSRF check, not the Host guard. */
const KIT_CSRF = 'Cross-site POST form submissions are forbidden';

/** Every watch and alert channel, as stored. */
async function snapshot() {
	const db = createDb(E2E_DATABASE_URL);
	try {
		return {
			watches: await db.select().from(watch).orderBy(asc(watch.id)),
			channels: await db.select().from(notifyChannel).orderBy(asc(notifyChannel.kind))
		};
	} finally {
		db.$client.close();
	}
}

/** The forged posts: a foreign Origin in each form encoding, Origin 'null', no Origin. */
function forgeries(request: APIRequestContext, url: string): [string, Promise<APIResponse>][] {
	const evil = { origin: 'https://evil.example' };
	return [
		['evil urlencoded', request.post(url, { headers: evil, form: FIELDS, maxRedirects: 0 })],
		['evil multipart', request.post(url, { headers: evil, multipart: FIELDS, maxRedirects: 0 })],
		[
			'evil text/plain',
			request.post(url, {
				headers: { ...evil, 'content-type': 'text/plain' },
				data: TEXT_BODY,
				maxRedirects: 0
			})
		],
		[
			"Origin 'null'",
			request.post(url, { headers: { origin: 'null' }, form: FIELDS, maxRedirects: 0 })
		],
		['no Origin', request.post(url, { form: FIELDS, maxRedirects: 0 })]
	];
}

test.describe('CSRF origin check', () => {
	for (const endpoint of ACTION_ENDPOINTS) {
		const url = actionUrl(endpoint, { id: WATCH.id });

		test(`${url} refuses cross-site posts`, async ({ request }) => {
			const before = await snapshot();
			expect(before.watches.map(({ id }) => id)).toContain(WATCH.id);
			expect(before.channels.map(({ kind }) => kind)).toContain('ntfy');

			for (const [what, sent] of forgeries(request, url)) {
				const res = await sent;
				expect(res.status(), what).toBe(403);
				expect(await res.text(), what).toContain(KIT_CSRF);
			}

			// Follow-up GETs: the watch and the channel are as seeded.
			const page = await request.get(`/watches/${WATCH.id}`, { maxRedirects: 0 });
			expect(page.status()).toBe(200);
			const html = await page.text();
			expect(html).toContain(WATCH.title);
			expect(html).toContain('No target');
			const alerts = await request.get('/account/alerts', { maxRedirects: 0 });
			expect(alerts.status()).toBe(200);
			const alertsHtml = await alerts.text();
			expect(alertsHtml).toContain(SEEDED_DESIGN_TOPIC_URL);
			expect(alertsHtml).not.toContain(FIELDS.topic);
			expect(alertsHtml).toContain('Status: <strong>Enabled</strong>');
			expect(await snapshot()).toStrictEqual(before);
		});
	}

	// Control: same origin reaches the action, which refuses the URL itself (no fetch).
	test('a same-origin post reaches the action', async ({ request }) => {
		const res = await request.post('/?/add', {
			headers: { origin: E2E_ORIGIN },
			form: { url: FIELDS.url, target: '' },
			maxRedirects: 0
		});
		expect(res.status()).toBe(400);
		expect(await res.text()).not.toContain(KIT_CSRF);
	});
});

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string };

/**
 * One request to 127.0.0.1:<port> with exactly the given headers: Host included only
 * when `headers` names it (node:http's setHost is off).
 */
function rawRequest(
	port: number,
	{
		method = 'GET',
		path,
		headers = {},
		body
	}: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<RawResponse> {
	return new Promise((done, fail) => {
		const sent = { ...headers };
		if (body !== undefined) sent['content-length'] = String(Buffer.byteLength(body));
		const req = httpRequest(
			{ host: '127.0.0.1', port, method, path, headers: sent, setHost: false, agent: false },
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => (text += chunk));
				res.on('end', () =>
					done({ status: res.statusCode ?? 0, headers: res.headers, body: text })
				);
				res.on('error', fail);
			}
		);
		req.setTimeout(10_000, () => req.destroy(new Error(`rawRequest: ${path} timed out`)));
		req.on('error', fail);
		req.end(body);
	});
}

type Guarded = { port: number; stop(): Promise<void> };

/** Starts `node build` on a fresh database in its own temp dir, `env` given its port. */
async function startGuarded(env: (port: number) => Record<string, string>): Promise<Guarded> {
	const dir = mkdtempSync(join(tmpdir(), 'local-guard-'));
	const port = await freePort();
	try {
		const server = await startNodeServer({
			port,
			dbFile: join(dir, 'guard.db'),
			env: { ALERTS_ENCRYPTION_KEY: E2E_ALERTS_KEY, ...env(port) }
		});
		return {
			port,
			stop: async () => {
				await server.stop();
				rmSync(dir, { recursive: true, force: true });
			}
		};
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

const GUARDED_PATHS = ['/', '/health', '/account/alerts', `/watches/${WATCH.id}/__data.json`];

test.describe('Host guard, node build with ORIGIN', () => {
	let server: Guarded | undefined;

	test.beforeAll(async () => {
		test.setTimeout(60_000);
		server = await startGuarded((port) => ({ ORIGIN: `http://127.0.0.1:${port}` }));
	});
	test.afterAll(async () => {
		await server?.stop();
	});

	test('a foreign Host is refused on every path', async () => {
		for (const path of GUARDED_PATHS) {
			const res = await rawRequest(server!.port, { path, headers: { host: 'evil.example' } });
			expect(res.status, path).toBe(403);
			expect(res.body, path).toBe('Forbidden');
		}
	});

	test('a loopback Host on any port is served', async () => {
		for (const host of [`127.0.0.1:${server!.port}`, 'localhost:9']) {
			for (const path of GUARDED_PATHS) {
				const res = await rawRequest(server!.port, { path, headers: { host } });
				expect(res.status, `${host} ${path}`).not.toBe(403);
			}
			const health = await rawRequest(server!.port, { path: '/health', headers: { host } });
			expect(health.status, `${host} /health`).toBe(200);
		}
	});

	// Node 24 answers a Host-less HTTP/1.1 request with 400 before any hook runs;
	// the guard would 403 it. Either way it must not be served.
	test('no Host header is never served', async () => {
		const res = await rawRequest(server!.port, { path: '/health' });
		expect(res.status >= 200 && res.status < 300, `status ${res.status}`).toBe(false);
	});
});

test.describe('Host guard, node build without ORIGIN', () => {
	let server: Guarded | undefined;

	test.beforeAll(async () => {
		test.setTimeout(60_000);
		server = await startGuarded(() => ({}));
	});
	test.afterAll(async () => {
		await server?.stop();
	});

	/** A cross-site-looking add whose Origin matches what adapter-node derives from Host. */
	const forgedAdd = (host: string) =>
		rawRequest(server!.port, {
			method: 'POST',
			path: '/?/add',
			headers: {
				host,
				origin: `https://${host}`,
				'content-type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({ url: FIELDS.url, target: '' }).toString()
		});

	// Control: with ORIGIN unset adapter-node derives https://<Host>, so a matching
	// Origin passes Kit's CSRF check and the action refuses the URL itself.
	test('a matching derived Origin passes the CSRF check', async () => {
		const res = await forgedAdd(`127.0.0.1:${server!.port}`);
		expect(res.status).toBe(400);
		expect(res.body).not.toContain(KIT_CSRF);
	});

	test('only the Host guard refuses a rebinding post', async () => {
		const res = await forgedAdd('evil.example');
		expect(res.status).toBe(403);
		expect(res.body).toBe('Forbidden');
	});
});
