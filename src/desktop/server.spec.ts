import { mkdtempSync, realpathSync } from 'node:fs';
import { Agent, request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTempDir } from '#lib/server/testing/temp-dir.ts';
import { loadAdapterHandler, startDesktopServer, type DesktopServer } from './server.ts';

type Seen = { url: string; headers: IncomingHttpHeaders; rawHeaders: string[] };

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

describe('loadAdapterHandler: env and cwd before import', () => {
	const originalCwd = process.cwd();
	const originalEnv = { ...process.env };
	let appRoot: string;

	beforeEach(() => {
		appRoot = mkdtempSync(join(tmpdir(), 'desktop-server-'));
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const name of Object.keys(process.env)) {
			if (!(name in originalEnv)) delete process.env[name];
		}
		Object.assign(process.env, originalEnv);
		removeTempDir(appRoot);
	});

	it('assigns env and chdirs to appRoot before importing the handler module', async () => {
		process.env.PROTOCOL_HEADER = 'x-evil-proto';
		process.env.HOST_HEADER = 'x-evil-host';
		const moduleUrl = new URL('./testing/fake-handler.ts', import.meta.url).href;

		const handler = await loadAdapterHandler(
			{ PROTOCOL_HEADER: 'x-forwarded-proto', PATH: process.env.PATH ?? '' },
			moduleUrl,
			appRoot
		);

		expect('HOST_HEADER' in process.env).toBe(false);
		const server = await startDesktopServer({ handler });
		started.push(server);
		const recorded = JSON.parse((await send(server.port)).body) as {
			protocolHeader: string | null;
			cwd: string;
		};
		expect(recorded.protocolHeader).toBe('x-forwarded-proto');
		// realpath both: macOS tmpdir is a /var -> /private/var symlink.
		expect(realpathSync(recorded.cwd)).toBe(realpathSync(appRoot));
	});

	it('rejects a module without a handler export', async () => {
		const moduleUrl = new URL('./app-paths.ts', import.meta.url).href;

		await expect(
			loadAdapterHandler({ ...originalEnv } as Record<string, string>, moduleUrl, appRoot)
		).rejects.toThrow('does not export a handler function');
	});
});
