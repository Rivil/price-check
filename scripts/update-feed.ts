// A loopback-only update feed for the packaged update test (spec c-5, decision
// update_flow): build A is packaged with --feed-url http://127.0.0.1:UPDATE_FEED_PORT/
// and, once launched, electron-updater's generic provider fetches latest*.yml, the
// installer or AppImage and its blockmap from here, where the test serves build B.
//
// The server binds 127.0.0.1 only and never makes an outbound request. It serves
// regular files sitting directly in `dir` (no subdirectories, no dotfiles, no
// symlinks, no path that decodes to a separator or `..`), so it can hand out the
// test's artefacts and nothing else. GET and HEAD only; a single `Range: bytes=`
// range gives 206. Every request's path is recorded so a test can assert the app
// checked at launch.
//
// Node built-ins only.
import { createReadStream } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

/** The fixed feed port: baked into build A's app-update.yml at package time. */
export const UPDATE_FEED_PORT = 47811;

const LOOPBACK = '127.0.0.1';

/** A servable file name: no separators, no leading dot, nothing a shell or URL bends. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** One `bytes=` range: start-end, start- or -suffix. */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

export type UpdateFeedOptions = {
	/** The directory whose top-level regular files are served. */
	dir: string;
	/** Defaults to UPDATE_FEED_PORT; 0 takes an ephemeral port (tests only). */
	port?: number;
};

export type UpdateFeed = {
	/** http://<address>:<port>/ */
	url: string;
	/** The address the server is bound to, as the OS reports it: 127.0.0.1. */
	address: string;
	port: number;
	/** Every request's path (query dropped), in arrival order, 404s included. */
	requests: () => string[];
	close: () => Promise<void>;
};

/** The served file name for a raw request path, or null when it must 404. */
export function fileNameFor(rawPath: string): string | null {
	if (!rawPath.startsWith('/')) return null;
	let name: string;
	try {
		name = decodeURIComponent(rawPath.slice(1));
	} catch {
		return null;
	}
	if (!FILE_NAME.test(name) || name.includes('..')) return null;
	return name;
}

type ByteRange = { start: number; end: number };

/**
 * The range a `Range` header asks of a `size`-byte file: null to send the whole
 * file (no header, or one this feed ignores, e.g. several ranges), 'unsatisfiable'
 * for a 416.
 */
export function parseRange(
	header: string | undefined,
	size: number
): ByteRange | null | 'unsatisfiable' {
	if (header === undefined) return null;
	const match = SINGLE_RANGE.exec(header.trim());
	if (match === null) return null;
	const [, first, last] = match;
	if (first === '' && last === '') return null;
	if (first === '') {
		const suffix = Number(last);
		if (suffix === 0 || size === 0) return 'unsatisfiable';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
	if (start >= size || start > end) return 'unsatisfiable';
	return { start, end };
}

function contentType(name: string): string {
	return name.endsWith('.yml') || name.endsWith('.yaml')
		? 'text/yaml; charset=utf-8'
		: 'application/octet-stream';
}

function notFound(res: ServerResponse): void {
	res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': '9' });
	res.end('not found');
}

async function serve(dir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' });
		res.end();
		return;
	}
	const name = fileNameFor(pathOf(req.url));
	if (name === null) return notFound(res);
	const file = join(dir, name);
	// lstat: a symlink in dir is never followed out of it. Only a missing file is a
	// 404; any other failure (EACCES, EIO) goes to the 500 path and is logged.
	const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
		throw error;
	});
	if (info === null || !info.isFile()) return notFound(res);

	const headers = {
		'Content-Type': contentType(name),
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'no-store'
	};
	const range = parseRange(req.headers.range, info.size);
	if (range === 'unsatisfiable') {
		res.writeHead(416, {
			...headers,
			'Content-Range': `bytes */${info.size}`,
			'Content-Length': '0'
		});
		res.end();
		return;
	}
	const { start, end } = range ?? { start: 0, end: info.size - 1 };
	const length = info.size === 0 ? 0 : end - start + 1;
	res.writeHead(range === null ? 200 : 206, {
		...headers,
		'Content-Length': String(length),
		...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${info.size}` })
	});
	if (req.method === 'HEAD' || length === 0) {
		res.end();
		return;
	}
	const stream = createReadStream(file, { start, end });
	stream.on('error', (error) => {
		console.error(`update feed: reading ${name} failed: ${error.message}`);
		res.destroy();
	});
	stream.pipe(res);
}

/** The path part of a request target, query and fragment dropped. */
function pathOf(target: string | undefined): string {
	const raw = target ?? '';
	const cut = raw.search(/[?#]/);
	return cut === -1 ? raw : raw.slice(0, cut);
}

/**
 * Starts the feed on 127.0.0.1:`port`. Rejects when the port is taken (never falls
 * back to another port: build A's baked-in URL names this one) or `dir` is not a
 * directory.
 */
export async function startUpdateFeed({
	dir,
	port = UPDATE_FEED_PORT
}: UpdateFeedOptions): Promise<UpdateFeed> {
	const root = resolve(dir);
	if (!(await stat(root)).isDirectory()) throw new Error(`update feed: ${root} is not a directory`);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`update feed: invalid port ${port}`);
	}

	const seen: string[] = [];
	const server = createServer((req, res) => {
		seen.push(pathOf(req.url));
		serve(root, req, res).catch((error: unknown) => {
			console.error(
				`update feed: ${req.method} ${pathOf(req.url)} failed: ${error instanceof Error ? error.message : String(error)}`
			);
			if (!res.headersSent) res.writeHead(500, { 'Content-Length': '0' });
			res.end();
		});
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen({ host: LOOPBACK, port, exclusive: true }, () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});

	const address = server.address() as AddressInfo;
	return {
		url: `http://${address.address}:${address.port}/`,
		address: address.address,
		port: address.port,
		requests: () => [...seen],
		close: () =>
			new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => (error ? rejectClose(error) : resolveClose()));
				server.closeAllConnections();
			})
	};
}
