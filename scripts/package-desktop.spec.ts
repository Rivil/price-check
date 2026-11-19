// Pins spec 05's packaging config (c-1..c-5): one universal mac app, per-user NSIS,
// an x64 AppImage with the sandbox kept, libsql unpacked and never rebuilt, appId
// read from APP_ID, artefact names GitHub keeps as-is, and a CLI that only ever
// packages the host OS, never publishes, and refuses a --sign run that is missing a
// credential while naming only the missing variables.
//
// File patterns are matched the way electron-builder 26 does (app-builder-lib's
// util/filter.js and fileMatcher.js): minimatch with dot:true, patterns applied in
// order, a non-magic pattern without a dot also covers its subtree, and only the
// negations apply to node_modules.
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CliOptions, Configuration } from 'electron-builder';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_ID } from '../src/desktop/app-id.ts';
import {
	ARTIFACT_NAME,
	BUILD_RESOURCES,
	builderConfig,
	DEFAULT_OUT,
	fileSize,
	ICON_PNG,
	ICON_SIZE,
	ICON_SVG,
	missingSigningVariables,
	packageDesktop,
	parseCliArgs,
	PRODUCT_NAME,
	ROOT,
	runCli,
	setExitCode,
	SIGNING_VARIABLES,
	signingEnv,
	type BuilderConfigInput,
	type CliDeps
} from './package-desktop.ts';

type MinimatchClass = new (
	pattern: string,
	options?: { dot?: boolean; matchBase?: boolean }
) => {
	negate: boolean;
	set: unknown[][];
	match(path: string, partial?: boolean): boolean;
};

// minimatch as electron-builder's own app-builder-lib resolves it (pnpm keeps it
// out of the root node_modules).
const requireBuilder = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
const requireLib = createRequire(requireBuilder.resolve('app-builder-lib'));
const { Minimatch, minimatch } = requireLib('minimatch') as {
	Minimatch: MinimatchClass;
	minimatch: (path: string, pattern: string, options?: { matchBase?: boolean }) => boolean;
};

const asArray = <T>(v: T | T[] | null | undefined): T[] =>
	v == null ? [] : Array.isArray(v) ? v : [v];

function hasMagic(m: InstanceType<MinimatchClass>): boolean {
	return m.set.length > 1 || m.set[0].some((part) => typeof part !== 'string');
}

/** app-builder-lib FileMatcher.computeParsedPatterns + filter.js minimatchAll, for a file. */
function matchesAll(path: string, patterns: string[]): boolean {
	const parsed: InstanceType<MinimatchClass>[] = [];
	for (const pattern of patterns) {
		const m = new Minimatch(pattern, { dot: true });
		parsed.push(m);
		if (!pattern.includes('.') && !hasMagic(m))
			parsed.push(new Minimatch(`${pattern}/**/*`, { dot: true }));
	}
	let match = false;
	for (const m of parsed) {
		if (match !== m.negate) continue;
		match = m.match(path);
	}
	return match;
}

type PlatformKey = 'mac' | 'win' | 'linux';

function stringPatterns(v: Configuration['files']): string[] {
	return asArray(v).filter((p): p is string => typeof p === 'string');
}

/** A main-files matcher with electron-builder's implied defaults. */
function mainMatch(path: string, patterns: string[]): boolean {
	const main = patterns.some((p) => !p.startsWith('!')) ? patterns : ['**/*', ...patterns];
	return matchesAll(path, [...main, 'package.json']);
}

/**
 * Whether electron-builder would pack `path` into the app for this platform. A
 * top-level `files` list is normalised into a FileSet (util/config/config.js
 * normalizeFiles) that copies through a matcher of its own, next to the one built
 * from the platform's list (fileMatcher.js getFileMatchers): the two are a union.
 */
function packed(config: Configuration, platform: PlatformKey, path: string): boolean {
	const top = stringPatterns(config.files);
	const own = stringPatterns(config[platform]?.files);
	if (path.startsWith('node_modules/')) {
		return matchesAll(path, ['**/*', ...[...top, ...own].filter((p) => p.startsWith('!'))]);
	}
	const matchers = top.length > 0 && own.length > 0 ? [top, own] : [[...top, ...own]];
	return matchers.some((patterns) => mainMatch(path, patterns));
}

