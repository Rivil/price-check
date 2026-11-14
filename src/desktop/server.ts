// The desktop app's HTTP server (decision desktop_server_wrapper, spec c-3/c-4/c-9).
// Electron main owns a node:http server bound to 127.0.0.1 on an OS-assigned port
// (decision server_port). Every request, static assets included, is Host-checked
// before adapter-node sees it: adapter-node's sirv serves /_app/immutable/* before
// the Kit hooks run, so the hook-level guard alone never covers those files.
//
// adapter-node 6 bakes ORIGIN at build time (build/adapter-node.js) and otherwise
// builds the origin as `${req.headers[PROTOCOL_HEADER] || 'https'}://${Host}` in
// get_origin (handler.js), reading PROTOCOL_HEADER once at module load. With
// PROTOCOL_HEADER=x-forwarded-proto (server-env.ts) and the wrapper forcing that
// header to exactly 'http', the origin is http://<Host> on the live port, so Kit's
// CSRF check accepts the window's own form POSTs. A client-sent value is never
// trusted: there is no proxy in front of a local install.
//
// Runs in the Electron main bundle: no $app/* imports, no electron import.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isLoopbackHost } from '#lib/server/local-request.ts';

export const LOOPBACK_ADDRESS = '127.0.0.1';
export const PROTOCOL_HEADER = 'x-forwarded-proto';
const FORWARDED_HOST = 'x-forwarded-host';

/** adapter-node's `handler` export: a polka-style middleware. */
export type NodeHandler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => unknown;

export type DesktopServer = {
	server: Server;
	port: number;
	/** http://127.0.0.1:<port>, the URL the app window loads. */
	origin: string;
	/** Stops listening and ends every open connection, idle keep-alive ones included. */
	close(): Promise<void>;
};

function sendText(res: ServerResponse, status: number, body: string): void {
	res.statusCode = status;
	res.setHeader('content-type', 'text/plain; charset=utf-8');
	res.end(body);
}

/**
 * Drops client-sent X-Forwarded-Proto and X-Forwarded-Host and sets X-Forwarded-Proto
 * to exactly one 'http'. Both req.headers (what adapter-node and Kit read) and
 * req.rawHeaders (what req.headersDistinct is built from) are rewritten.
 */
function forcePlainHttp(req: IncomingMessage): void {
	delete req.headers[FORWARDED_HOST];
	req.headers[PROTOCOL_HEADER] = 'http';
	const raw: string[] = [];
	for (let i = 0; i < req.rawHeaders.length; i += 2) {
		const name = req.rawHeaders[i].toLowerCase();
		if (name === PROTOCOL_HEADER || name === FORWARDED_HOST) continue;
		raw.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
	}
	raw.push('X-Forwarded-Proto', 'http');
	req.rawHeaders = raw;
}

function failRequest(res: ServerResponse, error: unknown): void {
	console.error('desktop server: request handler failed', error);
	if (res.headersSent) res.destroy();
	else sendText(res, 500, 'Internal Server Error');
}

/** Listens on 127.0.0.1, port 0, and hands loopback-addressed requests to `handler`. */
export function startDesktopServer({ handler }: { handler: NodeHandler }): Promise<DesktopServer> {
	// Node answers an HTTP/1.1 request with no Host with its own 400; turning that off
	// sends it through the Host check like any other non-loopback request.
	const server = createServer({ requireHostHeader: false }, (req, res) => {
		if (!isLoopbackHost(req.headers.host ?? null)) {
			sendText(res, 403, 'Forbidden');
			return;
		}
		forcePlainHttp(req);
		const next = () => {
			if (!res.writableEnded) sendText(res, 404, 'Not Found');
		};
		try {
			const result = handler(req, res, next);
			if (result instanceof Promise) result.catch((error: unknown) => failRequest(res, error));
		} catch (error) {
			failRequest(res, error);
		}
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, LOOPBACK_ADDRESS, () => {
			server.off('error', reject);
			const { port } = server.address() as AddressInfo;
			resolve({
				server,
				port,
				origin: `http://${LOOPBACK_ADDRESS}:${port}`,
				close: () =>
					new Promise<void>((done, fail) => {
						server.close((error) => (error ? fail(error) : done()));
						server.closeAllConnections();
					})
			});
		});
	});
}

/**
 * Imports adapter-node's handler module (build/handler.js) under the server's own
 * environment. adapter-node reads PROTOCOL_HEADER and friends at module load, and
 * migrate.ts resolves drizzle/ against the cwd, so process.env is replaced with `env`
 * and the cwd moved to `appRoot` BEFORE the import. Replaced, not merged: a variable
 * serverEnv dropped (HOST_HEADER, PORT_HEADER...) must not survive in process.env.
 */
export async function loadAdapterHandler(
	env: Record<string, string>,
	moduleUrl: string,
	appRoot: string
): Promise<NodeHandler> {
	for (const name of Object.keys(process.env)) {
		if (!(name in env)) delete process.env[name];
	}
	Object.assign(process.env, env);
	process.chdir(appRoot);
	const mod = (await import(/* @vite-ignore */ moduleUrl)) as { handler?: unknown };
	if (typeof mod.handler !== 'function') {
		throw new Error(`${moduleUrl} does not export a handler function`);
	}
	return mod.handler as NodeHandler;
}
