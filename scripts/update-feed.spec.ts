// Pins the loopback update feed (spec c-5, decision update_flow): it binds
// 127.0.0.1 only, refuses a busy port or a bad one instead of moving (build A's
// baked-in URL names the port), serves only regular files directly in its dir with
// the headers electron-updater reads, answers a single Range with 206 (the blockmap
// download) and records requested paths. Requests go through node:http with the raw
// target, so `/../` reaches the server unnormalised.
//
// The startUpdateFeed tests start their own feed inside the test, never in a hook:
// a mutant that breaks start-up must fail a test, not just a skipped hook.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	fileNameFor,
	parseRange,
	startUpdateFeed,
	UPDATE_FEED_PORT,
	type UpdateFeed
} from './update-feed.ts';

type Reply = { status: number; headers: Record<string, unknown>; body: Buffer };

/** Rejects on a reset or after 2 s of silence, so a response that never ends fails fast. */
function get(
	feed: UpdateFeed,
	target: string,
	headers: Record<string, string> = {},
	method = 'GET'
): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: '127.0.0.1', port: feed.port, path: target, method, headers },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks)
					})
				);
				res.on('error', reject);
			}
		);
		req.setTimeout(2000, () => req.destroy(new Error(`${method} ${target} timed out`)));
		req.on('error', reject);
		req.end();
	});
}

/** Runs `use` against a feed started on an ephemeral port, then closes it. */
async function withFeed(feedDir: string, use: (feed: UpdateFeed) => Promise<void>): Promise<void> {
	const feed = await startUpdateFeed({ dir: feedDir, port: 0 });
	try {
		await use(feed);
	} finally {
		await feed.close();
	}
}

const LATEST = 'version: 0.1.6\npath: Price-Check-Setup-0.1.6.exe\n';
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const BLOCKMAP = '/Price-Check-Setup-0.1.6.exe.blockmap';
const YAML = 'text/yaml; charset=utf-8';
const OCTETS = 'application/octet-stream';

/** A 000 file stays readable to root, so the read-failure tests need a non-root POSIX user. */
const CAN_LOCK = process.platform !== 'win32' && process.getuid?.() !== 0;

let root: string;
let dir: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'update-feed-'));
	dir = join(root, 'feed');
	mkdirSync(join(dir, 'sub'), { recursive: true });
	writeFileSync(join(root, 'package.json'), '{"name":"outside"}');
	writeFileSync(join(dir, 'latest.yml'), LATEST);
	writeFileSync(join(dir, 'notes.yaml'), 'x: 1\n');
	writeFileSync(join(dir, 'empty.bin'), '');
	writeFileSync(join(dir, 'Price-Check-Setup-0.1.6.exe.blockmap'), BINARY);
	writeFileSync(join(dir, 'sub', 'x'), 'nested');
	writeFileSync(join(dir, '.env'), 'SECRET=nope');
	if (process.platform !== 'win32') symlinkSync(join(root, 'package.json'), join(dir, 'link.json'));
	if (CAN_LOCK) {
		writeFileSync(join(dir, 'locked.bin'), 'lock');
		chmodSync(join(dir, 'locked.bin'), 0o000);
	}
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('startUpdateFeed', () => {
	it('binds 127.0.0.1 only and serves from the dir it was given', async () => {
		await withFeed(dir, async (feed) => {
			expect(feed.address).toBe('127.0.0.1');
			expect(feed.port).toBeGreaterThan(0);
			expect(feed.url).toBe(`http://127.0.0.1:${feed.port}/`);
			expect((await get(feed, '/latest.yml')).body.toString('utf8')).toBe(LATEST);
		});
	});

	it('defaults to UPDATE_FEED_PORT, a fixed non-ephemeral port', () => {
		expect(Number.isInteger(UPDATE_FEED_PORT)).toBe(true);
		expect(UPDATE_FEED_PORT).toBeGreaterThan(1024);
		expect(UPDATE_FEED_PORT).toBeLessThan(49152);
	});

	it('rejects a busy port instead of moving to another one', async () => {
		await withFeed(dir, async (feed) => {
			await expect(startUpdateFeed({ dir, port: feed.port })).rejects.toMatchObject({
				code: 'EADDRINUSE'
			});
		});
	});

	it('rejects a dir that is not a directory', async () => {
		await expect(startUpdateFeed({ dir: join(dir, 'latest.yml'), port: 0 })).rejects.toThrow(
			/not a directory/
		);
	});

	it.each([-1, 65536, 1.5, Number.NaN])('rejects port %s as invalid', async (port) => {
		await expect(startUpdateFeed({ dir, port })).rejects.toThrow(
			`update feed: invalid port ${port}`
		);
	});

	it('takes 65535 as a valid port', async () => {
		// The port may be busy on this host; all that matters is that it is not refused as invalid.
		const outcome = await startUpdateFeed({ dir, port: 65535 }).then(
			async (feed) => {
				await feed.close();
				return 'started';
			},
			(error: Error) => error.message
		);
		expect(outcome).not.toMatch(/invalid port/);
	});

	it("lists '/latest.yml' in requests() once fetched, 404s included", async () => {
		await withFeed(dir, async (feed) => {
			expect(feed.requests()).toEqual([]);
			await get(feed, '/latest.yml?noCache=1');
			await get(feed, '/sub/x');
			expect(feed.requests()).toEqual(['/latest.yml', '/sub/x']);
		});
	});

	it('frees the port on close', async () => {
		const first = await startUpdateFeed({ dir, port: 0 });
		const { port } = first;
		await first.close();
		const second = await startUpdateFeed({ dir, port });
		expect(second.port).toBe(port);
		await second.close();
	});

	it('404s, and logs nothing, once its dir has been replaced by a file (ENOTDIR)', async () => {
		const gone = mkdtempSync(join(tmpdir(), 'update-feed-gone-'));
		writeFileSync(join(gone, 'latest.yml'), LATEST);
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await withFeed(gone, async (feed) => {
				rmSync(gone, { recursive: true });
				writeFileSync(gone, 'not a dir');
				const reply = await get(feed, '/latest.yml');
				expect(reply.status).toBe(404);
				expect(log).not.toHaveBeenCalled();
			});
		} finally {
			log.mockRestore();
			rmSync(gone, { recursive: true, force: true });
		}
	});
});

