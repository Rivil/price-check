// Pins spec c-1's toolchain: the Electron binary is installed by `pnpm install`, the
// build-script allowlist and the pins stay exact, the main bundle keeps `electron`
// external, inlines #lib/* and refuses server-only imports, and the desktop e2e
// suite has its own Playwright config that the web suite never collects.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import webConfig from '../playwright.config.ts';
import desktopConfig from '../playwright.desktop.config.ts';
import {
	buildDesktop,
	DEFAULT_ENTRY,
	desktopBuildOptions,
	OUTFILE,
	ROOT
} from './build-desktop.ts';

type PackageJson = {
	main?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	pnpm?: Record<string, unknown>;
};

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson;

function unquote(value: string): string {
	const v = value.trim();
	if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
	return v;
}

/**
 * A top-level YAML sequence, block (`- x`) or flow (`[x, y]`) style. Null when the
 * key is missing, so a deleted allowlist fails rather than reading as empty.
 */
function yamlList(text: string, key: string): string[] | null {
	const lines = text.split(/\r?\n/);
	const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
	if (at < 0) return null;
	const inline = lines[at]
		.slice(lines[at].indexOf(':') + 1)
		.replace(/\s+#.*$/, '')
		.trim();
	if (inline) {
		const flow = /^\[(.*)\]$/.exec(inline);
		return flow ? flow[1].split(',').map(unquote).filter(Boolean) : [unquote(inline)];
	}
	const items: string[] = [];
	for (const line of lines.slice(at + 1)) {
		if (line.trim() === '' || line.trim().startsWith('#')) continue;
		const item = /^\s+-\s*(.*?)\s*(#.*)?$/.exec(line);
		if (!item) break;
		items.push(unquote(item[1]));
	}
	return items;
}

/** Bundles inline source as if it were a file at the repo root; nothing is written. */
async function bundle(contents: string): Promise<string> {
	const result = await buildDesktop({
		stdin: { contents, resolveDir: ROOT, sourcefile: 'fixture.ts', loader: 'ts' },
		write: false
	});
	const files = result.outputFiles ?? [];
	expect(files).toHaveLength(1);
	return files[0].text;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('electron toolchain', () => {
	it('allows install scripts for exactly electron and esbuild', () => {
		const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
		expect(yamlList(workspace, 'onlyBuiltDependencies')).toEqual(['electron', 'esbuild']);
		expect(workspace).not.toMatch(/dangerouslyAllowAllBuilds\s*:\s*true/);
		expect(workspace).not.toMatch(/onlyBuiltDependenciesFile/);
		expect(pkg.pnpm?.onlyBuiltDependencies).toBeUndefined();
	});

	it('pins electron and esbuild to an exact x.y.z as devDependencies', () => {
		for (const name of ['electron', 'esbuild']) {
			expect(pkg.devDependencies?.[name], name).toMatch(/^\d+\.\d+\.\d+$/);
			expect(pkg.dependencies?.[name], name).toBeUndefined();
		}
	});

	it('fetches the electron binary on install', () => {
		// Electron 45 ships no postinstall of its own: without this, a fresh install has
		// no binary until something first requires 'electron' and downloads it then.
		expect(pkg.scripts?.postinstall).toBe('install-electron');
	});

	it('electron binary installed', () => {
		// The path index.js exports, computed without requiring it: a require would
		// download a missing binary on the spot and hide the gap.
		const dir = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
		const pathTxt = join(dir, 'path.txt');
		expect(existsSync(pathTxt), pathTxt).toBe(true);
		const binary = join(dir, 'dist', readFileSync(pathTxt, 'utf8'));
		expect(existsSync(binary), binary).toBe(true);
		const version = readFileSync(join(dir, 'dist', 'version'), 'utf8')
			.trim()
			.replace(/^v/, '');
		expect(version).toBe(pkg.devDependencies?.electron);
	});
});

describe('desktop bundle', () => {
	it('builds the default entry to package.json main', () => {
		const options = desktopBuildOptions();
		expect(DEFAULT_ENTRY).toBe('src/desktop/main.ts');
		expect(OUTFILE).toBe('dist-desktop/main.js');
		expect(options.absWorkingDir).toBe(ROOT);
		expect(options.entryPoints).toEqual([DEFAULT_ENTRY]);
		expect(options.outfile).toBe(OUTFILE);
		expect(pkg.main).toBe(OUTFILE);
		expect(resolve(ROOT, pkg.main ?? '')).toBe(resolve(ROOT, options.outfile ?? ''));
		expect(options).toMatchObject({ bundle: true, format: 'esm', platform: 'node' });
		expect(pkg.scripts?.['build:desktop']).toBe('node scripts/build-desktop.ts');
	});

	it('keeps electron external and inlines #lib/*', async () => {
		const out = await bundle(
			[
				"import { app } from 'electron';",
				"import { isLoopbackHost } from '#lib/server/local-request.ts';",
				"console.log(app, isLoopbackHost('localhost'));"
			].join('\n')
		);
		expect(out).toMatch(/^import\s*\{[^}]*\bapp\b[^}]*\}\s*from\s*"electron";?$/m);
		// node_modules/electron/index.js, had it been inlined.
		expect(out).not.toContain('path.txt');
		expect(out).not.toContain('Downloading Electron binary');
		expect(out).not.toContain('#lib/');
		expect(out).toContain('function isLoopbackHost(');
		expect(out).not.toContain(ROOT);
		expect(out).not.toContain(ROOT.split('\\').join('/'));
	});

	it.each([
		['$app/env', '$app/env'],
		['$app/env/private', '$app/env/private'],
		['@libsql/client', '@libsql/client'],
		['drizzle-orm/libsql', 'drizzle-orm/libsql'],
		['drizzle-orm/libsql/migrator', 'drizzle-orm/libsql/migrator'],
		// Reached through a #lib/* module, not the entry itself.
		['#lib/server/db/client.ts', '@libsql/client'],
		['#lib/server/db/index.ts', '$app/env']
	])('refuses %s, naming %s', async (imported, named) => {
		const failure = await bundle(`import * as m from '${imported}';\nconsole.log(m);`).then(
			() => null,
			(err: unknown) => err as { errors?: { text: string }[] }
		);
		expect(failure, 'the build succeeded').not.toBeNull();
		// The thrown message lists only the first few errors; the array has them all.
		expect(failure?.errors?.map((e) => e.text)).toContainEqual(
			expect.stringMatching(
				new RegExp(`^'${escape(named)}' is not allowed in the desktop main bundle`)
			)
		);
	});

	it('leaves other packages as bare imports', async () => {
		// The refusal is libsql's driver, not drizzle as a whole.
		const out = await bundle("import { sql } from 'drizzle-orm';\nconsole.log(sql);");
		expect(out).toMatch(/^import\s*\{\s*sql\s*\}\s*from\s*"drizzle-orm";?$/m);
	});

	it('real entry', async () => {
		const result = await buildDesktop({ entry: DEFAULT_ENTRY, write: false });
		const files = result.outputFiles ?? [];
		expect(files).toHaveLength(1);
		const out = files[0].text;
		expect(out).toMatch(/^import\s*\{[^}]*\bapp\b[^}]*\}\s*from\s*"electron";?$/m);
		expect(out).not.toContain('#lib/');
		expect(out).not.toContain('$app/');
		// The handler is named once, as the URL main hands to loadAdapterHandler's
		// dynamic import. A static import would run its env reads before main sets env.
		expect(out).toContain('"../build/handler.js"');
		const handlerSpecifier = /["'][^"'\n]*build\/handler\.js["']/.source;
		expect(out).not.toMatch(new RegExp(`^\\s*(import|export)\\b[^;]*?${handlerSpecifier}`, 'm'));
		expect(out).not.toMatch(new RegExp(`\\bimport\\s*\\(\\s*${handlerSpecifier}`));
		expect(out).toMatch(/\bimport\(\s*(\/\*[^*]*\*\/\s*)?moduleUrl\s*\)/);
	});

	it('is gitignored at /dist-desktop', () => {
		const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8')
			.split(/\r?\n/)
			.map((l) => l.trim());
		const at = lines.findIndex((l) => l === '/dist-desktop' || l === '/dist-desktop/');
		expect(at).toBeGreaterThanOrEqual(0);
		expect(lines.slice(at + 1).filter((l) => /^!\/?dist-desktop/.test(l))).toEqual([]);
	});
});

