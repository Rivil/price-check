import dgram from 'node:dgram';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeTempDir } from '#lib/server/testing/temp-dir.ts';
import {
	E2E_CONTROL_ENV,
	startE2eControl,
	startE2eControlFromEnv,
	takeE2eControlDir,
	type ControlFs,
	type ControlTimers,
	type E2eControl,
	type E2eControlHandlers
} from './e2e-control.ts';

const SECRET = 'SENTINEL-session-secret-0123456789abcdef';
const PID = 4242;

/** Handlers that each return something, several of them carrying the secret. */
function handlers(overrides: Partial<E2eControlHandlers> = {}) {
	const all: E2eControlHandlers = {
		pid: vi.fn(() => PID),
		info: vi.fn(() => ({
			version: '0.2.1',
			isPackaged: true,
			userData: '/tmp/user',
			platform: 'darwin',
			arch: 'arm64',
			origin: 'http://127.0.0.1:43123',
			argv: ['app', `--secret=${SECRET}`],
			execArgv: []
		})),
		quit: vi.fn(),
		loginItemOff: vi.fn(() => ({ openAtLogin: false })),
		updaterStatus: vi.fn(() => ({ state: 'idle', note: SECRET })),
		updaterCheckNow: vi.fn(() => ({ checked: true })),
		updaterRestart: vi.fn(),
		keyBackend: vi.fn(() => 'keychain'),
		appGet: vi.fn(async (path: string) => ({
			status: 200,
			body: `<p>${path}</p><input value="${SECRET}">`
		})),
		sessionSecret: vi.fn(() => SECRET),
		...overrides
	};
	return all;
}

const dirs: string[] = [];
const controls: E2eControl[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'e2e-control-'));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const control of controls.splice(0)) await control.stop();
	for (const dir of dirs.splice(0)) removeTempDir(dir);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** A started channel on a real temp dir, with a long poll so tests drive it by poll(). */
function started(h: E2eControlHandlers, pid = PID) {
	const dir = tempDir();
	const control = startE2eControl(dir, h, { pid, pollMs: 60_000 });
	controls.push(control);
	const own = join(dir, String(pid));
	return {
		dir,
		control,
		request(n: number, body: unknown, under = own) {
			mkdirSync(under, { recursive: true });
			writeFileSync(
				join(under, `req-${n}.json`),
				typeof body === 'string' ? body : JSON.stringify(body)
			);
		},
		response(n: number, under = own) {
			const file = join(under, `res-${n}.json`);
			return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
		},
		raw(n: number) {
			return readFileSync(join(own, `res-${n}.json`), 'utf8');
		}
	};
}

describe('takeE2eControlDir', () => {
	it('takes only an absolute path, and always removes the variable', () => {
		const absolute = join(tmpdir(), 'control');
		for (const [value, expected] of [
			[undefined, null],
			['', null],
			['relative/dir', null],
			['./dir', null],
			[absolute, absolute]
		] as const) {
			const env: NodeJS.ProcessEnv = { OTHER: '1' };
			if (value !== undefined) env[E2E_CONTROL_ENV] = value;
			expect(takeE2eControlDir(env), String(value)).toBe(expected);
			expect(E2E_CONTROL_ENV in env, String(value)).toBe(false);
			expect(env.OTHER).toBe('1');
		}
	});
});

describe('startE2eControlFromEnv', () => {
	it('inactive unless set', async () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		const record =
			(name: string) =>
			async (..._args: unknown[]) => {
				void _args;
				calls.push(name);
				return [] as never;
			};
		const fs: ControlFs = {
			mkdir: record('mkdir'),
			readdir: record('readdir'),
			readFile: record('readFile'),
			writeFile: record('writeFile'),
			rename: record('rename'),
			rm: record('rm')
		};
		const timers: ControlTimers = {
			setInterval: vi.fn(() => 1),
			clearInterval: vi.fn()
		};
		const h = handlers();

		for (const env of [{}, { [E2E_CONTROL_ENV]: '' }, { [E2E_CONTROL_ENV]: 'rel' }]) {
			expect(startE2eControlFromEnv(env, h, { pid: PID, fs, timers })).toBeNull();
		}
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls).toEqual([]);
		expect(timers.setInterval).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
	});

	it('starts on an absolute directory', async () => {
		const dir = tempDir();
		const env: NodeJS.ProcessEnv = { [E2E_CONTROL_ENV]: dir };
		const control = startE2eControlFromEnv(env, handlers(), { pid: PID, pollMs: 60_000 });
		expect(control).not.toBeNull();
		controls.push(control!);
		expect(E2E_CONTROL_ENV in env).toBe(false);
		mkdirSync(join(dir, String(PID)), { recursive: true });
		writeFileSync(join(dir, String(PID), 'req-1.json'), JSON.stringify({ cmd: 'pid' }));
		await control!.poll();
		expect(JSON.parse(readFileSync(join(dir, String(PID), 'res-1.json'), 'utf8'))).toEqual({
			ok: true,
			result: PID
		});
	});
});

