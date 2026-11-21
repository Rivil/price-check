import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { Agent, request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNotifier, type DesktopNotifier } from '#lib/server/notify-bridge.ts';
import { removeTempDir } from '#lib/server/testing/temp-dir.ts';
import { loadAdapterHandler, startDesktopServer, type DesktopServer } from './server.ts';

type Seen = {
	url: string;
	headers: IncomingHttpHeaders;
	headersDistinct: NodeJS.Dict<string[]>;
	rawHeaders: string[];
};

const started: DesktopServer[] = [];

afterEach(async () => {
	await Promise.all(started.splice(0).map((s) => s.close()));
});

/** A server whose handler records every request it is handed and answers 200 'ok'. */
async function startRecording(): Promise<{ server: DesktopServer; seen: Seen[] }> {
	const seen: Seen[] = [];
	const server = await startDesktopServer({
		handler: (req, res) => {
			seen.push({
				url: req.url ?? '',
				headers: { ...req.headers },
				headersDistinct: { ...req.headersDistinct },
				rawHeaders: [...req.rawHeaders]
			});
			res.end('ok');
		}
	});
	started.push(server);
	return { server, seen };
}

type Sent = { path?: string; headers?: OutgoingHttpHeaders; setHost?: boolean; agent?: Agent };

function send(
	port: number,
	{ path = '/', headers = {}, setHost = true, agent }: Sent = {}
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path, headers, setHost, agent }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on('error', reject);
		req.end();
	});
}

/** Resolves with the connect error code, or 'connected' if the connection was accepted. */
function tryConnect(host: string, port: number): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		socket.setTimeout(5_000, () => {
			socket.destroy();
			resolve('timeout');
		});
		socket.once('connect', () => {
			socket.destroy();
			resolve('connected');
		});
		socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
	});
}

const lanAddress = Object.values(networkInterfaces())
	.flat()
	.find((info) => info !== undefined && info.family === 'IPv4' && !info.internal)?.address;

describe('startDesktopServer: binding', () => {
	it('listens on 127.0.0.1 IPv4 with an OS-assigned port', async () => {
		const { server } = await startRecording();

		expect(server.server.address()).toEqual({
			address: '127.0.0.1',
			family: 'IPv4',
			port: server.port
		});
		expect(server.port).toBeGreaterThan(0);
		expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
	});

	it('gives two starts two different ports', async () => {
		const a = await startRecording();
		const b = await startRecording();

		expect(a.server.port).not.toBe(b.server.port);
	});

	it.skipIf(lanAddress === undefined)(
		'refuses connections on a non-loopback interface',
		async () => {
			const { server } = await startRecording();

			expect(await tryConnect(lanAddress as string, server.port)).toBe('ECONNREFUSED');
		}
	);
});

describe('startDesktopServer: Host check', () => {
	it.each(['/_app/immutable/chunks/x.js', '/health', '/'])(
		"answers 403 to Host 'evil.example' on %s without calling the handler",
		async (path) => {
			const { server, seen } = await startRecording();

			const res = await send(server.port, { path, headers: { host: 'evil.example' } });

			expect(res).toEqual({ status: 403, body: 'Forbidden' });
			expect(seen).toEqual([]);
		}
	);

	it('answers 403 to a request with no Host header without calling the handler', async () => {
		const { server, seen } = await startRecording();

		const res = await send(server.port, { setHost: false });

		expect(res).toEqual({ status: 403, body: 'Forbidden' });
		expect(seen).toEqual([]);
	});

	it.each(['127.0.0.1', 'localhost'])('hands Host %s:<port> to the handler', async (name) => {
		const { server, seen } = await startRecording();

		const res = await send(server.port, {
			path: '/_app/immutable/chunks/x.js',
			headers: { host: `${name}:${server.port}` }
		});

		expect(res).toEqual({ status: 200, body: 'ok' });
		expect(seen.map((s) => s.url)).toEqual(['/_app/immutable/chunks/x.js']);
	});
});