/** Whether the path ends up in app.asar.unpacked for this platform. */
function unpacked(config: Configuration, platform: PlatformKey, path: string): boolean {
	const patterns = [
		...asArray(config.asarUnpack as string | string[] | null | undefined),
		...asArray(config[platform]?.asarUnpack as string | string[] | null | undefined)
	];
	return packed(config, platform, path) && matchesAll(path, patterns);
}

const unsigned = (over: Partial<BuilderConfigInput> = {}) =>
	builderConfig({ version: '0.1.5', sign: false, ...over });
const signed = () => builderConfig({ version: '0.1.5', sign: true });

const LIBSQL_PLATFORM_PACKAGES = Object.keys(
	(
		JSON.parse(
			readFileSync(
				join(
					ROOT,
					'node_modules/.pnpm',
					readdirSync(join(ROOT, 'node_modules/.pnpm')).find((d) => /^libsql@/.test(d)) ??
						'missing',
					'node_modules/libsql/package.json'
				),
				'utf8'
			)
		) as { optionalDependencies: Record<string, string> }
	).optionalDependencies
);

describe('builderConfig: identity and targets', () => {
	it('takes appId from APP_ID and never spells the ID out itself', () => {
		expect(unsigned().appId).toBe(APP_ID);
		const source = readFileSync(join(ROOT, 'scripts/package-desktop.ts'), 'utf8');
		expect(source).not.toContain(APP_ID);
		expect(source).toMatch(/from '\.\.\/src\/desktop\/app-id\.ts'/);
	});

	it('gives every OS the price-tag icon, never the default Electron one', () => {
		const config = unsigned();
		expect(config.icon).toBe(ICON_PNG);
		expect(ICON_PNG).toBe(`${BUILD_RESOURCES}/icon.png`);
		for (const os of ['mac', 'win', 'linux'] as const) {
			expect(config[os] && 'icon' in config[os], os).toBe(false);
		}
		expect(config.nsis && 'installerIcon' in config.nsis).toBe(false);
	});

	it('ships a 1024px RGBA icon PNG rendered from the source SVG', () => {
		const png = readFileSync(join(ROOT, ICON_PNG));
		expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(png.toString('latin1', 12, 16)).toBe('IHDR');
		expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([ICON_SIZE, ICON_SIZE]);
		expect(ICON_SIZE).toBe(1024);
		expect([png[24], png[25]]).toEqual([8, 6]);
		const svg = readFileSync(join(ROOT, ICON_SVG), 'utf8');
		expect(svg).toMatch(/viewBox="0 0 1024 1024"/);
		expect(readFileSync(join(ROOT, 'src/lib/assets/favicon.svg'), 'utf8')).toBe(svg);
	});

	it('names the app in package.json, with an author but no email', () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
			description?: string;
			author?: unknown;
			scripts: Record<string, string>;
		};
		expect(pkg.description).toMatch(/^A desktop app that watches Amazon product prices/);
		expect(pkg.author).toBe('Rivil');
		expect(pkg.scripts['icon:render']).toBe('node scripts/render-icon.ts');
	});

	it('builds one universal mac app as dmg and zip', () => {
		const mac = unsigned().mac;
		expect(mac?.target).toEqual([
			{ target: 'dmg', arch: ['universal'] },
			{ target: 'zip', arch: ['universal'] }
		]);
		expect(JSON.stringify(mac?.target)).not.toMatch(/arm64|x64/);
	});

	it('lets exactly the two libsql darwin binaries skip lipo', () => {
		const pattern = unsigned().mac?.x64ArchFiles;
		expect(typeof pattern).toBe('string');
		const p = pattern as string;
		const universal = (path: string) => minimatch(path, p, { matchBase: true });
		const unpackedDir = 'Contents/Resources/app.asar.unpacked/node_modules/@libsql';
		expect(universal(`${unpackedDir}/darwin-x64/index.node`)).toBe(true);
		expect(universal(`${unpackedDir}/darwin-arm64/index.node`)).toBe(true);
		for (const framework of [
			'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
			'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib',
			'Contents/Frameworks/x/node_modules/@libsql/darwin-x64/index.node',
			'Contents/MacOS/Price Check'
		]) {
			expect(universal(framework), framework).toBe(false);
		}
	});

	it('builds a per-user one-click x64 NSIS installer', () => {
		const config = unsigned();
		expect(config.win?.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
		expect(config.nsis?.oneClick).toBe(true);
		expect(config.nsis?.perMachine).toBe(false);
	});

	it('builds only an x64 AppImage and keeps the Chromium sandbox', () => {
		const linux = unsigned().linux;
		expect(linux?.target).toEqual([{ target: 'AppImage', arch: ['x64'] }]);
		expect(asArray(linux?.executableArgs)).not.toContain('--no-sandbox');
		expect(JSON.stringify(unsigned())).not.toContain('no-sandbox');
	});
});