describe('serving', () => {
	let feed: UpdateFeed;

	beforeAll(async () => {
		feed = await startUpdateFeed({ dir, port: 0 });
	});

	afterAll(async () => {
		await feed?.close();
	});

	it('serves latest.yml byte for byte, as uncached YAML that takes ranges', async () => {
		const reply = await get(feed, '/latest.yml');
		expect(reply.status).toBe(200);
		expect(reply.body.toString('utf8')).toBe(LATEST);
		expect(reply.headers['content-length']).toBe(String(Buffer.byteLength(LATEST)));
		expect(reply.headers['content-type']).toBe(YAML);
		expect(reply.headers['accept-ranges']).toBe('bytes');
		expect(reply.headers['cache-control']).toBe('no-store');
		expect(reply.headers).not.toHaveProperty('content-range');
	});

	it.each([
		['/notes.yaml', YAML],
		[BLOCKMAP, OCTETS]
	])('types %s as %s', async (target, type) => {
		const reply = await get(feed, target);
		expect(reply.status).toBe(200);
		expect(reply.headers['content-type']).toBe(type);
	});

	it('ignores a query string (electron-updater may add noCache)', async () => {
		const reply = await get(feed, '/latest.yml?noCache=abc');
		expect(reply.status).toBe(200);
		expect(reply.body.toString('utf8')).toBe(LATEST);
	});

	it('serves an empty file as an empty 200 without trying to read it', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const reply = await get(feed, '/empty.bin');
			expect(reply.status).toBe(200);
			expect(reply.headers['content-length']).toBe('0');
			expect(reply.body.length).toBe(0);
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	it.each([
		'/../package.json',
		'/%2e%2e/package.json',
		'/%2E%2E%2Fpackage.json',
		'/..%5cpackage.json',
		'/sub/x',
		'/sub%2fx',
		'/sub',
		'/',
		'/.env',
		'/link.json',
		'/missing.yml',
		'/%E0%A4%A'
	])('404s %s with a plain "not found"', async (target) => {
		const reply = await get(feed, target);
		expect(reply.status).toBe(404);
		expect(reply.body.toString('utf8')).toBe('not found');
		expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8');
		expect(reply.headers['content-length']).toBe('9');
	});

	it.skipIf(process.platform === 'win32')(
		'500s and logs a lookup failure other than a missing file (ENAMETOOLONG)',
		async () => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const reply = await get(feed, `/${'a'.repeat(300)}`);
				expect(reply.status).toBe(500);
				expect(reply.headers['content-length']).toBe('0');
				expect(log).toHaveBeenCalledWith(expect.stringContaining('ENAMETOOLONG'));
			} finally {
				log.mockRestore();
			}
		}
	);

	it.skipIf(!CAN_LOCK)('drops the connection and logs when a file cannot be read', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await expect(get(feed, '/locked.bin')).rejects.toThrow(/socket hang up/);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining('update feed: reading locked.bin failed: ')
			);
		} finally {
			log.mockRestore();
		}
	});

	it.skipIf(!CAN_LOCK)('answers HEAD from the file size alone, never reading it', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const head = await get(feed, '/locked.bin', {}, 'HEAD');
			expect(head.status).toBe(200);
			expect(head.headers['content-length']).toBe('4');
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	it('gives 206 with exactly 10 bytes for Range: bytes=0-9', async () => {
		const reply = await get(feed, BLOCKMAP, { Range: 'bytes=0-9' });
		expect(reply.status).toBe(206);
		expect(reply.body).toEqual(BINARY.subarray(0, 10));
		expect(reply.headers['content-range']).toBe('bytes 0-9/256');
		expect(reply.headers['content-length']).toBe('10');
	});

	it('serves a mid-file range and a suffix range', async () => {
		const mid = await get(feed, BLOCKMAP, { Range: 'bytes=100-' });
		expect(mid.status).toBe(206);
		expect(mid.body).toEqual(BINARY.subarray(100));
		const tail = await get(feed, BLOCKMAP, { Range: 'bytes=-6' });
		expect(tail.status).toBe(206);
		expect(tail.body).toEqual(BINARY.subarray(250));
	});

	it('416s a range past the end', async () => {
		const reply = await get(feed, '/latest.yml', { Range: 'bytes=9999-' });
		expect(reply.status).toBe(416);
		expect(reply.headers['content-range']).toBe(`bytes */${Buffer.byteLength(LATEST)}`);
		expect(reply.headers['content-length']).toBe('0');
	});

	it('answers HEAD with headers and no body', async () => {
		const head = await get(feed, '/latest.yml', {}, 'HEAD');
		expect(head.status).toBe(200);
		expect(head.body.length).toBe(0);
		expect(head.headers['content-length']).toBe(String(Buffer.byteLength(LATEST)));
	});

	it('405s other methods, naming the two it allows', async () => {
		const post = await get(feed, '/latest.yml', {}, 'POST');
		expect(post.status).toBe(405);
		expect(post.headers['allow']).toBe('GET, HEAD');
		expect(post.headers['content-length']).toBe('0');
	});
});