describe('startDesktopServer: forwarded headers', () => {
	it.each([
		['https', 'https'],
		['https, http', 'https, http'],
		['two header lines', ['https', 'http']]
	])("rewrites a client X-Forwarded-Proto (%s) to exactly one 'http'", async (_label, value) => {
		const { server, seen } = await startRecording();

		await send(server.port, {
			headers: { 'x-forwarded-proto': value, 'x-forwarded-host': 'evil.example' }
		});

		expect(seen).toHaveLength(1);
		const [{ headers, rawHeaders }] = seen;
		expect(headers['x-forwarded-proto']).toBe('http');
		expect('x-forwarded-host' in headers).toBe(false);
		const rawNames = rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
		expect(rawNames.filter((n) => n === 'x-forwarded-proto')).toHaveLength(1);
		expect(rawNames).not.toContain('x-forwarded-host');
		expect(rawHeaders[rawNames.indexOf('x-forwarded-proto') * 2 + 1]).toBe('http');
	});

	it('rewrites rawHeaders: headersDistinct sees one http, other headers keep their values', async () => {
		const { server, seen } = await startRecording();

		await send(server.port, {
			headers: {
				'X-Forwarded-Proto': 'https',
				'X-Forwarded-Host': 'evil.example',
				'X-Test': '1'
			}
		});

		expect(seen).toHaveLength(1);
		const [{ headersDistinct, rawHeaders }] = seen;
		expect(headersDistinct['x-forwarded-proto']).toEqual(['http']);
		expect('x-forwarded-host' in headersDistinct).toBe(false);
		const rawPairs = new Map<string, string[]>();
		for (let i = 0; i < rawHeaders.length; i += 2) {
			const name = rawHeaders[i].toLowerCase();
			rawPairs.set(name, [...(rawPairs.get(name) ?? []), rawHeaders[i + 1]]);
		}
		expect(rawPairs.get('x-test')).toEqual(['1']);
		expect(rawPairs.get('host')).toEqual([`127.0.0.1:${server.port}`]);
	});

	// Node builds headersDistinct lazily from rawHeaders up to the parser's original
	// header count, so a rewrite that only swaps rawHeaders leaves it throwing or stale.
	it.each([
		[
			'client sent forwarded headers',
			{ 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.example', 'X-Test': ['1', '2'] }
		],
		['client sent none', { 'X-Test': ['1', '2'] }]
	])('rewritten request headers stay consistent: %s', async (_label, headers) => {
		const { server, seen } = await startRecording();

		await send(server.port, { headers });

		expect(seen).toHaveLength(1);
		const [req] = seen;
		const fromRaw: Record<string, string[]> = {};
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const name = req.rawHeaders[i].toLowerCase();
			(fromRaw[name] ??= []).push(req.rawHeaders[i + 1]);
		}
		expect(req.headersDistinct).toEqual(fromRaw);
		expect(req.headersDistinct['x-forwarded-proto']).toEqual(['http']);
		expect(req.headersDistinct['x-test']).toEqual(['1', '2']);
		expect(req.headers['x-forwarded-proto']).toBe('http');
		expect(req.headers['x-test']).toBe('1, 2');
		expect(Object.keys(req.headers).sort()).toEqual(Object.keys(fromRaw).sort());
	});

	it("sets X-Forwarded-Proto 'http' when the client sent none", async () => {
		const { server, seen } = await startRecording();

		await send(server.port);

		expect(seen[0].headers['x-forwarded-proto']).toBe('http');
	});
});

