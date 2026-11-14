import type { RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import hooksSource from './hooks.server.ts?raw';

// The real hooks module, with everything it would start or reach replaced: init
// must hand the scheduler the server's env, build flag, db and a check that goes
// through the shared-client checkUrl. Nothing here can make a request (r-01).
// A valid key for the server's ALERTS_ENCRYPTION_KEY: base64 of 32 bytes.
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

const mocks = vi.hoisted(() => ({
	db: { name: 'the app db' },
	env: { building: false, key: undefined as string | undefined },
	setAlertsKey: vi.fn(),
	order: [] as string[],
	migrateDb: vi.fn(),
	startScheduler: vi.fn(),
	checkUrl: vi.fn(async (url: string) => ({ ok: false, reason: 'blocked', message: url }))
}));
vi.mock('$app/env', () => ({
	get building() {
		return mocks.env.building;
	}
}));
vi.mock('#lib/server/db/migrate.ts', () => ({ migrateDb: mocks.migrateDb }));
vi.mock('$app/env/private', () => ({
	CHECK_INTERVAL_HOURS: '12',
	SCHEDULER_DISABLED: '',
	get ALERTS_ENCRYPTION_KEY() {
		return mocks.env.key;
	}
}));
// The real parser; setAlertsKey records the step so its order can be checked.
vi.mock('#lib/server/alerts/crypto.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/alerts/crypto.ts')>()),
	setAlertsKey: mocks.setAlertsKey
}));
vi.mock('#lib/server/db/index.ts', () => ({ db: mocks.db }));
vi.mock('#lib/server/scheduler.ts', () => ({ startScheduler: mocks.startScheduler }));
vi.mock('#lib/server/shops/index.ts', () => ({ checkUrl: mocks.checkUrl }));

beforeEach(() => {
	mocks.env.building = false;
	mocks.env.key = VALID_KEY;
	mocks.order.length = 0;
	mocks.setAlertsKey.mockReset().mockImplementation(() => {
		mocks.order.push('key');
	});
	mocks.migrateDb.mockReset().mockImplementation(async () => {
		// Resolves on a later tick: init must wait for it before starting the scheduler.
		await new Promise((done) => setTimeout(done, 5));
		mocks.order.push('migrated');
	});
	mocks.startScheduler.mockReset().mockImplementation(() => {
		mocks.order.push('scheduler');
		return null;
	});
	mocks.checkUrl.mockClear();
});

describe('hooks.server', () => {
	it('init migrates the app db before starting the scheduler', async () => {
		const hooks = await import('./hooks.server.ts');
		await hooks.init();

		expect(mocks.migrateDb).toHaveBeenCalledExactlyOnceWith(mocks.db);
		expect(mocks.order).toEqual(['key', 'migrated', 'scheduler']);
	});

	it('order', async () => {
		const hooks = await import('./hooks.server.ts');
		await hooks.init();

		// No legacy-channel backfill step any more: key, migrate, scheduler.
		expect(mocks.order).toEqual(['key', 'migrated', 'scheduler']);
		expect(mocks.setAlertsKey).toHaveBeenCalledOnce();
		const [key] = mocks.setAlertsKey.mock.calls[0] as [Buffer];
		expect(Buffer.isBuffer(key)).toBe(true);
		expect(key.equals(Buffer.alloc(32, 7))).toBe(true);
	});

	it('refuses', async () => {
		const short = Buffer.alloc(31, 9).toString('base64');
		for (const key of [undefined, '', short, 'not base64 at all!']) {
			mocks.env.key = key;
			mocks.order.length = 0;
			mocks.migrateDb.mockClear();
			mocks.startScheduler.mockClear();
			const hooks = await import('./hooks.server.ts');

			const error = await Promise.resolve()
				.then(() => hooks.init())
				.then(
					() => null,
					(reason: unknown) => reason as Error
				);
			expect(error, String(key)).toBeInstanceOf(Error);
			expect(error!.message, String(key)).toContain('ALERTS_ENCRYPTION_KEY');
			if (key) expect(error!.message, key).not.toContain(key);
			expect(mocks.setAlertsKey).not.toHaveBeenCalled();
			expect(mocks.migrateDb).not.toHaveBeenCalled();
			expect(mocks.startScheduler).not.toHaveBeenCalled();
			expect(mocks.order).toEqual([]);
		}
	});

	it('build', async () => {
		mocks.env.building = true;
		mocks.env.key = undefined;
		const hooks = await import('./hooks.server.ts');

		await expect(hooks.init()).resolves.toBeUndefined();
		expect(mocks.setAlertsKey).not.toHaveBeenCalled();
		expect(mocks.migrateDb).not.toHaveBeenCalled();
	});

	it('init does not migrate while building', async () => {
		mocks.env.building = true;
		const hooks = await import('./hooks.server.ts');
		await hooks.init();

		expect(mocks.migrateDb).not.toHaveBeenCalled();
		expect(mocks.startScheduler).toHaveBeenCalledOnce();
		expect(mocks.startScheduler.mock.calls[0][0]).toMatchObject({ building: true });
	});

	it('a failed migration stops startup', async () => {
		mocks.migrateDb.mockRejectedValueOnce(new Error('migration broke'));
		const hooks = await import('./hooks.server.ts');

		await expect(hooks.init()).rejects.toThrow('migration broke');
		expect(mocks.startScheduler).not.toHaveBeenCalled();
	});

	it('init', async () => {
		const hooks = await import('./hooks.server.ts');
		expect(mocks.startScheduler).not.toHaveBeenCalled();

		await hooks.init();

		expect(mocks.startScheduler).toHaveBeenCalledOnce();
		const [options] = mocks.startScheduler.mock.calls[0] as [Record<string, unknown>];
		expect(options).toEqual({
			env: { CHECK_INTERVAL_HOURS: '12', SCHEDULER_DISABLED: '', VITEST: process.env.VITEST },
			building: false,
			db: mocks.db,
			check: expect.any(Function)
		});

		const check = options.check as (url: string) => Promise<unknown>;
		expect(await check('https://www.amazon.co.uk/dp/B0ABC12345')).toEqual({
			ok: false,
			reason: 'blocked',
			message: 'https://www.amazon.co.uk/dp/B0ABC12345'
		});
		expect(mocks.checkUrl).toHaveBeenCalledExactlyOnceWith(
			'https://www.amazon.co.uk/dp/B0ABC12345'
		);
	});
});

