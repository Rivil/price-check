// Pins spec c-7: the container/server deployment artefacts are gone and nothing
// tracked still points at them.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root as git sees it; falls back to this spec's parent (Stryker sandbox). */
function repoRoot(): string {
	try {
		return execFileSync('git', ['rev-parse', '--show-toplevel'], {
			cwd: here,
			encoding: 'utf8'
		}).trim();
	} catch {
		return join(here, '..');
	}
}

const root = repoRoot();

/** Tracked files via git; a plain walk when git lists nothing (gitignored sandbox). */
function trackedFiles(): string[] {
	let files: string[];
	try {
		files = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
			.split('\n')
			.filter(Boolean);
	} catch {
		files = [];
	}
	if (files.length) return files;
	const skip = new Set(['.git', 'node_modules', '.svelte-kit', 'build', '.stryker-tmp', 'reports']);
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			if (skip.has(name)) return [];
			const path = join(dir, name);
			return statSync(path).isDirectory()
				? walk(path)
				: [relative(root, path).split(sep).join('/')];
		});
	return walk(root);
}

// Built from fragments so this file never matches its own scan.
const REMOVED = [
	['Docker', 'file'],
	['com', 'pose.yaml'],
	['.docker', 'ignore'],
	['scripts/image', '-smoke.sh']
].map((p) => p.join(''));
const FORBIDDEN = [
	['Docker', 'file'],
	['com', 'pose.yaml'],
	['.docker', 'ignore'],
	['image', '-smoke'],
	['docker', ' compose']
].map((p) => p.join(''));
const EXEMPT = [
	/^\.dross\//,
	/^pnpm-lock\.yaml$/,
	/^src\/lib\/server\/shops\/.*\/fixtures\//,
	/^scripts\/repo-hygiene\.spec\.ts$/,
	/^scripts\/readme\.spec\.ts$/
];

describe('repo hygiene', () => {
	it('docker files removed', () => {
		for (const path of REMOVED) expect(existsSync(join(root, path)), path).toBe(false);
	});

	it('scans the tree: the file list is not empty', () => {
		const files = trackedFiles();
		expect(files.length).toBeGreaterThan(50);
		expect(files).toContain('package.json');
	});

	it('no references to the removed artefacts in any tracked file', () => {
		const hits: string[] = [];
		for (const file of trackedFiles()) {
			if (EXEMPT.some((re) => re.test(file))) continue;
			const path = join(root, file);
			if (!existsSync(path)) continue;
			const lines = readFileSync(path, 'utf8').split('\n');
			lines.forEach((line, i) => {
				const lower = line.toLowerCase();
				for (const word of FORBIDDEN)
					if (lower.includes(word.toLowerCase())) hits.push(`${file}:${i + 1}: ${word}`);
			});
		}
		expect(hits).toEqual([]);
	});
});