describe('builderConfig: what goes into the app', () => {
	const drizzle = [
		...readdirSync(join(ROOT, 'drizzle'))
			.filter((f) => f.endsWith('.sql'))
			.map((f) => `drizzle/${f}`),
		'drizzle/meta/_journal.json'
	];

	it('packs into asar, unpacks libsql and drizzle, and never rebuilds', () => {
		const config = unsigned();
		expect(config.asar).toBe(true);
		expect(config.npmRebuild).toBe(false);
		const patterns = asArray(config.asarUnpack as string[]);
		for (const path of [
			'node_modules/libsql/index.js',
			'node_modules/@libsql/linux-x64-gnu/index.node',
			'node_modules/@libsql/win32-x64-msvc/index.node',
			'node_modules/@libsql/darwin-x64/index.node',
			'node_modules/@libsql/darwin-arm64/index.node',
			'drizzle/0000_little_dreaming_celestial.sql',
			'drizzle/0011_drop_auth.sql',
			'drizzle/meta/_journal.json'
		]) {
			expect(matchesAll(path, patterns), path).toBe(true);
		}
		expect(drizzle).toContain('drizzle/0011_drop_auth.sql');
		for (const path of drizzle) expect(matchesAll(path, patterns), path).toBe(true);
		expect(matchesAll('dist-desktop/main.js', patterns)).toBe(false);
	});

	it('keeps buildResources off build/, which holds the adapter-node server', () => {
		const dir = unsigned().directories?.buildResources;
		expect(dir).toBeTruthy();
		expect(dir).not.toBe('build');
		for (const shipped of [
			'build/handler.js',
			'dist-desktop/main.js',
			'drizzle/meta/_journal.json'
		]) {
			expect(shipped.startsWith(`${dir}/`), shipped).toBe(false);
		}
	});

	it('writes to dist-packaged unless --out says otherwise', () => {
		expect(unsigned().directories?.output).toBe(DEFAULT_OUT);
		expect(DEFAULT_OUT).toBe('dist-packaged');
		expect(unsigned({ out: 'elsewhere' }).directories?.output).toBe('elsewhere');
	});

	it('lists the app files per OS only, leaving the top-level files unset', () => {
		const config = unsigned();
		expect(config.files).toBeUndefined();
		for (const platform of ['mac', 'win', 'linux'] as const) {
			expect(stringPatterns(config[platform]?.files).length, platform).toBeGreaterThan(0);
		}
	});

	it.each(['mac', 'win', 'linux'] as const)(
		'packs the app files and nothing else (%s)',
		(platform) => {
			const config = unsigned();
			for (const path of [
				'dist-desktop/main.js',
				'build/handler.js',
				'build/server/index.js',
				'src/desktop/assets/tray-iconTemplate.png',
				'drizzle/meta/_journal.json',
				'drizzle/0011_drop_auth.sql',
				'package.json',
				'node_modules/libsql/index.js',
				'node_modules/@libsql/client/package.json'
			]) {
				expect(packed(config, platform, path), path).toBe(true);
			}
			for (const path of [
				'local.db',
				'build/stray.db',
				'dist-desktop/local.db',
				'.env',
				'.env.local',
				'build/.env',
				'src/desktop/main.ts',
				'src/lib/index.ts',
				'src/lib/server/db/schema.ts',
				'e2e/desktop/launch.ts',
				'.dross/state.json',
				'.dross/phases/05-release/plan.toml',
				'scripts/package-desktop.ts',
				'test-results/x',
				'pnpm-lock.yaml',
				'dist-packaged/latest-mac.yml'
			]) {
				expect(packed(config, platform, path), path).toBe(false);
			}
		}
	);

	it('ships only the host OS libsql binaries it runs (every arch is installed)', () => {
		const config = unsigned();
		expect(LIBSQL_PLATFORM_PACKAGES).toEqual(
			expect.arrayContaining([
				'@libsql/darwin-x64',
				'@libsql/linux-arm64-gnu',
				'@libsql/linux-x64-musl'
			])
		);
		const ships: Record<PlatformKey, (pkg: string) => boolean> = {
			mac: (pkg) => /^@libsql\/darwin-/.test(pkg),
			win: (pkg) => pkg === '@libsql/win32-x64-msvc',
			linux: (pkg) => pkg === '@libsql/linux-x64-gnu'
		};
		for (const platform of ['mac', 'win', 'linux'] as const) {
			for (const pkg of LIBSQL_PLATFORM_PACKAGES) {
				const file = `node_modules/${pkg}/index.node`;
				const want = ships[platform](pkg);
				expect(packed(config, platform, file), `${platform} packs ${pkg}`).toBe(want);
				expect(unpacked(config, platform, file), `${platform} unpacks ${pkg}`).toBe(want);
			}
			expect(packed(config, platform, 'node_modules/@libsql/linux-arm64-gnu/libsql.node')).toBe(
				false
			);
		}
		expect(packed(config, 'mac', 'node_modules/@libsql/darwin-arm64/index.node')).toBe(true);
	});
});