describe('startDesktopServer: handler failures', () => {
	it('answers 500 when the handler throws', async () => {
		const server = await startDesktopServer({
			handler: () => {
				throw new Error('boom');
			}
		});
		started.push(server);

		expect((await send(server.port)).status).toBe(500);
	});

	it('answers 500 when the handler returns a rejecting promise', async () => {
		const server = await startDesktopServer({
			handler: async () => {
				throw new Error('boom');
			}
		});
		started.push(server);

		expect(await send(server.port)).toEqual({ status: 500, body: 'Internal Server Error' });
	});

	it('leaves a handler that returns no promise to answer on its own, later', async () => {
		const server = await startDesktopServer({
			handler: (_req, res) => {
				setTimeout(() => res.end('late'), 20);
				return 'not a promise';
			}
		});
		started.push(server);

		expect(await send(server.port)).toEqual({ status: 200, body: 'late' });
	});

	it('destroys the response when the handler throws after sending headers', async () => {
		const server = await startDesktopServer({
			handler: (req, res) => {
				if (req.url === '/next') {
					res.end('ok');
					return;
				}
				res.writeHead(200, { 'content-type': 'text/plain' });
				res.write('partial');
				throw new Error('boom after headers');
			}
		});
		started.push(server);

		// The socket may close before or after the client parses the head: either a request
		// error (socket hang up) or a response that closes without completing is an abort.
		const first = await new Promise<string>((resolve) => {
			const req = request({ host: '127.0.0.1', port: server.port, agent: false }, (res) => {
				res.on('error', () => {});
				res.on('close', () => resolve(res.complete ? 'complete' : 'aborted'));
				res.resume();
			});
			req.on('error', () => resolve('aborted'));
			req.end();
		});

		expect(first).toBe('aborted');
		expect(await send(server.port, { path: '/next' })).toEqual({ status: 200, body: 'ok' });
	});

	it('answers 404 when the handler calls next()', async () => {
		const server = await startDesktopServer({ handler: (_req, _res, next) => next?.() });
		started.push(server);

		expect(await send(server.port)).toEqual({ status: 404, body: 'Not Found' });
	});
});

describe('startDesktopServer: close with keep-alive', () => {
	it('closes within 1s with an idle keep-alive connection, then refuses connections', async () => {
		const server = await startDesktopServer({ handler: (_req, res) => res.end('ok') });
		const agent = new Agent({ keepAlive: true });
		try {
			await send(server.port, { agent });
			// The socket is idle in the agent's pool, holding the connection open.
			expect(Object.values(agent.freeSockets).flat()).toHaveLength(1);

			const before = performance.now();
			await server.close();
			expect(performance.now() - before).toBeLessThan(1_000);

			expect(await tryConnect('127.0.0.1', server.port)).toBe('ECONNREFUSED');
		} finally {
			agent.destroy();
		}
	});

	it('closes within 1s while a response is still open (an event stream)', async () => {
		let opened!: () => void;
		const streaming = new Promise<void>((resolve) => (opened = resolve));
		const server = await startDesktopServer({
			handler: (_req, res) => {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write(': open\n\n');
				opened();
			}
		});
		// An aborted response never emits 'end', so wait for the client socket's 'close'.
		const clientClosed = new Promise<void>((resolve) => {
			const req = request({ host: '127.0.0.1', port: server.port }, (res) => res.resume());
			req.on('error', () => {});
			req.on('close', () => resolve());
			req.end();
		});
		await streaming;

		const before = performance.now();
		await server.close();
		expect(performance.now() - before).toBeLessThan(1_000);
		await clientClosed;
	});
});

type Recorded = { protocolHeader: string | null; cwd: string; notifierPublished: boolean };

const NOTIFIER_KEY = Symbol.for('price-check.notifier');
const notifier: DesktopNotifier = { show: async () => ({ ok: true }) };