type FileMatcher = (file: string) => boolean;
// Playwright's own matcher (lib/util is an exported entry), so the check below
// collects exactly as `playwright test` would, not as a hand-rolled glob guesses.
const { createFileMatcher } = createRequire(import.meta.url)('playwright/lib/util') as {
	createFileMatcher(patterns: string | RegExp | (string | RegExp)[]): FileMatcher;
};
/** Playwright's default testMatch. */
const DEFAULT_TEST_MATCH = '**/*.@(spec|test).?(c|m)[jt]s?(x)';

/** Whether `playwright test --config <config>` would collect `file` (repo-relative). */
function collects(config: PlaywrightTestConfig, file: string): boolean {
	const abs = join(ROOT, file);
	const testDir = resolve(ROOT, config.testDir ?? '.');
	const rel = relative(testDir, abs);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
	const match = createFileMatcher(config.testMatch ?? DEFAULT_TEST_MATCH);
	const ignore = createFileMatcher(config.testIgnore ?? []);
	return match(abs) && !ignore(abs);
}

describe('playwright config split', () => {
	const desktopSpecs = readdirSync(join(ROOT, 'e2e', 'desktop'))
		.filter((name) => name.endsWith('.e2e.ts'))
		.map((name) => `e2e/desktop/${name}`);

	it('the default config never collects e2e/desktop', () => {
		expect(desktopSpecs).toContain('e2e/desktop/harness.e2e.ts');
		for (const file of [...desktopSpecs, 'e2e/desktop/nested/later.e2e.ts']) {
			expect(collects(webConfig, file), file).toBe(false);
		}
		// Control: the web suite is still collected.
		for (const file of ['e2e/harness.e2e.ts', 'e2e/a11y.e2e.ts']) {
			expect(collects(webConfig, file), file).toBe(true);
		}
	});

	it('the desktop config runs serially with no web server', () => {
		expect(desktopConfig.webServer).toBeUndefined();
		expect(desktopConfig.workers).toBe(1);
		expect(desktopConfig.retries ?? 0).toBe(0);
	});

	it('the desktop config collects only e2e/desktop', () => {
		expect(resolve(ROOT, desktopConfig.testDir ?? '.')).toBe(join(ROOT, 'e2e', 'desktop'));
		for (const file of desktopSpecs) expect(collects(desktopConfig, file), file).toBe(true);
		for (const file of [
			'e2e/harness.e2e.ts',
			'e2e/a11y.e2e.ts',
			'src/desktop/x.e2e.ts',
			'e2e/desktop/launch.ts'
		]) {
			expect(collects(desktopConfig, file), file).toBe(false);
		}
	});

	it('test:e2e:desktop builds both bundles, then runs the desktop config', () => {
		const steps = (pkg.scripts?.['test:e2e:desktop'] ?? '').split('&&').map((s) => s.trim());
		expect(steps).toEqual([
			'vite build',
			'node scripts/build-desktop.ts',
			'playwright test --config playwright.desktop.config.ts'
		]);
		expect(pkg.scripts?.['test:e2e']).toBe('playwright test');
	});
});