describe('builderConfig: artefact names and update files', () => {
	const targets: Array<{
		key: string;
		platform: PlatformKey;
		ext: string;
		arch: string;
		fallback: string;
	}> = [
		{
			key: 'dmg',
			platform: 'mac',
			ext: 'dmg',
			arch: 'universal',
			fallback: '${productName}-${version}-${arch}.${ext}'
		},
		{
			key: 'zip',
			platform: 'mac',
			ext: 'zip',
			arch: 'universal',
			fallback: '${productName}-${version}-${arch}.${ext}'
		},
		{
			key: 'nsis',
			platform: 'win',
			ext: 'exe',
			arch: 'x64',
			fallback: '${productName} Setup ${version}.${ext}'
		},
		{
			key: 'appImage',
			platform: 'linux',
			ext: 'AppImage',
			arch: 'x86_64',
			fallback: '${productName}-${version}-${arch}.${ext}'
		}
	];
	const OS = { mac: 'mac', win: 'win', linux: 'linux' } as const;

	function expand(pattern: string, version: string, os: string, arch: string, ext: string): string {
		const values: Record<string, string> = {
			productName: PRODUCT_NAME,
			name: 'price-check-app',
			version,
			os,
			platform: os === 'mac' ? 'darwin' : os === 'win' ? 'win32' : 'linux',
			arch,
			ext
		};
		return pattern.replace(/\$\{([^}]+)\}/g, (_, macro: string) => {
			if (!(macro in values)) throw new Error(`unknown artifactName macro \${${macro}}`);
			return values[macro];
		});
	}

	it.each(['0.1.5', '0.1.5-rc.1'])(
		'expands every target to a name without whitespace (%s)',
		(version) => {
			const config = unsigned({ version }) as Record<string, unknown> & Configuration;
			const names = targets.map((t) => {
				const own = (config[t.key] as { artifactName?: string | null } | undefined)?.artifactName;
				const pattern =
					own || config[t.platform]?.artifactName || config.artifactName || t.fallback;
				return expand(pattern, version, OS[t.platform], t.arch, t.ext);
			});
			for (const name of names) expect(name).not.toMatch(/\s/);
			expect(new Set(names).size).toBe(names.length);
			expect(PRODUCT_NAME).toMatch(/\s/); // why the names must not use it
			expect(config.artifactName).toBe(ARTIFACT_NAME);
		}
	);

	it('never derives an update channel from an rc version', () => {
		expect(unsigned().detectUpdateChannel).toBe(false);
		expect(unsigned({ version: '0.1.5-rc.1' }).detectUpdateChannel).toBe(false);
	});

	it('publishes to GitHub Releases unless a loopback test feed is baked in', () => {
		expect(unsigned().publish).toEqual([
			{ provider: 'github', owner: 'Rivil', repo: 'price-check' }
		]);
		expect(signed().publish).toEqual([{ provider: 'github', owner: 'Rivil', repo: 'price-check' }]);
		const url = 'http://127.0.0.1:47811/';
		expect(unsigned({ feedUrl: url }).publish).toEqual([{ provider: 'generic', url }]);
		for (const bad of [
			'https://example.com/',
			'http://10.0.0.1/',
			'https://127.0.0.1:47811/',
			'http://localhost:47811/',
			'http://user:pw@127.0.0.1/',
			'http://127.0.0.1.example.com/',
			'not a url'
		]) {
			expect(() => unsigned({ feedUrl: bad }), bad).toThrow();
		}
		expect(() => builderConfig({ version: '0.1.5', sign: true, feedUrl: url })).toThrow();
	});

	it('takes an IPv6 loopback feed too', () => {
		const url = 'http://[::1]:47811/';
		expect(unsigned({ feedUrl: url }).publish).toEqual([{ provider: 'generic', url }]);
	});

	it('says why it refuses a feed URL', () => {
		expect(() =>
			builderConfig({ version: '0.1.5', sign: true, feedUrl: 'http://127.0.0.1/' })
		).toThrow('a signed build publishes to GitHub Releases only: drop --feed-url');
		expect(() => unsigned({ feedUrl: 'not a url' })).toThrow(
			"--feed-url is not a URL: 'not a url'"
		);
		expect(() => unsigned({ feedUrl: 'http://localhost/' })).toThrow(
			"--feed-url must be an http loopback URL (127.0.0.1 or [::1]), got 'http://localhost/'"
		);
	});

	it('stamps the given version and refuses anything else', () => {
		expect(unsigned({ version: '0.1.5' }).extraMetadata).toEqual({ version: '0.1.5' });
		expect(unsigned({ version: '0.1.5-rc.1' }).extraMetadata).toEqual({ version: '0.1.5-rc.1' });
		for (const bad of [
			'0.1',
			'v0.1.5',
			'0.1.5-rc',
			'latest',
			'',
			'0.1.5-beta.1',
			'01.1.5',
			'0.1.5 '
		]) {
			expect(() => unsigned({ version: bad }), JSON.stringify(bad)).toThrow();
		}
		expect(() => unsigned({ version: '0.1' })).toThrow(
			"version must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N, got '0.1'"
		);
	});

	// Nonzero and multi-digit parts: a VERSION that took only 0, one digit or two digits
	// per part would refuse a real release.
	it.each(['1.2.3', '10.20.30', '123.0.4567-rc.10'])('stamps %s', (version) => {
		expect(unsigned({ version }).extraMetadata).toEqual({ version });
	});
});