describe('loadAdapterHandler: env, cwd and notifier before import', () => {
	const originalCwd = process.cwd();
	const originalEnv = { ...process.env };
	const moduleUrl = new URL('./testing/fake-handler.ts', import.meta.url).href;
	let appRoot: string;

	beforeEach(() => {
		appRoot = mkdtempSync(join(tmpdir(), 'desktop-server-'));
		// Each test imports fake-handler afresh, so its top-level reads see that test's state.
		vi.resetModules();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const name of Object.keys(process.env)) {
			if (!(name in originalEnv)) delete process.env[name];
		}
		Object.assign(process.env, originalEnv);
		delete (globalThis as { [NOTIFIER_KEY]?: DesktopNotifier })[NOTIFIER_KEY];
		removeTempDir(appRoot);
	});

	/** What fake-handler read at its import, fetched through a server running it. */
	async function recordedBy(handler: Awaited<ReturnType<typeof loadAdapterHandler>>) {
		const server = await startDesktopServer({ handler });
		started.push(server);
		return JSON.parse((await send(server.port)).body) as Recorded;
	}

	it('assigns env and chdirs to appRoot before importing the handler module', async () => {
		process.env.PROTOCOL_HEADER = 'x-evil-proto';
		process.env.HOST_HEADER = 'x-evil-host';

		const handler = await loadAdapterHandler(
			{ PROTOCOL_HEADER: 'x-forwarded-proto', PATH: process.env.PATH ?? '' },
			moduleUrl,
			appRoot,
			{ notifier }
		);

		expect('HOST_HEADER' in process.env).toBe(false);
		const recorded = await recordedBy(handler);
		expect(recorded.protocolHeader).toBe('x-forwarded-proto');
		// realpath both: macOS tmpdir is a /var -> /private/var symlink.
		expect(realpathSync(recorded.cwd)).toBe(realpathSync(appRoot));
	});

	it('publishes the notifier before importing the handler module (notifier before import)', async () => {
		expect(readNotifier()).toBeUndefined();

		const handler = await loadAdapterHandler({ PATH: process.env.PATH ?? '' }, moduleUrl, appRoot, {
			notifier
		});

		// The server's startup registers the desktop driver only if it sees a notifier.
		expect((await recordedBy(handler)).notifierPublished).toBe(true);
		expect(readNotifier()).toBe(notifier);
	});

	it('key gone after load', async () => {
		// A handler module that records, at import time, the key it saw.
		const keyModule = join(appRoot, 'key-handler.mjs');
		writeFileSync(
			keyModule,
			`globalThis.__keySeenAtImport = process.env.ALERTS_ENCRYPTION_KEY ?? null;
export function handler(_req, res) { res.end('ok'); }
`
		);
		const seen = globalThis as { __keySeenAtImport?: string | null };
		delete seen.__keySeenAtImport;

		const handler = await loadAdapterHandler(
			{ ALERTS_ENCRYPTION_KEY: 'a2V5LWZvci10ZXN0', PATH: process.env.PATH ?? '' },
			pathToFileURL(keyModule).href,
			appRoot,
			{ notifier }
		);

		expect(typeof handler).toBe('function');
		expect(seen.__keySeenAtImport).toBe('a2V5LWZvci10ZXN0');
		expect('ALERTS_ENCRYPTION_KEY' in process.env).toBe(false);
		// Only the key goes: the rest of the server's env stays for adapter-node.
		expect(process.env.PATH).toBe(originalEnv.PATH ?? '');
		delete seen.__keySeenAtImport;
	});

	it('key gone after a handler module that throws on import', async () => {
		const throwing = join(appRoot, 'throwing-handler.mjs');
		writeFileSync(throwing, `throw new Error('init failed');\n`);

		await expect(
			loadAdapterHandler(
				{ ALERTS_ENCRYPTION_KEY: 'a2V5LWZvci10ZXN0', PATH: process.env.PATH ?? '' },
				pathToFileURL(throwing).href,
				appRoot,
				{ notifier }
			)
		).rejects.toThrow('init failed');
		expect('ALERTS_ENCRYPTION_KEY' in process.env).toBe(false);
	});

	it('key gone after a module without a handler export', async () => {
		const noHandlerUrl = new URL('./app-paths.ts', import.meta.url).href;
		await expect(
			loadAdapterHandler(
				{ ALERTS_ENCRYPTION_KEY: 'a2V5LWZvci10ZXN0', PATH: process.env.PATH ?? '' },
				noHandlerUrl,
				appRoot,
				{ notifier }
			)
		).rejects.toThrow('does not export a handler function');
		expect('ALERTS_ENCRYPTION_KEY' in process.env).toBe(false);
	});

	it('rejects a module without a handler export', async () => {
		const noHandlerUrl = new URL('./app-paths.ts', import.meta.url).href;

		await expect(
			loadAdapterHandler({ ...originalEnv } as Record<string, string>, noHandlerUrl, appRoot, {
				notifier
			})
		).rejects.toThrow('does not export a handler function');
	});
});
