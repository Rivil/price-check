// node scripts/release-tag.ts   (release.yml's first job, from the repo root)
//
// Decides whether a pushed tag may publish a release (spec c-4, decision
// release_pipeline): the ref is refs/tags/v<MAJOR.MINOR.PATCH>[-rc.N], its
// MAJOR.MINOR.PATCH equals package.json's version, and the tagged commit is
// reachable from origin/main. On success it writes version= and prerelease= to
// $GITHUB_OUTPUT in one append; on any refusal or error it writes nothing and exits
// 1, so a later job can never read a half-set output.
//
// Node built-ins only, run with type stripping: the tag job installs no dependencies
// and runs no dependency code.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG_PREFIX = 'refs/tags/';

/** v + MAJOR.MINOR.PATCH, no leading zeros, with an optional -rc.N (N >= 1). */
const TAG = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))(-rc\.[1-9]\d*)?$/;

/** A full git object id (SHA-1 or SHA-256): never an option or a ref name. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type ReleaseTagInput = {
	/** The full pushed ref, e.g. refs/tags/v0.1.5 ($GITHUB_REF). */
	ref: string;
	/** package.json's version (MAJOR.MINOR.PATCH). */
	packageVersion: string;
	/** Whether the tagged commit is reachable from origin/main. */
	onMain: boolean;
};

export type ReleaseTagResult =
	{ ok: true; version: string; prerelease: boolean } | { ok: false; reason: string };

/** Pure check of one pushed ref against package.json's version and main. */
export function checkReleaseTag({
	ref,
	packageVersion,
	onMain
}: ReleaseTagInput): ReleaseTagResult {
	if (!ref.startsWith(TAG_PREFIX)) {
		return { ok: false, reason: `${JSON.stringify(ref)} is not a tag ref (refs/tags/...)` };
	}
	const tag = ref.slice(TAG_PREFIX.length);
	const match = TAG.exec(tag);
	if (match === null) {
		return {
			ok: false,
			reason: `tag ${JSON.stringify(tag)} is not vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N`
		};
	}
	const base = match[1];
	if (base !== packageVersion) {
		return {
			ok: false,
			reason: `tag ${tag} is version ${base} but package.json's version is ${JSON.stringify(packageVersion)}`
		};
	}
	if (!onMain) {
		return { ok: false, reason: `tag ${tag} points at a commit not reachable from origin/main` };
	}
	return { ok: true, version: tag.slice(1), prerelease: match[5] !== undefined };
}

/**
 * Whether commit `sha` is reachable from origin/main in the repo at `cwd`.
 * Throws on anything but a clean yes/no from git (bad id, missing origin/main).
 */
export function isOnMain(sha: string, cwd: string): boolean {
	if (!OBJECT_ID.test(sha)) throw new Error(`not a full commit id: ${JSON.stringify(sha)}`);
	const run = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], {
		cwd,
		encoding: 'utf8'
	});
	if (run.error) throw run.error;
	if (run.status === 0) return true;
	if (run.status === 1) return false;
	throw new Error(
		`git merge-base --is-ancestor exited ${run.status}: ${(run.stderr ?? '').trim()}`
	);
}

export type CliDeps = {
	env: NodeJS.ProcessEnv;
	/** Repo root: package.json and the git repo. */
	root: string;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (value === undefined || value === '') throw new Error(`${name} is not set`);
	return value;
}

/** The CLI: 0 after writing the outputs, 1 on any refusal or error (nothing written). */
export function runCli({ env, root, stdout, stderr }: CliDeps): number {
	try {
		const ref = required(env, 'GITHUB_REF');
		const sha = required(env, 'GITHUB_SHA');
		const output = required(env, 'GITHUB_OUTPUT');
		const { version: packageVersion } = JSON.parse(
			readFileSync(join(root, 'package.json'), 'utf8')
		) as { version?: unknown };
		if (typeof packageVersion !== 'string') throw new Error('package.json has no version');
		const result = checkReleaseTag({ ref, packageVersion, onMain: isOnMain(sha, root) });
		if (!result.ok) throw new Error(result.reason);
		appendFileSync(output, `version=${result.version}\nprerelease=${result.prerelease}\n`);
		stdout(`release-tag: ${result.version} (prerelease: ${result.prerelease})`);
		return 0;
	} catch (error) {
		stderr(`release-tag: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

// import.meta.main is missing on Node < 24.2; fall back to argv.
const isEntry =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) {
	process.exitCode = runCli({
		env: process.env,
		root: process.cwd(),
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line)
	});
}