describe('builderConfig: signing', () => {
	it('never signs or notarises an unsigned build', () => {
		const mac = unsigned().mac;
		expect(mac?.identity).toBeNull();
		expect(mac?.notarize).toBe(false);
		expect(signingEnv(false)).toEqual({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
	});

	it('signs with hardened runtime and notarises a --sign build', () => {
		const mac = signed().mac;
		expect(mac?.notarize).toBe(true);
		expect(mac?.hardenedRuntime).toBe(true);
		expect(mac).not.toHaveProperty('identity');
		expect(signingEnv(true)).toEqual({ CSC_IDENTITY_AUTO_DISCOVERY: 'true' });
	});

	it('never configures Windows signing', () => {
		for (const config of [unsigned(), signed()]) {
			const keys = Object.keys(config.win ?? {});
			expect(keys.filter((k) => /^(certificate|signtool|azureSign|csc)/i.test(k))).toEqual([]);
		}
	});
});

const SENTINELS = Object.fromEntries(
	SIGNING_VARIABLES.map((name) => [name, `sentinel-${name.toLowerCase()}-9f2c71`])
) as Record<(typeof SIGNING_VARIABLES)[number], string>;

type Harness = CliDeps & {
	calls: Array<{ options: CliOptions; env: NodeJS.ProcessEnv }>;
	out: string[];
	err: string[];
};

function harness(over: Partial<CliDeps> = {}, files: Record<string, number> = {}): Harness {
	const calls: Harness['calls'] = [];
	const out: string[] = [];
	const err: string[] = [];
	const env: NodeJS.ProcessEnv = over.env ?? {};
	return {
		calls,
		out,
		err,
		platform: 'darwin',
		root: '/repo',
		env,
		exists: () => true,
		fileSize: (path) => (path in files ? files[path] : null),
		build: async (options) => {
			calls.push({ options, env: { ...env } });
			return ['/repo/dist-packaged/price-check-0.1.5-mac-universal.dmg'];
		},
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
		...over
	};
}

function signingEnvVars(): NodeJS.ProcessEnv {
	return { ...SENTINELS };
}
const KEY_FILES = { [SENTINELS.APPLE_API_KEY]: 1200 };

describe('package:desktop CLI', () => {
	afterEach(() => vi.restoreAllMocks());

	it('builds the host OS only, never publishing, with discovery off when unsigned', async () => {
		for (const [platform, key] of [
			['darwin', 'mac'],
			['win32', 'win'],
			['linux', 'linux']
		] as const) {
			const h = harness({ platform });
			expect(await runCli(['--version', '0.1.5'], h)).toBe(0);
			expect(h.calls).toHaveLength(1);
			const { options, env } = h.calls[0];
			expect(options.publish).toBe('never');
			expect(Object.keys(options).filter((k) => ['mac', 'win', 'linux'].includes(k))).toEqual([
				key
			]);
			// No target names: the config's own targets for that OS.
			expect(options[key]).toEqual([]);
			expect(options.projectDir).toBe('/repo');
			expect((options.config as Configuration).extraMetadata).toEqual({ version: '0.1.5' });
			expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
			expect(h.out).toEqual([
				'package:desktop: /repo/dist-packaged/price-check-0.1.5-mac-universal.dmg'
			]);
			expect(h.err).toEqual([]);
		}
	});

	it.each([['--win'], ['--mac'], ['--linux'], ['--publish', 'always'], ['-w'], ['extra']])(
		'refuses %s without building',
		async (...flag) => {
			const h = harness();
			expect(await runCli(['--version', '0.1.5', ...flag], h)).toBe(1);
			expect(h.calls).toEqual([]);
		}
	);

	it('refuses an unsupported host', async () => {
		const h = harness({ platform: 'freebsd' });
		expect(await runCli(['--version', '0.1.5'], h)).toBe(1);
		expect(h.calls).toEqual([]);
		expect(h.err).toEqual(['package:desktop: cannot package on freebsd']);
	});

	it('names every missing build input at once', async () => {
		const h = harness({ exists: () => false });
		expect(await runCli(['--version', '0.1.5'], h)).toBe(1);
		expect(h.calls).toEqual([]);
		expect(h.err).toEqual([
			'package:desktop: missing build/handler.js, dist-desktop/main.js: run pnpm build && pnpm build:desktop first'
		]);
	});

	it('refuses a run without --version, saying so', async () => {
		const h = harness();
		expect(await runCli(['--sign'], h)).toBe(1);
		expect(h.calls).toEqual([]);
		expect(h.err).toEqual(['package:desktop: --version <MAJOR.MINOR.PATCH[-rc.N]> is required']);
	});

	it.each(['build/handler.js', 'dist-desktop/main.js'])(
		'refuses when %s is missing',
		async (missing) => {
			const h = harness({ exists: (path) => path !== resolve('/repo', missing) });
			expect(await runCli(['--version', '0.1.5'], h)).toBe(1);
			expect(h.calls).toEqual([]);
			expect(h.err.join('\n')).toContain(missing);
		}
	);

	it('refuses a bad version or feed URL without building', async () => {
		for (const argv of [
			[],
			['--version', 'v0.1.5'],
			['--version', '0.1.5', '--feed-url', 'https://example.com/']
		]) {
			const h = harness();
			expect(await runCli(argv, h), argv.join(' ')).toBe(1);
			expect(h.calls).toEqual([]);
		}
	});

	it('passes --feed-url and --out through', async () => {
		const h = harness();
		const argv = [
			'--version',
			'0.1.5-rc.1',
			'--feed-url',
			'http://127.0.0.1:47811/',
			'--out',
			'pkg-a'
		];
		expect(await runCli(argv, h)).toBe(0);
		const config = h.calls[0].options.config as Configuration;
		expect(config.publish).toEqual([{ provider: 'generic', url: 'http://127.0.0.1:47811/' }]);
		expect(config.directories?.output).toBe('pkg-a');
		// Strict: an absent option leaves no undefined-valued key behind.
		expect(parseCliArgs(['--version', '0.1.5'])).toStrictEqual({ version: '0.1.5', sign: false });
		expect(parseCliArgs(argv)).toStrictEqual({
			version: '0.1.5-rc.1',
			sign: false,
			feedUrl: 'http://127.0.0.1:47811/',
			out: 'pkg-a'
		});
	});

	it('signs on macOS with every credential present', async () => {
		const h = harness({ env: signingEnvVars() }, KEY_FILES);
		expect(await runCli(['--version', '0.1.5', '--sign'], h)).toBe(0);
		expect(h.calls).toHaveLength(1);
		const config = h.calls[0].options.config as Configuration;
		expect(config.mac?.notarize).toBe(true);
		expect(h.calls[0].env.CSC_IDENTITY_AUTO_DISCOVERY).not.toBe('false');
	});

	const refusals: Array<[string, (env: NodeJS.ProcessEnv) => void, Record<string, number>]> = [
		...SIGNING_VARIABLES.map(
			(name): [string, (env: NodeJS.ProcessEnv) => void, Record<string, number>] => [
				`${name} missing`,
				(env) => delete env[name],
				KEY_FILES
			]
		),
		...SIGNING_VARIABLES.map(
			(name): [string, (env: NodeJS.ProcessEnv) => void, Record<string, number>] => [
				`${name} blank`,
				(env) => (env[name] = '  '),
				KEY_FILES
			]
		),
		['APPLE_API_KEY naming no file', () => {}, {}],
		['APPLE_API_KEY naming an empty file', () => {}, { [SENTINELS.APPLE_API_KEY]: 0 }]
	];

	it.each(refusals)(
		'refuses --sign with %s, naming it and printing no value',
		async (_, edit, files) => {
			const writes: string[] = [];
			vi.spyOn(process.stdout, 'write').mockImplementation(
				(chunk) => (writes.push(String(chunk)), true)
			);
			vi.spyOn(process.stderr, 'write').mockImplementation(
				(chunk) => (writes.push(String(chunk)), true)
			);
			vi.spyOn(console, 'log').mockImplementation((...a) => void writes.push(a.join(' ')));
			vi.spyOn(console, 'error').mockImplementation((...a) => void writes.push(a.join(' ')));
			const env = signingEnvVars();
			edit(env);
			const h = harness({ env }, files);
			const code = await runCli(['--version', '0.1.5', '--sign'], h);
			vi.restoreAllMocks();
			expect(code).toBe(1);
			expect(h.calls).toEqual([]);
			const printed = [...h.out, ...h.err, ...writes].join('\n');
			expect(printed).toMatch(
				/CSC_LINK|CSC_KEY_PASSWORD|APPLE_API_KEY|APPLE_API_KEY_ID|APPLE_API_ISSUER/
			);
			for (const value of Object.values(SENTINELS)) expect(printed).not.toContain(value);
		}
	);

	it('names only the missing signing variables', () => {
		const env = signingEnvVars();
		delete env.CSC_KEY_PASSWORD;
		env.APPLE_API_ISSUER = '';
		const missing = missingSigningVariables(env, (p) => KEY_FILES[p] ?? null);
		expect(missing).toEqual(['CSC_KEY_PASSWORD', 'APPLE_API_ISSUER']);
	});

	it('lists every missing signing variable in one refusal', async () => {
		const env = signingEnvVars();
		delete env.CSC_KEY_PASSWORD;
		env.APPLE_API_ISSUER = '';
		const h = harness({ env }, KEY_FILES);
		expect(await runCli(['--version', '0.1.5', '--sign'], h)).toBe(1);
		expect(h.calls).toEqual([]);
		expect(h.err).toEqual([
			'package:desktop: --sign needs CSC_KEY_PASSWORD, APPLE_API_ISSUER; nothing was built'
		]);
	});

	it('refuses --sign off macOS: Windows and Linux are never signed', async () => {
		for (const platform of ['win32', 'linux'] as const) {
			const h = harness({ platform, env: signingEnvVars() }, KEY_FILES);
			expect(await runCli(['--version', '0.1.5', '--sign'], h)).toBe(1);
			expect(h.calls).toEqual([]);
			expect(h.err).toEqual([
				'package:desktop: --sign is macOS-only: Windows and Linux are never signed'
			]);
		}
	});

	it('runs electron-builder in-process only through the injected build()', async () => {
		const h = harness();
		await packageDesktop({ version: '0.1.5', sign: false }, h);
		expect(h.calls).toHaveLength(1);
		const source = readFileSync(join(ROOT, 'scripts/package-desktop.ts'), 'utf8');
		expect(source).toMatch(/^import type \{[^}]*\} from 'electron-builder';$/m);
		expect(source).not.toMatch(/^import (?!type)[^\n]*from 'electron-builder'/m);
	});
});

type ExitProcess = Pick<NodeJS.Process, 'exitCode' | 'on'>;

function fakeProcess(): ExitProcess & { emit(event: 'exit'): boolean } {
	return Object.assign(new EventEmitter(), { exitCode: undefined }) as unknown as ExitProcess & {
		emit(event: 'exit'): boolean;
	};
}

/**
 * Runs a child node that starts electron-builder's temp dir the way a build does
 * (temp-file registers async-exit-hook, which calls process.exit(0) on beforeExit)
 * and then reports a failure with `report`. Returns the child's exit status.
 */
function exitStatusAfterTempDir(report: string): number | null {
	const script = [
		"import { createRequire } from 'node:module';",
		`const { TmpDir } = createRequire(${JSON.stringify(requireBuilder.resolve('app-builder-lib'))})('temp-file');`,
		`const { setExitCode } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/package-desktop.ts')).href)});`,
		"await new TmpDir('package-desktop-spec').getTempDir();",
		report
	].join('\n');
	const env = { ...process.env };
	delete env.TMP_DIR_MANAGER_ENSURE_REMOVED_ON_EXIT;
	const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		cwd: ROOT,
		env,
		encoding: 'utf8'
	});
	expect(child.stderr).not.toMatch(/Error/);
	return child.status;
}

