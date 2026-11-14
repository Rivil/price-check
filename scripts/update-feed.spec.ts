// Pins the loopback update feed (spec c-5, decision update_flow): it binds
// 127.0.0.1 only, refuses a busy port instead of moving (build A's baked-in URL names
// the port), serves only regular files directly in its dir, answers a single Range
// with 206 (electron-updater's blockmap download) and records requested paths.
// Requests go through node:http with the raw target, so `/../` reaches the server
// unnormalised.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
		req.on('error', reject);
		req.end();
	});
}

const LATEST = 'version: 0.1.6\npath: Price-Check-Setup-0.1.6.exe\n';
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

let root: string;
let dir: string;
let feed: UpdateFeed;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'update-feed-'));
	dir = join(root, 'feed');
	mkdirSync(join(dir, 'sub'), { recursive: true });
	writeFileSync(join(root, 'package.json'), '{"name":"outside"}');
	writeFileSync(join(dir, 'latest.yml'), LATEST);
	writeFileSync(join(dir, 'Price-Check-Setup-0.1.6.exe.blockmap'), BINARY);
	writeFileSync(join(dir, 'sub', 'x'), 'nested');
	writeFileSync(join(dir, '.env'), 'SECRET=nope');
	if (process.platform !== 'win32') symlinkSync(join(root, 'package.json'), join(dir, 'link.json'));
	feed = await startUpdateFeed({ dir, port: 0 });
});

afterAll(async () => {
	await feed?.close();
	rmSync(root, { recursive: true, force: true });
});

describe('startUpdateFeed', () => {
	it('binds 127.0.0.1 only', () => {
		expect(feed.address).toBe('127.0.0.1');
		expect(feed.url).toBe(`http://127.0.0.1:${feed.port}/`);
		expect(feed.port).toBeGreaterThan(0);
	});

	it('defaults to UPDATE_FEED_PORT, a fixed non-ephemeral port', () => {
		expect(Number.isInteger(UPDATE_FEED_PORT)).toBe(true);
		expect(UPDATE_FEED_PORT).toBeGreaterThan(1024);
		expect(UPDATE_FEED_PORT).toBeLessThan(49152);
	});

	it('rejects a busy port instead of moving to another one', async () => {
		await expect(startUpdateFeed({ dir, port: feed.port })).rejects.toMatchObject({
			code: 'EADDRINUSE'
		});
	});

	it('rejects a dir that is not a directory', async () => {
		await expect(startUpdateFeed({ dir: join(dir, 'latest.yml'), port: 0 })).rejects.toThrow(
			/not a directory/
		);
	});

	it('serves latest.yml byte for byte', async () => {
		const reply = await get(feed, '/latest.yml');
		expect(reply.status).toBe(200);
		expect(reply.body.toString('utf8')).toBe(LATEST);
		expect(reply.headers['content-length']).toBe(String(Buffer.byteLength(LATEST)));
	});

	it('ignores a query string (electron-updater may add noCache)', async () => {
		const reply = await get(feed, '/latest.yml?noCache=abc');
		expect(reply.status).toBe(200);
		expect(reply.body.toString('utf8')).toBe(LATEST);
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
	])('404s %s', async (target) => {
		const reply = await get(feed, target);
		expect(reply.status).toBe(404);
		expect(reply.body.toString('utf8')).not.toContain('outside');
		expect(reply.body.toString('utf8')).not.toContain('nested');
		expect(reply.body.toString('utf8')).not.toContain('SECRET');
	});

	it.skipIf(process.platform === 'win32')(
		'500s and logs a lookup failure other than a missing file (ENAMETOOLONG)',
		async () => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const reply = await get(feed, `/${'a'.repeat(300)}`);
				expect(reply.status).toBe(500);
				expect(log).toHaveBeenCalledWith(expect.stringContaining('ENAMETOOLONG'));
			} finally {
				log.mockRestore();
			}
		}
	);

	it('gives 206 with exactly 10 bytes for Range: bytes=0-9', async () => {
		const reply = await get(feed, '/Price-Check-Setup-0.1.6.exe.blockmap', { Range: 'bytes=0-9' });
		expect(reply.status).toBe(206);
		expect(reply.body).toEqual(BINARY.subarray(0, 10));
		expect(reply.headers['content-range']).toBe('bytes 0-9/256');
		expect(reply.headers['content-length']).toBe('10');
	});

	it('serves a mid-file range and a suffix range', async () => {
		const mid = await get(feed, '/Price-Check-Setup-0.1.6.exe.blockmap', { Range: 'bytes=100-' });
		expect(mid.status).toBe(206);
		expect(mid.body).toEqual(BINARY.subarray(100));
		const tail = await get(feed, '/Price-Check-Setup-0.1.6.exe.blockmap', { Range: 'bytes=-6' });
		expect(tail.status).toBe(206);
		expect(tail.body).toEqual(BINARY.subarray(250));
	});

	it('416s a range past the end', async () => {
		const reply = await get(feed, '/latest.yml', { Range: 'bytes=9999-' });
		expect(reply.status).toBe(416);
		expect(reply.headers['content-range']).toBe(`bytes */${Buffer.byteLength(LATEST)}`);
	});

	it('answers HEAD with headers and no body, and 405s other methods', async () => {
		const head = await get(feed, '/latest.yml', {}, 'HEAD');
		expect(head.status).toBe(200);
		expect(head.body.length).toBe(0);
		expect(head.headers['content-length']).toBe(String(Buffer.byteLength(LATEST)));
		const post = await get(feed, '/latest.yml', {}, 'POST');
		expect(post.status).toBe(405);
	});

	it("lists '/latest.yml' in requests() once fetched, 404s included", async () => {
		const fresh = await startUpdateFeed({ dir, port: 0 });
		try {
			expect(fresh.requests()).toEqual([]);
			await get(fresh, '/latest.yml?noCache=1');
			await get(fresh, '/sub/x');
			expect(fresh.requests()).toEqual(['/latest.yml', '/sub/x']);
		} finally {
			await fresh.close();
		}
	});

	it('frees the port on close', async () => {
		const first = await startUpdateFeed({ dir, port: 0 });
		const { port } = first;
		await first.close();
		const second = await startUpdateFeed({ dir, port });
		expect(second.port).toBe(port);
		await second.close();
	});
});

describe('fileNameFor', () => {
	it('takes plain top-level artefact names', () => {
		expect(fileNameFor('/latest-linux.yml')).toBe('latest-linux.yml');
		expect(fileNameFor('/Price-Check-0.1.6-x86_64.AppImage')).toBe(
			'Price-Check-0.1.6-x86_64.AppImage'
		);
	});

	it.each(['', '/', '/..', '/.', '/a/b', '/a\\b', '/%2e%2e', '/a%00b', '/.hidden', '/a..b'])(
		'refuses %j',
		(raw) => {
			expect(fileNameFor(raw)).toBeNull();
		}
	);
});

describe('parseRange', () => {
	it.each([
		[undefined, null],
		['bytes=0-9', { start: 0, end: 9 }],
		['bytes=5-', { start: 5, end: 99 }],
		['bytes=-10', { start: 90, end: 99 }],
		['bytes=90-500', { start: 90, end: 99 }],
		['bytes=0-1,5-6', null],
		['items=0-9', null],
		['bytes=-', null],
		['bytes=100-', 'unsatisfiable'],
		['bytes=9-5', 'unsatisfiable'],
		['bytes=-0', 'unsatisfiable']
	])('%j of 100 bytes -> %j', (header, expected) => {
		expect(parseRange(header, 100)).toEqual(expected);
	});
});
