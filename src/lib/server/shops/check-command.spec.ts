import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPence } from '../../money.ts';
import { USAGE, runCheckCommand } from './check-command.ts';
import { createShopRegistry } from './registry.ts';
import { failure, type CheckResult, type ShopAdapter, type ShopClient } from './types.ts';

const URL_OK = 'https://shop.test/p/B0TEST0001';
const PAGE = '<html><body>exact bytes: £1,299.99 — ü 🛒\r\n</body></html>\n';

let outer: string;
let fixturesDir: string;

beforeEach(() => {
	outer = mkdtempSync(join(tmpdir(), 'adapter-check-'));
	fixturesDir = join(outer, 'fixtures');
	mkdirSync(fixturesDir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A test shop on shop.test: fetches the URL through the client, then returns `result`. */
function setup(result: CheckResult, body: string | null | Error = PAGE, onRequest = () => {}) {
	const request = vi.fn<ShopClient['request']>(async (url) => {
		onRequest();
		if (body instanceof Error) throw body;
		return { status: 200, url, headers: new Headers(), body };
	});
	const client: ShopClient = { request };
	const adapter: ShopAdapter = {
		id: 'test-shop',
		fixturesDir: '/nonexistent',
		claims: (url) => url.hostname === 'shop.test',
		async check(url, deps) {
			await deps.client.request(url.href);
			return result;
		}
	};
	const out: string[] = [];
	const err: string[] = [];
	const run = (argv: string[]) =>
		runCheckCommand(argv, {
			client,
			registry: createShopRegistry([adapter]),
			stdout: { write: (text: string) => out.push(text) },
			stderr: { write: (text: string) => err.push(text) },
			fixturesDirFor: () => fixturesDir
		});
	return { run, request, stdout: () => out.join(''), stderr: () => err.join('') };
}

const okResult: CheckResult = {
	ok: true,
	shop: 'test-shop',
	productId: 'B0TEST0001',
	canonicalUrl: URL_OK,
	title: 'Big Telly',
	pricePence: 129999,
	imageUrl: null
};

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('runCheckCommand', () => {
	it('output', async () => {
		const ok = setup(okResult);
		expect(await ok.run([URL_OK])).toBe(0);
		expect(ok.stdout()).toContain('B0TEST0001');
		expect(ok.stdout()).toContain('Big Telly');
		expect(ok.stdout()).toContain('£1,299.99');
		expect(ok.stderr()).toBe('');

		for (const result of [
			failure('blocked', 'Amazon served a robot-check (captcha) page'),
			failure('unavailable', 'no buy-box offer'),
			failure('variant_required', 'pick a size/colour'),
			failure('parse_failed', 'no buy-box price found'),
			failure('not_found', 'product not found (HTTP 404)'),
			failure('fetch_failed', 'product page returned HTTP 500')
		]) {
			const failed = setup(result);
			expect(await failed.run([URL_OK]), result.ok ? '' : result.reason).toBe(1);
			expect(failed.stderr()).toBe(`${result.ok ? '' : `${result.reason}: ${result.message}`}\n`);
			expect(failed.stdout()).toBe('');
		}

		expect(formatPence(5)).toBe('£0.05');
		expect(formatPence(1999)).toBe('£19.99');
		expect(formatPence(123456789)).toBe('£1,234,567.89');
	});

	it('save fixture', async () => {
		const { run, stdout } = setup(okResult);

		expect(await run([URL_OK, '--save-fixture', 'foo'])).toBe(0);

		const saved = join(fixturesDir, 'foo.html');
		expect(readFileSync(saved)).toEqual(Buffer.from(PAGE, 'utf8'));
		expect(stdout()).toContain(saved);
	});

	it('no overwrite', async () => {
		const existing = join(fixturesDir, 'foo.html');
		writeFileSync(existing, 'original');
		const before = sha256(existing);

		const refused = setup(okResult);
		expect(await refused.run([URL_OK, '--save-fixture', 'foo'])).not.toBe(0);
		expect(refused.stderr()).toContain('exists');
		expect(refused.request).toHaveBeenCalledTimes(0);
		expect(sha256(existing)).toBe(before);

		const forced = setup(okResult);
		expect(await forced.run([URL_OK, '--save-fixture', 'foo', '--force'])).toBe(0);
		expect(readFileSync(existing, 'utf8')).toBe(PAGE);
	});

	it('name validation', async () => {
		for (const name of ['../x', 'a/b', '', '.hidden', 'Foo Bar', '.html', 'x.html.html']) {
			const { run, request } = setup(okResult);
			expect(await run([URL_OK, '--save-fixture', name]), name).toBe(2);
			expect(request, name).toHaveBeenCalledTimes(0);
		}
		expect(readdirSync(outer)).toEqual(['fixtures']);
		expect(readdirSync(fixturesDir)).toEqual([]);

		for (const name of ['bar', 'baz.html']) {
			expect(await setup(okResult).run([URL_OK, '--save-fixture', name])).toBe(0);
		}
		expect(readdirSync(fixturesDir).sort()).toEqual(['bar.html', 'baz.html']);
	});

	it('save on failure', async () => {
		for (const [name, result] of [
			['blocked-page', failure('blocked', 'captcha')],
			['unavailable-page', failure('unavailable', 'currently unavailable')]
		] as const) {
			expect(await setup(result).run([URL_OK, '--save-fixture', name]), name).toBe(1);
			expect(readFileSync(join(fixturesDir, `${name}.html`), 'utf8')).toBe(PAGE);
		}

		const unsupported = setup(okResult);
		expect(await unsupported.run(['https://elsewhere.test/p/1', '--save-fixture', 'nope'])).toBe(1);
		expect(unsupported.stderr()).toContain('unsupported URL');
		expect(unsupported.stderr()).toContain('nothing to save');
		expect(unsupported.request).toHaveBeenCalledTimes(0);

		const noBody = setup(
			failure('fetch_failed', 'product page request failed (network error)'),
			Object.assign(new Error('down'), { kind: 'network' })
		);
		// The stub adapter lets the client error escape; the registry maps it to fetch_failed.
		expect(await noBody.run([URL_OK, '--save-fixture', 'empty'])).toBe(1);
		expect(noBody.stderr()).toContain('fetch_failed');
		expect(noBody.stderr()).toContain('nothing to save');

		expect(readdirSync(fixturesDir).sort()).toEqual(['blocked-page.html', 'unavailable-page.html']);
	});

	it('save race', async () => {
		const target = join(fixturesDir, 'race.html');
		// The fixture appears after the pre-check passed, while the page is being fetched.
		const racing = () => writeFileSync(target, 'racing');

		const refused = setup(okResult, PAGE, racing);
		expect(await refused.run([URL_OK, '--save-fixture', 'race'])).toBe(2);
		expect(refused.stderr()).toContain(`could not save ${target}`);
		expect(refused.stdout()).not.toContain('saved fixture');
		expect(readFileSync(target, 'utf8')).toBe('racing');

		const forced = setup(okResult, PAGE, racing);
		expect(await forced.run([URL_OK, '--save-fixture', 'race', '--force'])).toBe(0);
		expect(readFileSync(target, 'utf8')).toBe(PAGE);
		expect(forced.stdout()).toContain(`saved fixture ${target}\n`);
	});

	it('nothing to save', async () => {
		// A same-named fixture is irrelevant when no adapter claims the URL.
		writeFileSync(join(fixturesDir, 'nope.html'), 'original');
		const fixturesDirFor = vi.fn(() => fixturesDir);
		const err: string[] = [];
		const code = await runCheckCommand(['https://elsewhere.test/p/1', '--save-fixture', 'nope'], {
			client: { request: vi.fn() },
			registry: createShopRegistry([]),
			stdout: { write: () => undefined },
			stderr: { write: (text: string) => err.push(text) },
			fixturesDirFor
		});

		expect(code).toBe(1);
		expect(err.join('')).toBe(
			'unsupported: unsupported URL\nadapter:check: nothing to save (no page was fetched)\n'
		);
		expect(fixturesDirFor).not.toHaveBeenCalled();
		expect(readFileSync(join(fixturesDir, 'nope.html'), 'utf8')).toBe('original');
	});

	it('saves the last page body', async () => {
		// A redirect-only hop (no body) after the page must not erase what was fetched.
		const request = vi.fn<ShopClient['request']>(async (url, options) => ({
			status: 200,
			url,
			headers: new Headers(),
			body: options?.readBody === false ? null : PAGE
		}));
		const adapter: ShopAdapter = {
			id: 'test-shop',
			fixturesDir: '/nonexistent',
			claims: (url) => url.hostname === 'shop.test',
			async check(url, deps) {
				await deps.client.request(url.href);
				await deps.client.request(url.href, { readBody: false });
				return okResult;
			}
		};
		const code = await runCheckCommand([URL_OK, '--save-fixture', 'two-hops'], {
			client: { request },
			registry: createShopRegistry([adapter]),
			stdout: { write: () => undefined },
			stderr: { write: () => undefined },
			fixturesDirFor: () => fixturesDir
		});

		expect(code).toBe(0);
		expect(request).toHaveBeenCalledTimes(2);
		expect(readFileSync(join(fixturesDir, 'two-hops.html'), 'utf8')).toBe(PAGE);
	});

	it('output labels', async () => {
		const noImage = setup(okResult);
		expect(await noImage.run([URL_OK])).toBe(0);
		expect(noImage.stdout()).toBe(
			[
				'shop:  test-shop',
				'id:    B0TEST0001',
				`url:   ${URL_OK}`,
				'title: Big Telly',
				'price: £1,299.99',
				'image: -',
				''
			].join('\n')
		);

		const image = 'https://m.media-amazon.com/images/I/81x.jpg';
		const withImage = setup({ ...okResult, imageUrl: image });
		expect(await withImage.run([URL_OK])).toBe(0);
		expect(withImage.stdout()).toContain(`\nimage: ${image}\n`);
	});

	it('args', async () => {
		expect(USAGE).toBe('usage: pnpm adapter:check <url> [--save-fixture <name> [--force]]');
		const cases: [string[], string][] = [
			[[], 'missing URL'],
			[['--bogus', URL_OK], 'unknown option --bogus'],
			[['-x', URL_OK], 'unknown option -x'],
			[[URL_OK, '--save-fixture'], '--save-fixture needs a name'],
			[[URL_OK, '--save-fixture', '--force'], '--save-fixture needs a name'],
			[[URL_OK, URL_OK], 'only one URL can be checked at a time'],
			[[URL_OK, '--force'], '--force only applies with --save-fixture']
		];
		for (const [argv, message] of cases) {
			const { run, request, stderr } = setup(okResult);
			expect(await run(argv), argv.join(' ')).toBe(2);
			expect(stderr(), argv.join(' ')).toBe(`adapter:check: ${message}\n${USAGE}\n`);
			expect(request).toHaveBeenCalledTimes(0);
		}

		const badName = setup(okResult);
		expect(await badName.run([URL_OK, '--save-fixture', 'Foo Bar'])).toBe(2);
		expect(badName.stderr()).toBe(
			'adapter:check: fixture name must match [a-z0-9-]+, got "Foo Bar"\n'
		);
	});

	it('usage', async () => {
		for (const argv of [
			[],
			['--bogus', URL_OK],
			[URL_OK, '--save-fixture'],
			[URL_OK, '--save-fixture', '--force'],
			[URL_OK, URL_OK],
			[URL_OK, '--force']
		]) {
			const { run, request, stderr } = setup(okResult);
			expect(await run(argv), argv.join(' ')).toBe(2);
			expect(stderr()).toContain(USAGE);
			expect(request).toHaveBeenCalledTimes(0);
		}
	});

	it('spawn', () => {
		const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
		const cli = join(repoRoot, 'src/lib/server/cli/adapter-check.ts');
		expect(existsSync(cli)).toBe(true);
		const env = { ...process.env, SHOP_MIN_GAP_MS: '1', SHOP_TIMEOUT_MS: '1000' };

		// .invalid can never resolve, and the URL is rejected before any request (r-01).
		const unsupported = spawnSync(process.execPath, [cli, 'https://shop.invalid/dp/B000000000'], {
			cwd: repoRoot,
			encoding: 'utf8',
			env,
			timeout: 30000
		});
		expect(unsupported.stderr).toContain('unsupported URL');
		expect(unsupported.status).toBe(1);

		const noArgs = spawnSync(process.execPath, [cli], {
			cwd: repoRoot,
			encoding: 'utf8',
			env,
			timeout: 30000
		});
		expect(noArgs.stderr).toContain(USAGE);
		expect(noArgs.status).toBe(2);
	});
});
