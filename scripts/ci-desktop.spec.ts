// Pins how CI runs the desktop e2e suite (spec c-1 to c-9 run there on all three OSes):
// the test matrix keeps linux, macos and windows, each runs `pnpm test:e2e:desktop`,
// Linux runs it under xvfb with the AppArmor userns sysctl and never --no-sandbox,
// the Electron zip cache restores before `pnpm install` from inside the checkout, and
// failures upload the desktop results. SHA pins and permissions are `pnpm ci:policy`'s.
//
// No YAML library (same reason as scripts/workflow-policy.ts): a line reader that
// knows only the shape ci.yml uses, and throws when a job or step it needs is missing.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import desktopConfig from '../playwright.desktop.config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CI_PATH = join(ROOT, '.github/workflows/ci.yml');
const ci = readFileSync(CI_PATH, 'utf8');
const lines = ci.split(/\r?\n/);

const DESKTOP_RUN = 'pnpm test:e2e:desktop';
const SYSCTL = 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0';

function unquote(value: string): string {
	const v = value.trim();
	if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
	return v;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => line.trim().startsWith('#');

/** The body of `jobs.<id>`: every line up to the next job or top-level key. */
function job(id: string): string[] {
	const start = lines.indexOf(`  ${id}:`);
	if (start < 0) throw new Error(`ci.yml has no job '${id}'`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => l.trim() !== '' && !isComment(l) && indentOf(l) <= 2);
	return end < 0 ? rest : rest.slice(0, end);
}

/** A `key:` mapping directly under a job (env, strategy…), as its child lines. */
function block(body: string[], key: string, indent: number): string[] {
	const start = body.findIndex((l) => l === `${' '.repeat(indent)}${key}:`);
	if (start < 0) return [];
	const rest = body.slice(start + 1);
	const end = rest.findIndex((l) => l.trim() !== '' && !isComment(l) && indentOf(l) <= indent);
	return end < 0 ? rest : rest.slice(0, end);
}

/** A flat `KEY: value` map, e.g. a job's env. */
function map(blockLines: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const l of blockLines) {
		const m = /^\s+([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(l);
		if (m && !isComment(l)) out[m[1]] = unquote(m[2].replace(/\s+#.*$/, ''));
	}
	return out;
}

type Step = {
	index: number;
	lines: string[];
	get: (key: string) => string | undefined;
	run: string[];
};

/** The steps of a job, in order. `run` is the script's trimmed non-empty lines. */
function steps(body: string[]): Step[] {
	const list = block(body, 'steps', 4).filter((l) => !isComment(l));
	const starts = list.flatMap((l, i) => (/^ {6}- /.test(l) ? [i] : []));
	return starts.map((s, index) => {
		const stepLines = list.slice(s, starts[index + 1] ?? list.length);
		const get = (key: string) => {
			const m = stepLines
				.map((l) => new RegExp(`^ {6,}(?:- )?${key}:\\s*(.*?)\\s*$`).exec(l))
				.find(Boolean);
			return m ? unquote(m[1].replace(/\s+#.*$/, '')) : undefined;
		};
		const runAt = stepLines.findIndex((l) => /^ {6}(?:- | {2})run:/.test(l));
		let run: string[] = [];
		if (runAt >= 0) {
			const inline = stepLines[runAt].replace(/^.*?run:\s*/, '').trim();
			if (/^[|>]/.test(inline)) {
				const scalar = stepLines.slice(runAt + 1);
				const end = scalar.findIndex((l) => l.trim() !== '' && indentOf(l) <= 8);
				run = (end < 0 ? scalar : scalar.slice(0, end)).map((l) => l.trim()).filter(Boolean);
			} else run = [unquote(inline)];
		}
		return { index, lines: stepLines, get, run };
	});
}

const testJob = job('test');
const testSteps = steps(testJob);
const testEnv = map(block(testJob, 'env', 4));
const staticEnv = map(block(job('static'), 'env', 4));

const desktopSteps = testSteps.filter((s) => s.run.some((r) => r.includes(DESKTOP_RUN)));
const desktop = desktopSteps[0];

/**
 * The desktop step's script as its two OS branches. It must be exactly
 * `if [ "$RUNNER_OS" = "Linux" ]; then … else … fi`, so every OS takes one of them.
 */
function branches(run: string[]): { linux: string[]; other: string[] } | null {
	const elseAt = run.indexOf('else');
	const ok =
		run[0] === 'if [ "$RUNNER_OS" = "Linux" ]; then' &&
		elseAt > 0 &&
		run.at(-1) === 'fi' &&
		run.filter((l) => /^(if|else|elif|fi)\b/.test(l)).length === 3;
	return ok ? { linux: run.slice(1, elseAt), other: run.slice(elseAt + 1, -1) } : null;
}
const branch = branches(desktop?.run ?? []);
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
	const cacheDir = testEnv.electron_config_cache ?? '';
	const cacheSteps = testSteps.filter((s) => s.get('path')?.includes('electron_config_cache'));

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

describe('the static job', () => {
	it('sets ELECTRON_SKIP_BINARY_DOWNLOAD=1', () => {
		expect(staticEnv.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1');
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