describe('startE2eControl', () => {
	it('answers each known command from its handler', async () => {
		const h = handlers();
		const c = started(h);
		const commands = [
			{ cmd: 'pid' },
			{ cmd: 'info' },
			{ cmd: 'loginItemOff' },
			{ cmd: 'updaterStatus' },
			{ cmd: 'updaterCheckNow' },
			{ cmd: 'keyBackend' },
			{ cmd: 'appGet', path: '/account/alerts' }
		];
		commands.forEach((body, i) => c.request(i + 1, body));
		await c.control.poll();

		expect(c.response(1)).toEqual({ ok: true, result: PID });
		expect(c.response(2)).toMatchObject({
			ok: true,
			result: { version: '0.2.1', isPackaged: true }
		});
		expect(c.response(3)).toEqual({ ok: true, result: { openAtLogin: false } });
		expect(c.response(5)).toEqual({ ok: true, result: { checked: true } });
		expect(c.response(6)).toEqual({ ok: true, result: 'keychain' });
		expect(c.response(7)).toMatchObject({ ok: true, result: { status: 200 } });
		expect(h.appGet).toHaveBeenCalledExactlyOnceWith('/account/alerts');
		// Requests are consumed.
		expect(readdirSync(join(c.dir, String(PID))).filter((f) => f.startsWith('req-'))).toEqual([]);
	});

	it('quit and updaterRestart answer before they run', async () => {
		for (const cmd of ['quit', 'updaterRestart'] as const) {
			let answeredFirst: boolean | undefined;
			const dir = tempDir();
			const own = join(dir, String(PID));
			const h = handlers({
				[cmd]: vi.fn(() => {
					answeredFirst = existsSync(join(own, 'res-1.json'));
				})
			});
			const control = startE2eControl(dir, h, { pid: PID, pollMs: 60_000 });
			controls.push(control);
			mkdirSync(own, { recursive: true });
			writeFileSync(join(own, 'req-1.json'), JSON.stringify({ cmd }));
			await control.poll();
			expect(h[cmd], cmd).toHaveBeenCalledOnce();
			expect(answeredFirst, cmd).toBe(true);
			expect(JSON.parse(readFileSync(join(own, 'res-1.json'), 'utf8')), cmd).toEqual({
				ok: true,
				result: null
			});
		}
	});

	it('refuses anything outside the fixed set', async () => {
		const h = handlers();
		const c = started(h);
		const bad = [
			{ cmd: 'eval', code: 'process.exit(1)' },
			{ cmd: 'eval' },
			{ cmd: 'nope' },
			{ cmd: 'pid', extra: 1 },
			{ cmd: 'info', path: '/' },
			{ cmd: 'appGet' },
			{ cmd: 'appGet', path: '/x', extra: true },
			{ cmd: 'appGet', path: 'http://evil.example/' },
			{ cmd: 'appGet', path: '//evil.example/' },
			{ cmd: 'appGet', path: 7 },
			{ cmd: 'sessionSecret' },
			{ cmd: 'constructor' },
			{ cmd: '__proto__' },
			['pid'],
			'not json',
			'null',
			'"pid"'
		];
		bad.forEach((body, i) => c.request(i + 1, body));
		await c.control.poll();

		bad.forEach((body, i) =>
			expect(c.response(i + 1), JSON.stringify(body)).toEqual({
				ok: false,
				error: 'unknown command'
			})
		);
		for (const fn of Object.values(h)) {
			if (fn !== h.sessionSecret) expect(fn).not.toHaveBeenCalled();
		}
	});

	it('a handler that throws gives a fixed error, never its text', async () => {
		const c = started(
			handlers({
				info: vi.fn(() => {
					throw new Error(`boom ${SECRET}`);
				}),
				appGet: vi.fn(async () => {
					throw new Error(`cookie pc_session=${SECRET}`);
				})
			})
		);
		c.request(1, { cmd: 'info' });
		c.request(2, { cmd: 'appGet', path: '/' });
		await c.control.poll();
		expect(c.response(1)).toEqual({ ok: false, error: 'info failed' });
		expect(c.response(2)).toEqual({ ok: false, error: 'appGet failed' });
	});

	it('no response carries the session secret', async () => {
		const c = started(handlers());
		const all = [
			'pid',
			'info',
			'quit',
			'loginItemOff',
			'updaterStatus',
			'updaterCheckNow',
			'updaterRestart',
			'keyBackend'
		].map((cmd) => ({ cmd }) as Record<string, unknown>);
		all.push({ cmd: 'appGet', path: '/' }, { cmd: 'unknown' });
		all.forEach((body, i) => c.request(i + 1, body));
		await c.control.poll();
		all.forEach((body, i) => {
			const text = c.raw(i + 1);
			expect(text, JSON.stringify(body)).not.toContain(SECRET);
		});
		expect(c.raw(9)).toContain('[redacted]');
	});

	it("ignores another pid's directory", async () => {
		const h = handlers();
		const c = started(h);
		const other = join(c.dir, String(PID + 1));
		c.request(1, { cmd: 'pid' }, other);
		await c.control.poll();
		expect(c.response(1, other)).toBeUndefined();
		expect(existsSync(join(other, 'req-1.json'))).toBe(true);
		expect(h.pid).not.toHaveBeenCalled();
	});

	it('stop() leaves no timer running', async () => {
		vi.useFakeTimers();
		const dir = tempDir();
		const control = startE2eControl(dir, handlers(), { pid: PID, pollMs: 50 });
		expect(vi.getTimerCount()).toBe(1);
		await control.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('no network listener', async () => {
		const listen = vi.spyOn(net.Server.prototype, 'listen');
		const createServer = vi.spyOn(http, 'createServer');
		const createHttpsServer = vi.spyOn(https, 'createServer');
		const createSocket = vi.spyOn(dgram, 'createSocket');
		const c = started(handlers());
		['pid', 'info', 'keyBackend'].forEach((cmd, i) => c.request(i + 1, { cmd }));
		c.request(4, { cmd: 'appGet', path: '/' });
		await c.control.poll();
		expect(c.response(1)).toEqual({ ok: true, result: PID });
		expect(listen).not.toHaveBeenCalled();
		expect(createServer).not.toHaveBeenCalled();
		expect(createHttpsServer).not.toHaveBeenCalled();
		expect(createSocket).not.toHaveBeenCalled();
	});

	it('answers a pid request through the real timer within 2 s', async () => {
		const dir = tempDir();
		const control = startE2eControl(dir, handlers(), { pid: PID });
		controls.push(control);
		const own = join(dir, String(PID));
		mkdirSync(own, { recursive: true });
		writeFileSync(join(own, 'req-7.json'), JSON.stringify({ cmd: 'pid' }));
		await vi.waitFor(() => expect(existsSync(join(own, 'res-7.json'))).toBe(true), {
			timeout: 2_000,
			interval: 25
		});
		expect(JSON.parse(readFileSync(join(own, 'res-7.json'), 'utf8'))).toEqual({
			ok: true,
			result: PID
		});
		// The response landed whole: no temp file is left behind.
		expect(readdirSync(own).filter((f) => f.endsWith('.tmp'))).toEqual([]);
	});

	it('a quit that throws after its ok is reported on stderr, without its text', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const c = started(
			handlers({
				quit: vi.fn(() => {
					throw new Error(`quit blew up ${SECRET}`);
				})
			})
		);
		c.request(1, { cmd: 'quit' });
		await c.control.poll();
		expect(c.response(1)).toEqual({ ok: true, result: null });
		expect(errors).toHaveBeenCalledExactlyOnceWith(
			'[e2e-control] quit failed after it was acknowledged'
		);
	});

	it('every consumed request is answered or reported', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		// A result JSON cannot hold.
		const big = started(handlers({ keyBackend: vi.fn(() => ({ size: 1n })) }));
		big.request(1, { cmd: 'keyBackend' });
		await big.control.poll();
		expect(big.response(1)).toEqual({ ok: false, error: 'keyBackend result not serialisable' });

		// No secret to redact with: no handler runs.
		const noSecret = handlers({
			sessionSecret: vi.fn(() => {
				throw new Error('gone');
			})
		});
		const ns = started(noSecret);
		ns.request(1, { cmd: 'info' });
		await ns.control.poll();
		expect(ns.response(1)).toEqual({ ok: false, error: 'session secret unavailable' });
		expect(noSecret.info).not.toHaveBeenCalled();

		// The response cannot be written: reported with the request number only.
		const dir = tempDir();
		const own = join(dir, String(PID));
		mkdirSync(own, { recursive: true });
		writeFileSync(join(own, 'req-3.json'), JSON.stringify({ cmd: 'pid' }));
		const failing: ControlFs = {
			mkdir: (path, options) => fsp.mkdir(path, options),
			readdir: (path) => fsp.readdir(path),
			readFile: (path, encoding) => fsp.readFile(path, encoding),
			writeFile: async () => {
				throw new Error(`disk full ${SECRET}`);
			},
			rename: async () => undefined,
			rm: (path, options) => fsp.rm(path, options)
		};
		const control = startE2eControl(dir, handlers(), { pid: PID, fs: failing, pollMs: 60_000 });
		controls.push(control);
		await control.poll();
		expect(errors).toHaveBeenCalledWith('[e2e-control] could not write the response to request 3');
		for (const [line] of errors.mock.calls) expect(String(line)).not.toContain(SECRET);
	});
});