describe('package:desktop exit code', () => {
	it('keeps a failure even after an exit hook calls process.exit(0)', () => {
		const proc = fakeProcess();
		setExitCode(1, proc);
		expect(proc.exitCode).toBe(1);
		proc.exitCode = 0;
		proc.emit('exit');
		expect(proc.exitCode).toBe(1);
	});

	it('never clears a failure something else reported', () => {
		for (const code of [0, 1]) {
			const proc = fakeProcess();
			setExitCode(code, proc);
			expect(proc.exitCode).toBe(code);
			proc.exitCode = 7;
			proc.emit('exit');
			expect(proc.exitCode).toBe(7);
		}
	});

	it('leaves a success alone: nothing listens for exit', () => {
		const proc = fakeProcess();
		setExitCode(0, proc);
		expect(proc.exitCode).toBe(0);
		expect((proc as unknown as EventEmitter).listenerCount('exit')).toBe(0);
	});

	it("survives electron-builder's temp-dir exit hook, which zeroes a plain exitCode", () => {
		// The hazard, so the fix below is proven against the real hook, not a stand-in:
		// this is how a failed notarisation exited 0.
		expect(exitStatusAfterTempDir('process.exitCode = 1;')).toBe(0);
		expect(exitStatusAfterTempDir('setExitCode(1);')).toBe(1);
		expect(exitStatusAfterTempDir('setExitCode(0);')).toBe(0);
	});

	it('sets the CLI exit code through setExitCode only', () => {
		const source = readFileSync(join(ROOT, 'scripts/package-desktop.ts'), 'utf8');
		const entry = source.slice(source.indexOf('if (isEntry) {'));
		expect(entry).toMatch(/const code = await runCli\(/);
		expect(entry).toMatch(/\n\tsetExitCode\(code\);\n\}/);
		expect(source).not.toMatch(/process\.exitCode\s*=(?!=)/);
	});
});

describe('fileSize', () => {
	it("is a regular file's byte size", () => {
		const path = join(ROOT, 'package.json');
		expect(fileSize(path)).toBe(statSync(path).size);
		expect(fileSize(path)).toBeGreaterThan(0);
	});

	it('is null for a directory or a missing path', () => {
		expect(fileSize(ROOT)).toBeNull();
		expect(fileSize(join(ROOT, 'no-such-file.p8'))).toBeNull();
	});
});

describe('repo wiring', () => {
	it('roots the project at the repo, not at scripts/', () => {
		expect(ROOT).toBe(fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, ''));
		expect(existsSync(join(ROOT, 'package.json'))).toBe(true);
		expect(existsSync(join(ROOT, 'scripts/package-desktop.ts'))).toBe(true);
	});

	it('ignores /dist-packaged and runs the CLI from package:desktop', () => {
		const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
		expect(ignore).toContain('/dist-packaged');
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts['package:desktop']).toBe('node scripts/package-desktop.ts');
	});
});