describe('handle', () => {
	function fakeEvent(path: string, headers: Record<string, string>) {
		const url = new URL(path, 'http://localhost:5173');
		return {
			url,
			route: { id: url.pathname },
			request: new Request(url, { headers }),
			cookies: { get: () => undefined, getAll: () => [] },
			locals: {}
		} as unknown as RequestEvent;
	}

	async function run(event: RequestEvent) {
		const { handle } = await import('./hooks.server.ts');
		const resolve = vi.fn(async () => new Response('ok'));
		const res = await handle({ event, resolve });
		return { res, resolve };
	}

	it('handle guards /health', async () => {
		// The guard runs first for every path: no /health bypass ahead of it.
		const { res, resolve } = await run(fakeEvent('/health', { host: 'evil.example' }));

		expect(res.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('handle serves / without login', async () => {
		const event = fakeEvent('/', { host: 'localhost:5173' });
		const { res, resolve } = await run(event);

		// No cookie and no session, yet no redirect to /login: one resolve, its response.
		expect(res.status).toBe(200);
		expect(res.headers.get('location')).toBeNull();
		expect(await res.text()).toBe('ok');
		expect(resolve).toHaveBeenCalledExactlyOnceWith(event);
	});

	it('handle imports', () => {
		// Static imports only: the auth stack is gone from the request path (c-1).
		const specifiers = [...hooksSource.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
		expect(specifiers).toContain('#lib/server/local-request.ts');
		expect(specifiers.filter((s) => s === 'better-auth' || s.startsWith('better-auth/'))).toEqual(
			[]
		);
		expect(specifiers.filter((s) => /\/server\/(?:auth|access)(?:\.ts)?$/.test(s))).toEqual([]);
		expect(hooksSource).not.toMatch(/import\s*\(/);
	});
});

describe('handleError', () => {
	const TOPIC = 'https://ntfy.sh/alice-secret-topic';
	const TOKEN = 'tk_abcdefghijklmnopqrstuvwxyz012'; // token-shaped, not a real one
	const event = {
		route: { id: '/watches/[id]' },
		url: new URL('https://prices.example/watches/url-only-value')
	};

	/** Runs the real hook with the real formatter, and returns what it logged. */
	async function run(input: { kind: string; error: unknown }) {
		const { handleError } = await import('./hooks.server.ts');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await handleError({ ...input, event } as never);
			return { result, calls: [...consoleError.mock.calls] };
		} finally {
			consoleError.mockRestore();
		}
	}

	function expectNoSecrets(calls: unknown[][]) {
		const logged = calls.flat().map(String).join('\n');
		expect(logged).not.toContain('alice-secret-topic');
		expect(logged).not.toContain(TOKEN);
		expect(logged).not.toContain('url-only-value');
	}

	it('handleError', async () => {
		const error = new TypeError(`Failed query\nparams: ${TOPIC},${TOKEN}`);

		const { calls } = await run({ kind: 'unknown', error });

		expect(calls).toEqual([
			[expect.stringMatching(/^\[server\] error on route \/watches\/\[id\]: TypeError\n {4}at /)]
		]);
		expectNoSecrets(calls);
	});

	it('handleError cause', async () => {
		const error = new Error('outer', { cause: new Error(`inner ${TOPIC} ${TOKEN}`) });

		const { calls } = await run({ kind: 'unknown', error });

		// One string: an Error object here would stringify clean, yet print its cause.
		expect(calls).toEqual([[expect.stringMatching(/^\[server\] error on route .+: Error\n/)]]);
		expectNoSecrets(calls);
	});

	it('handleError expected errors', async () => {
		for (const kind of ['app', 'framework', 'validation']) {
			const { calls } = await run({ kind, error: { status: 404, message: 'Not Found' } });
			expect(calls, kind).toEqual([]);
		}
	});

	it('handleError response', async () => {
		const { result } = await run({ kind: 'unknown', error: new Error('boom') });

		// Nothing returned, so nothing overrides Kit's 'Internal Error'.
		expect(result).toBeUndefined();
	});

	it('handleError no stack', async () => {
		const error = new TypeError(`fetch failed for ${TOPIC}`);
		delete error.stack;

		const { calls } = await run({ kind: 'unknown', error });

		expect(calls).toEqual([['[server] error on route /watches/[id]: TypeError']]);
	});
});