describe('fileNameFor', () => {
	it('takes plain top-level artefact names', () => {
		expect(fileNameFor('/latest-linux.yml')).toBe('latest-linux.yml');
		expect(fileNameFor('/Price-Check-0.1.6-x86_64.AppImage')).toBe(
			'Price-Check-0.1.6-x86_64.AppImage'
		);
	});

	it.each([
		'',
		'latest.yml',
		'/',
		'/..',
		'/.',
		'/a/b',
		'/a\\b',
		'/%2e%2e',
		'/a%00b',
		'/.hidden',
		'/a..b'
	])('refuses %j', (raw) => {
		expect(fileNameFor(raw)).toBeNull();
	});
});

describe('parseRange', () => {
	it.each([
		[undefined, null],
		['bytes=0-9', { start: 0, end: 9 }],
		[' bytes=0-9 ', { start: 0, end: 9 }],
		['bytes=5-5', { start: 5, end: 5 }],
		['bytes=5-', { start: 5, end: 99 }],
		['bytes=-10', { start: 90, end: 99 }],
		['bytes=90-500', { start: 90, end: 99 }],
		['bytes=0-1,5-6', null],
		['items=0-9', null],
		['xbytes=0-9', null],
		['bytes=-', null],
		['bytes=100-', 'unsatisfiable'],
		['bytes=9-5', 'unsatisfiable'],
		['bytes=-0', 'unsatisfiable']
	])('%j of 100 bytes -> %j', (header, expected) => {
		expect(parseRange(header, 100)).toEqual(expected);
	});

	it.each(['bytes=-5', 'bytes=0-', 'bytes=0-0'])(
		'%j of an empty file is unsatisfiable',
		(header) => {
			expect(parseRange(header, 0)).toBe('unsatisfiable');
		}
	);
});
