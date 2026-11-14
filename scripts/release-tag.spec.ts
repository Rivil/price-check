// Pins release.yml's tag gate (spec c-4): only refs/tags/v<package.json version>
// [-rc.N] on a commit reachable from origin/main may publish, and the CLI writes
// $GITHUB_OUTPUT only on success, so a refused or errored check leaves nothing a
// later job could read. isOnMain and the CLI run against a throwaway git repo.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkReleaseTag, isOnMain, runCli } from './release-tag.ts';

const SCRIPT = fileURLToPath(new URL('./release-tag.ts', import.meta.url));

describe('checkReleaseTag', () => {
	it('accepts a final tag on main matching package.json', () => {
		expect(
			checkReleaseTag({ ref: 'refs/tags/v0.1.5', packageVersion: '0.1.5', onMain: true })
		).toEqual({ ok: true, version: '0.1.5', prerelease: false });
	});

	it('accepts an rc tag as a prerelease with its full version', () => {
		expect(
			checkReleaseTag({ ref: 'refs/tags/v0.1.5-rc.2', packageVersion: '0.1.5', onMain: true })
		).toEqual({ ok: true, version: '0.1.5-rc.2', prerelease: true });
	});

	it.each([
		['v0.1.6 vs package 0.1.5', 'refs/tags/v0.1.6', true],
		['a tag off main', 'refs/tags/v0.1.5', false],
		['an empty ref', '', true],
		['an empty tag name', 'refs/tags/', true],
		['a bare v', 'refs/tags/v', true],
		['a beta suffix', 'refs/tags/v0.1.5-beta.1', true],
		['an rc without a number', 'refs/tags/v0.1.5-rc', true],
		['rc.0', 'refs/tags/v0.1.5-rc.0', true],
		['rc.01', 'refs/tags/v0.1.5-rc.01', true],
		['a fourth part', 'refs/tags/v0.1.5.0', true],
		['build metadata', 'refs/tags/v0.1.5+b1', true],
		['a trailing newline', 'refs/tags/v0.1.5\n', true],
		['a leading zero', 'refs/tags/v01.1.5', true],
		['no v', 'refs/tags/0.1.5', true],
		['a branch named like a tag', 'refs/heads/v0.1.5', true],
		['a short tag name', 'v0.1.5', true]
	])('refuses %s', (_case, ref, onMain) => {
		const result = checkReleaseTag({ ref, packageVersion: '0.1.5', onMain });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).not.toBe('');
	});

	it('a version mismatch names both versions', () => {
		const result = checkReleaseTag({
			ref: 'refs/tags/v0.2.0-rc.1',
			packageVersion: '0.1.5',
			onMain: true
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('0.2.0');
			expect(result.reason).toContain('0.1.5');
		}
	});
});

// A throwaway repo: main = A <- B, side = A <- C, origin/main -> B.
type Fixture = { dir: string; a: string; b: string; c: string };

function git(dir: string, args: string[], input?: string): string {
	const run = spawnSync('git', args, {
		cwd: dir,
		input,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
		}
	});
	if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
	return run.stdout.trim();
}

function makeFixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), 'release-tag-'));
	git(dir, ['init', '--quiet']);
	const tree = git(dir, ['mktree'], '');
	// commit-tree runs no hooks; --no-gpg-sign overrides a global commit.gpgSign.
	const commit = (message: string, parent?: string) =>
		git(dir, [
			'commit-tree',
			'--no-gpg-sign',
			tree,
			...(parent ? ['-p', parent] : []),
			'-m',
			message
		]);
	const a = commit('A');
	const b = commit('B', a);
	const c = commit('C', a);
	git(dir, ['update-ref', 'refs/remotes/origin/main', b]);
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.5' }));
	return { dir, a, b, c };
}

describe('isOnMain', () => {
	let fx: Fixture;
	beforeAll(() => {
		fx = makeFixture();
	});
	afterAll(() => rmSync(fx.dir, { recursive: true, force: true }));

	it('is true for origin/main and an older commit on it', () => {
		expect(isOnMain(fx.b, fx.dir)).toBe(true);
		expect(isOnMain(fx.a, fx.dir)).toBe(true);
	});

	it('is false for a commit only on a side branch', () => {
		expect(isOnMain(fx.c, fx.dir)).toBe(false);
	});

	it('throws on an unknown commit or a non-id', () => {
		expect(() => isOnMain('f'.repeat(40), fx.dir)).toThrow(/exited/);
		expect(() => isOnMain('--help', fx.dir)).toThrow(/not a full commit id/);
		expect(() => isOnMain('origin/main', fx.dir)).toThrow(/not a full commit id/);
	});
});

