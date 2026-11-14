// Pins how CI runs the desktop e2e suite (spec c-1 to c-9 run there on all three OSes):
// the test matrix keeps linux, macos and windows, each runs `pnpm test:e2e:desktop`,
// Linux runs it under xvfb with the AppArmor userns sysctl and never --no-sandbox,
// the Electron zip cache restores before `pnpm install` from inside the checkout (and
// is gitignored with the browser cache), the static job installs with --ignore-scripts,
// and failures upload the desktop results. SHA pins and permissions are `pnpm ci:policy`'s.
//
// The workflow is read by scripts/workflow-reader.ts (no YAML library).
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import desktopConfig from '../playwright.desktop.config.ts';
import { block, branches, map, readWorkflow, steps, type Step } from './workflow-reader.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CI_PATH = join(ROOT, '.github/workflows/ci.yml');
const ci = readFileSync(CI_PATH, 'utf8');

const DESKTOP_RUN = 'pnpm test:e2e:desktop';
const SYSCTL = 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0';

const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
	.split(/\r?\n/)
	.map((l) => l.trim());

// Read afresh before each test, never at collection: the reader's mutants then count
// as covered by the tests that use it (Stryker treats load-time coverage as static).
let testJob: string[];
let testSteps: Step[];
let testEnv: Record<string, string>;
let staticJob: string[];
let staticSteps: Step[];
let desktopSteps: Step[];
let desktop: Step;
let branch: ReturnType<typeof branches>;
let cacheDir: string;
let cacheSteps: Step[];
beforeEach(() => {
	const { job } = readWorkflow(ci, 'ci.yml');
	testJob = job('test');
	testSteps = steps(testJob);
	testEnv = map(block(testJob, 'env', 4));
	staticJob = job('static');
	staticSteps = steps(staticJob);
	desktopSteps = testSteps.filter((s) => s.run.some((r) => r.includes(DESKTOP_RUN)));
	desktop = desktopSteps[0];
	branch = branches(desktop?.run ?? []);
	cacheDir = testEnv.electron_config_cache ?? '';
	cacheSteps = testSteps.filter((s) => s.get('path')?.includes('electron_config_cache'));
});
const indexOfRun = (cmd: string) => testSteps.findIndex((s) => s.run.includes(cmd));

describe('ci.yml test matrix runs the desktop e2e on every OS', () => {
	it('keeps linux, macos and windows in the matrix', () => {
		const include = [
			...block(block(testJob, 'strategy', 4), 'matrix', 6)
				.join('\n')
				.matchAll(/- name: (\S+)\s*\n\s+os: (\S+)/g)
		].map((m) => [m[1], m[2]]);
		const os = Object.fromEntries(include);
		expect(Object.keys(os).sort()).toEqual(['linux', 'macos', 'windows']);
		expect(os.linux).toMatch(/^ubuntu-/);
		expect(os.macos).toMatch(/^macos-/);
		expect(os.windows).toMatch(/^windows-/);
		expect(testJob).toContain('    runs-on: ${{ matrix.os }}');
	});

	it('runs pnpm test:e2e:desktop on Linux and on every other OS, after the web e2e', () => {
		expect(desktopSteps).toHaveLength(1);
		// No step `if:`: the step runs on all three, and its script branches on the OS.
		expect(desktop.get('if')).toBeUndefined();
		expect(branch, desktop.run.join('\n')).not.toBeNull();
		const e2e = indexOfRun('pnpm test:e2e');
		expect(e2e).toBeGreaterThanOrEqual(0);
		expect(desktop.index).toBeGreaterThan(e2e);
		// A desktop failure must fail the job.
		expect(desktop.get('continue-on-error')).toBeUndefined();
	});

	it('runs Linux under xvfb-run -a, after the AppArmor userns sysctl', () => {
		const run = branch?.linux ?? [];
		const sysctl = run.indexOf(SYSCTL);
		const xvfb = run.indexOf(`xvfb-run -a ${DESKTOP_RUN}`);
		expect(sysctl).toBeGreaterThanOrEqual(0);
		expect(xvfb).toBeGreaterThan(sysctl);
		for (const line of run.filter((r) => r.includes(DESKTOP_RUN)))
			expect(line).toBe(`xvfb-run -a ${DESKTOP_RUN}`);
	});

	it('runs macOS and Windows without xvfb-run', () => {
		expect(branch?.other).toEqual([DESKTOP_RUN]);
	});

	it('uploads the desktop results with the other reports on failure', () => {
		const upload = testSteps.find((s) => s.get('uses')?.startsWith('actions/upload-artifact@'));
		expect(upload).toBeDefined();
		expect(upload?.get('if')).toBe('failure()');
		expect(upload!.index).toBeGreaterThan(desktop.index);
		const paths = upload!.lines
			.map((l) => /^ {12}(\S.*?)\/?\s*$/.exec(l)?.[1])
			.filter((p): p is string => !!p);
		const outputDir = desktopConfig.outputDir ?? '';
		expect(outputDir).not.toBe('');
		expect(
			paths.some((p) => outputDir === p || outputDir.startsWith(`${p}/`)),
			`${outputDir} under one of ${paths.join(', ')}`
		).toBe(true);
	});
});