describe('CLI', () => {
	let fx: Fixture;
	let output: string;
	beforeAll(() => {
		fx = makeFixture();
		output = join(fx.dir, 'github-output');
	});
	afterAll(() => rmSync(fx.dir, { recursive: true, force: true }));

	const cli = (env: Record<string, string>) => {
		writeFileSync(output, '');
		const lines: string[] = [];
		const code = runCli({
			env: { GITHUB_OUTPUT: output, ...env },
			root: fx.dir,
			stdout: (line) => lines.push(line),
			stderr: (line) => lines.push(line)
		});
		return { code, written: readFileSync(output, 'utf8'), lines };
	};

	it('writes version and prerelease for an accepted tag', () => {
		expect(cli({ GITHUB_REF: 'refs/tags/v0.1.5', GITHUB_SHA: fx.a })).toMatchObject({
			code: 0,
			written: 'version=0.1.5\nprerelease=false\n'
		});
		expect(cli({ GITHUB_REF: 'refs/tags/v0.1.5-rc.1', GITHUB_SHA: fx.b })).toMatchObject({
			code: 0,
			written: 'version=0.1.5-rc.1\nprerelease=true\n'
		});
	});

	it.each<[string, { GITHUB_REF?: string; GITHUB_SHA?: 'b' | 'c' | 'unknown' }]>([
		['a version mismatch', { GITHUB_REF: 'refs/tags/v0.1.6', GITHUB_SHA: 'b' }],
		['a malformed tag', { GITHUB_REF: 'refs/tags/v0.1.5-beta.1', GITHUB_SHA: 'b' }],
		['a commit off main', { GITHUB_REF: 'refs/tags/v0.1.5', GITHUB_SHA: 'c' }],
		['a failed ancestor check', { GITHUB_REF: 'refs/tags/v0.1.5', GITHUB_SHA: 'unknown' }],
		['a missing GITHUB_REF', { GITHUB_SHA: 'b' }],
		['a missing GITHUB_SHA', { GITHUB_REF: 'refs/tags/v0.1.5' }]
	])('exits 1 and writes nothing for %s', (_case, env) => {
		const shas = { b: fx.b, c: fx.c, unknown: 'f'.repeat(40) };
		const result = cli({
			...(env.GITHUB_REF === undefined ? {} : { GITHUB_REF: env.GITHUB_REF }),
			...(env.GITHUB_SHA === undefined ? {} : { GITHUB_SHA: shas[env.GITHUB_SHA] })
		});
		expect(result.code).toBe(1);
		expect(result.written).toBe('');
		expect(result.lines.join('\n')).toMatch(/^release-tag: ./);
	});

	it('exits 1 without GITHUB_OUTPUT', () => {
		const code = runCli({
			env: { GITHUB_REF: 'refs/tags/v0.1.5', GITHUB_SHA: fx.b },
			root: fx.dir,
			stdout: () => {},
			stderr: () => {}
		});
		expect(code).toBe(1);
	});

	it('as a process: exit codes and output follow the check', () => {
		const run = (ref: string, sha: string) => {
			writeFileSync(output, '');
			const proc = spawnSync(process.execPath, [SCRIPT], {
				cwd: fx.dir,
				encoding: 'utf8',
				env: { ...process.env, GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_OUTPUT: output }
			});
			return { status: proc.status, written: readFileSync(output, 'utf8') };
		};
		expect(run('refs/tags/v0.1.5', fx.b)).toEqual({
			status: 0,
			written: 'version=0.1.5\nprerelease=false\n'
		});
		expect(run('refs/tags/v0.1.5', fx.c)).toEqual({ status: 1, written: '' });
		expect(run('refs/heads/v0.1.5', fx.b)).toEqual({ status: 1, written: '' });
	});
});

describe('release-tag.ts', () => {
	it('imports only Node built-ins', () => {
		const source = readFileSync(SCRIPT, 'utf8');
		const specifiers = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
		expect(specifiers.length).toBeGreaterThan(0);
		for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
		expect(source).not.toMatch(/\bimport\s*\(/);
		expect(source).not.toMatch(/\brequire\s*\(/);
	});
});