describe('the Electron binary cache', () => {
	it('points electron_config_cache inside the checkout', () => {
		expect(cacheDir).toMatch(/^\$\{\{ github\.workspace \}\}\/[A-Za-z0-9._-]+$/);
		expect(cacheDir).not.toContain('..');
	});

	it('is the variable the installed Electron downloads into', () => {
		const install = readFileSync(
			createRequire(import.meta.url).resolve('electron/install.js'),
			'utf8'
		);
		expect(install).toContain('cacheRoot: process.env.electron_config_cache');
	});

	it('restores before pnpm install, keyed on the lockfile', () => {
		expect(cacheSteps).toHaveLength(1);
		const [cache] = cacheSteps;
		expect(cache.get('uses')).toMatch(/^actions\/cache@[0-9a-f]{40}$/);
		expect(cache.get('path')).toBe('${{ env.electron_config_cache }}');
		expect(cache.get('key')).toContain("hashFiles('pnpm-lock.yaml')");
		expect(cache.get('key')).toContain('${{ runner.os }}');
		const install = indexOfRun('pnpm install --frozen-lockfile');
		expect(install).toBeGreaterThanOrEqual(0);
		expect(cache.index).toBeLessThan(install);
	});
});

describe('the desktop e2e test process never opens a userData DB', () => {
	// On Windows a libsql handle left in the Playwright worker locks the DB file, so
	// removing the temp userData fails with EPERM. seed-child.ts runs as its own process.
	const files = readdirSync(join(ROOT, 'e2e/desktop'), { recursive: true, encoding: 'utf8' })
		.filter((f) => f.endsWith('.ts'))
		.map((f) => join('e2e/desktop', f));

	it.each(files.filter((f) => !f.endsWith('seed-child.ts')))('%s', (file) => {
		const code = readFileSync(join(ROOT, file), 'utf8');
		expect(code).not.toMatch(
			/\bcreateDb\b|\/db\/client(\.ts)?['"]|@libsql\/client|drizzle-orm\/libsql/
		);
	});

	it('leaves the DB to seed-child.ts', () => {
		const child = readFileSync(join(ROOT, 'e2e/desktop/seed-child.ts'), 'utf8');
		expect(child).toContain('createDb(');
		expect(child).toContain('db.$client.close()');
	});
});

describe('the CI caches inside the checkout are gitignored', () => {
	it.each(['electron_config_cache', 'PLAYWRIGHT_BROWSERS_PATH'])('%s', (name) => {
		const dir = /^\$\{\{ github\.workspace \}\}\/([A-Za-z0-9._-]+)$/.exec(testEnv[name] ?? '')?.[1];
		expect(dir, `${name}: ${testEnv[name]}`).toBeDefined();
		expect(gitignore).toContain(`/${dir}/`);
	});
});

describe('the static job', () => {
	it('installs with --ignore-scripts', () => {
		const installs = staticSteps.flatMap((s) => s.run.filter((r) => r.startsWith('pnpm install')));
		expect(installs).toEqual(['pnpm install --frozen-lockfile --ignore-scripts']);
	});

	it('no longer sets the ELECTRON_SKIP_BINARY_DOWNLOAD the installer ignores', () => {
		expect(ci).not.toContain('ELECTRON_SKIP_BINARY_DOWNLOAD');
		expect(block(staticJob, 'env', 4)).toEqual([]);
	});
});

describe('no --no-sandbox anywhere the desktop app runs', () => {
	/** Every .ts file under a directory, recursively. */
	function tsFiles(dir: string): string[] {
		return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
			.filter((f) => f.endsWith('.ts'))
			.map((f) => join(dir, f));
	}
	const sources = [...tsFiles('src/desktop'), ...tsFiles('e2e/desktop')];

	it('has desktop sources to check', () => {
		expect(sources.length).toBeGreaterThan(0);
	});

	it('ci.yml never passes it', () => {
		expect(ci).not.toContain('--no-sandbox');
	});

	it.each(sources)('%s never passes it outside a comment', (file) => {
		const code = readFileSync(join(ROOT, file), 'utf8')
			.split(/\r?\n/)
			.filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
		expect(code.filter((l) => l.includes('--no-sandbox'))).toEqual([]);
	});

	it('keeps chromiumSandbox on, or Playwright adds --no-sandbox on Linux itself', () => {
		expect(readFileSync(join(ROOT, 'e2e/desktop/launch.ts'), 'utf8')).toMatch(
			/^\s*chromiumSandbox: true,?$/m
		);
	});
});
