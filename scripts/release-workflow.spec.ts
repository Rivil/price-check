// Pins .github/workflows/release.yml (05-release c-1, c-2, c-4; decisions
// release_pipeline and release_secrets, amended by 06-remediate-security
// signing_job_split: c-8, c-15, c-26): a v* tag push runs tag -> three OS builds ->
// publish, macOS as build-macos (unsigned, no secrets) -> sign-macos (the only job with
// the release environment and the five signing secrets) -> verify-macos (no secrets);
// the unsigned .app and the signed release travel between them as tars. Only publish
// writes, and it runs nothing but gh and one SHA-pinned download-artifact; every
// release path verifies its layout and fuses and runs the packaged smoke before
// uploading; any failed job publishes nothing, and publish refuses an existing release
// or draft for the tag. SHA pins, the permissions allowlist and what a secret-bearing
// job may run are `pnpm ci:policy`'s (scripts/workflow-policy.ts).
//
// The publish script is also run under bash with a stub gh on PATH (the c-4 empty and
// idempotency edges), and sign-macos's check of the unsigned tar against planted and
// swapped downloads (SEC-18). The workflow is read by scripts/workflow-reader.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectedArtefacts, PACKAGED_PLATFORMS, type PackagedPlatform } from './packaged-app.ts';
import { block, map, readWorkflow, steps, type Step, type Workflow } from './workflow-reader.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** The jobs that install, build and package the app, one per OS. */
const BUILDS: Record<string, PackagedPlatform> = {
	'build-macos': 'darwin',
	'build-windows': 'win32',
	'build-linux': 'linux'
};
/** Per OS, the job that verifies the shipped files and uploads them for publish. */
const RELEASE_PATHS: Record<PackagedPlatform, string> = {
	darwin: 'verify-macos',
	win32: 'build-windows',
	linux: 'build-linux'
};
/** The fuses step of each release path: on the binary that ships. */
const FUSES: Record<PackagedPlatform, string> = {
	darwin: 'node scripts/verify-packaged.ts fuses "dist-packaged/mac-universal/Price Check.app"',
	win32: 'node scripts/verify-packaged.ts fuses "$PRICE_CHECK_PACKAGED_EXE"',
	linux: 'node scripts/verify-packaged.ts fuses dist-packaged/linux-unpacked/price-check-app'
};
const JOBS = [
	'tag',
	'build-macos',
	'sign-macos',
	'verify-macos',
	'build-windows',
	'build-linux',
	'publish'
];
/** Every job that stamps the tag job's version. */
const VERSIONED = JOBS.filter((id) => id !== 'tag' && id !== 'publish');
const SIGN_JOB = 'sign-macos';
const SIGNING_INSTALL =
	'pnpm install --dir signing --ignore-workspace --frozen-lockfile --ignore-scripts';
const SIGN_MAC =
	'node scripts/sign-mac.ts --version "$RELEASE_VERSION" --app "dist-packaged/mac-universal/Price Check.app"';
const SECRETS = [
	'CSC_LINK',
	'APPLE_API_KEY_P8_BASE64',
	'APPLE_API_KEY_ID',
	'APPLE_API_ISSUER',
	'CSC_KEY_PASSWORD'
];
const VERSION_REF = '${{ needs.tag.outputs.version }}';
const PRERELEASE_REF = '${{ needs.tag.outputs.prerelease }}';
const MAC_APP = '"dist-packaged/mac-universal/Price Check.app"';
const LAYOUT =
	'node scripts/verify-packaged.ts layout dist-packaged --version "$RELEASE_VERSION" --mode release';
const SMOKE = 'pnpm test:e2e:packaged';
/** SEC-18: where sign-macos downloads the unsigned tar, and how it unpacks it. */
const UNSIGNED_DIR = '${{ runner.temp }}/macos-unsigned';
const UNSIGNED_UNPACK = 'tar -xf "$RUNNER_TEMP/macos-unsigned/mac-unsigned.tar" -C dist-packaged';
const UNSIGNED_SHA_REF = '${{ needs.build-macos.outputs.unsigned-sha256 }}';
const UNSIGNED_DIGEST =
	'echo "sha256=$(shasum -a 256 mac-unsigned.tar | cut -d \' \' -f 1)" >> "$GITHUB_OUTPUT"';
const SHA_PINNED = (action: string) => new RegExp(`^${action}@[0-9a-f]{40}$`);

/** Job ids directly under `jobs:`, in file order. */
function jobIds(lines: string[]): string[] {
	const at = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	const out: string[] = [];
	for (const l of lines.slice(at + 1)) {
		if (/^[^\s#]/.test(l)) break;
		const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
		if (m) out.push(m[1]);
	}
	return out;
}

const indexWhere = (list: Step[], pred: (s: Step) => boolean) => list.findIndex(pred);
const runs = (s: Step, text: string) => s.run.some((r) => r.includes(text));
const uses = (s: Step, action: string) => s.get('uses')?.startsWith(`${action}@`) ?? false;
const stepEnv = (s: Step) => map(block(s.lines, 'env', 8));

// Read afresh before each test, never at collection (Stryker counts load-time
// coverage as static, as in ci-desktop.spec).
let text: string;
let wf: Workflow;
let jobSteps: Record<string, Step[]>;
let allSteps: Step[];
let signStep: Step;
let unsignedCheck: Step;
let publishStep: Step;
beforeEach(() => {
	text = read('.github/workflows/release.yml');
	wf = readWorkflow(text, 'release.yml');
	jobSteps = Object.fromEntries(JOBS.map((id) => [id, steps(wf.job(id))]));
	allSteps = Object.values(jobSteps).flat();
	signStep = jobSteps[SIGN_JOB].find((s) => runs(s, 'node scripts/sign-mac.ts'))!;
	unsignedCheck = jobSteps[SIGN_JOB].find((s) => runs(s, 'shasum -a 256 -c'))!;
	publishStep = jobSteps.publish.find((s) => runs(s, 'gh release create'))!;
});

/** A job's lines without comments: what GitHub reads. */
const jobCode = (id: string) => wf.job(id).filter((l) => !l.trim().startsWith('#'));

describe('release.yml shape', () => {
	it('has exactly the tag, three build, sign, verify and publish jobs', () => {
		expect(jobIds(wf.lines)).toEqual(JOBS);
	});

	it('triggers only on pushed v* tags', () => {
		expect(wf.triggers()).toEqual({ push: { tags: ['v*'] } });
	});

	it('runs one release per ref at a time and never cancels one halfway', () => {
		const concurrency = wf.top('concurrency') as Record<string, string>;
		expect(concurrency.group).toContain('${{ github.ref }}');
		expect(concurrency['cancel-in-progress']).toBe('false');
	});
});

describe('permissions (the allowlist is per file, so pin it per job)', () => {
	it('reads only at workflow level', () => {
		expect(wf.top('permissions')).toEqual({ contents: 'read' });
	});

	it('gives every job but publish exactly contents: read', () => {
		for (const id of JOBS.filter((j) => j !== 'publish'))
			expect(wf.jobKey(id, 'permissions'), id).toEqual({ contents: 'read' });
	});

	it('gives publish exactly contents: write', () => {
		expect(wf.jobKey('publish', 'permissions')).toEqual({ contents: 'write' });
	});
});

describe('supply-chain hygiene', () => {
	it('uses no cache: no actions/cache, no setup-node cache', () => {
		expect(text).not.toMatch(/actions\/cache@/);
		const setups = allSteps.filter((s) => uses(s, 'actions/setup-node'));
		expect(setups.length).toBeGreaterThanOrEqual(4);
		for (const s of setups) {
			expect(s.get('cache'), s.lines.join('\n')).toBeUndefined();
			expect(s.get('node-version-file')).toBe('.node-version');
		}
	});

	it('installs only from the frozen lockfile: the root where no secret is, signing/ where one is', () => {
		const installs = (id: string) =>
			jobSteps[id].flatMap((s) => s.run).filter((r) => /\bpnpm (i|install)\b/.test(r));
		for (const id of ['build-macos', 'verify-macos', 'build-windows', 'build-linux'])
			expect(installs(id), id).toEqual(['pnpm install --frozen-lockfile']);
		expect(installs(SIGN_JOB)).toEqual([SIGNING_INSTALL]);
		expect(installs('tag')).toEqual([]);
		expect(installs('publish')).toEqual([]);
		expect(text).not.toMatch(/\bnpm (i|install|ci)\b/);
	});

	it('never persists the checkout credentials', () => {
		const checkouts = allSteps.filter((s) => uses(s, 'actions/checkout'));
		expect(checkouts).toHaveLength(6);
		for (const s of checkouts) expect(s.get('persist-credentials')).toBe('false');
	});
});

describe('tag job', () => {
	it('runs release-tag.ts on .node-version Node, after a full-history checkout, with no install', () => {
		const list = jobSteps.tag;
		const checkout = indexWhere(list, (s) => uses(s, 'actions/checkout'));
		const setup = indexWhere(list, (s) => uses(s, 'actions/setup-node'));
		const check = indexWhere(list, (s) => s.run.includes('node scripts/release-tag.ts'));
		expect(checkout).toBe(0);
		expect(list[checkout].get('fetch-depth')).toBe('0');
		expect(setup).toBeGreaterThan(checkout);
		expect(check).toBeGreaterThan(setup);
		expect(list[setup].get('node-version-file')).toBe('.node-version');
		expect(list[setup].get('cache')).toBeUndefined();
		const code = wf.job('tag').filter((l) => !l.trim().startsWith('#'));
		expect(code.join('\n')).not.toMatch(/\b(pnpm|npm|npx)\b/);
	});

	it("outputs the check step's version and prerelease", () => {
		const check = jobSteps.tag.find((s) => s.run.includes('node scripts/release-tag.ts'))!;
		expect(check.get('id')).toBe('check');
		expect(wf.jobKey('tag', 'outputs')).toEqual({
			version: '${{ steps.check.outputs.version }}',
			prerelease: '${{ steps.check.outputs.prerelease }}'
		});
	});
});

describe('secrets and the release environment', () => {
	it('puts exactly the five signing secrets in the sign step env', () => {
		expect(signStep).toBeDefined();
		expect(stepEnv(signStep)).toEqual(
			Object.fromEntries(SECRETS.map((name) => [name, `\${{ secrets.${name} }}`]))
		);
	});

	it('reads secrets nowhere else, and never inside a run script', () => {
		const envLines = block(signStep.lines, 'env', 8);
		const secretLines = wf.lines.filter((l) => l.includes('secrets.'));
		expect(secretLines).toHaveLength(SECRETS.length);
		for (const line of secretLines) expect(envLines).toContain(line);
		for (const s of allSteps) expect(s.run.filter((r) => r.includes('secrets.'))).toEqual([]);
		expect(text).not.toMatch(/secrets\s*:\s*inherit/);
	});

	it('gives only sign-macos the release environment, named as release.json names it', () => {
		const { name } = JSON.parse(read('.github/environments/release.json')) as { name: string };
		expect(name).toBe('release');
		for (const id of JOBS) {
			expect(wf.jobKey(id, 'environment'), id).toEqual(id === SIGN_JOB ? name : undefined);
		}
	});

	it('names no signing secret and reads no secret in any job but sign-macos', () => {
		const named = new RegExp(`\\b(${SECRETS.join('|')})\\b|\\bsecrets\\b`);
		for (const id of JOBS.filter((j) => j !== SIGN_JOB))
			expect(
				jobCode(id).filter((l) => named.test(l)),
				id
			).toEqual([]);
	});

	it('verify-macos holds no secret and no environment', () => {
		expect(wf.jobKey('verify-macos', 'environment')).toBeUndefined();
		expect(jobCode('verify-macos').join('\n')).not.toMatch(/\bsecrets\b|CSC_|APPLE_API_/);
	});

	it('publishes with the workflow token, no other credential', () => {
		expect(stepEnv(publishStep).GH_TOKEN).toBe('${{ github.token }}');
	});
});

describe('builds', () => {
	it.each(Object.keys(BUILDS))('%s needs only tag', (id) => {
		expect(wf.jobKey(id, 'needs')).toEqual(['tag']);
	});

	it.each(VERSIONED)('%s stamps the tag job version', (id) => {
		expect(map(block(wf.job(id), 'env', 4)).RELEASE_VERSION).toBe(VERSION_REF);
		const versions = jobSteps[id]
			.flatMap((s) => s.run)
			.flatMap((r) => [...r.matchAll(/--version\s+(\S+)/g)].map((m) => m[1]));
		expect(versions.length).toBeGreaterThanOrEqual(1);
		for (const v of versions) expect(v).toBe('"$RELEASE_VERSION"');
		for (const s of jobSteps[id]) expect(stepEnv(s).RELEASE_VERSION).toBeUndefined();
	});

	it.each(Object.keys(BUILDS))('%s builds the web and desktop bundles before packaging', (id) => {
		const list = jobSteps[id];
		const build = indexWhere(
			list,
			(s) => s.run.includes('pnpm build') && s.run.includes('pnpm build:desktop')
		);
		const pack = indexWhere(list, (s) => runs(s, 'pnpm package:desktop'));
		expect(build).toBeGreaterThan(0);
		expect(pack).toBeGreaterThan(build);
	});

	it('no build signs, and none bakes in a feed URL', () => {
		for (const id of Object.keys(BUILDS)) {
			const packs = jobSteps[id].flatMap((s) => s.run).filter((r) => r.includes('package:desktop'));
			expect(packs, id).toEqual(['pnpm package:desktop --version "$RELEASE_VERSION"']);
		}
		expect(text).not.toMatch(/--sign\b/);
		expect(text).not.toContain('--feed-url');
	});

	it.each(Object.entries(RELEASE_PATHS))(
		'%s: %s verifies the layout and the fuses and runs the packaged smoke before uploading',
		(platform, id) => {
			const list = jobSteps[id];
			const layout = indexWhere(list, (s) => s.run.includes(LAYOUT));
			const fuses = list.filter((s) => runs(s, 'verify-packaged.ts fuses'));
			const smoke = indexWhere(list, (s) => runs(s, SMOKE));
			const uploads = list.filter((s) => uses(s, 'actions/upload-artifact'));
			expect(fuses).toHaveLength(1);
			expect(fuses[0].run).toEqual([FUSES[platform as PackagedPlatform]]);
			expect(uploads).toHaveLength(1);
			const upload = uploads[0].index;
			expect(layout).toBeGreaterThan(0);
			expect(fuses[0].index).toBeGreaterThan(layout);
			expect(smoke).toBeGreaterThan(fuses[0].index);
			expect(upload).toBeGreaterThan(smoke);
			expect(uploads[0].get('if-no-files-found')).toBe('error');
			expect(uploads[0].get('name')).toBe(
				`release-${{ darwin: 'macos', win32: 'windows', linux: 'linux' }[platform]}`
			);
		}
	);

	it('only the release paths upload release-* files, the pattern publish downloads', () => {
		const releaseUploads = JOBS.flatMap((id) =>
			jobSteps[id]
				.filter((s) => uses(s, 'actions/upload-artifact'))
				.filter((s) => s.get('name')!.startsWith('release-'))
				.map(() => id)
		);
		expect(releaseUploads.sort()).toEqual(Object.values(RELEASE_PATHS).sort());
	});
});

describe('macOS: build unsigned, sign, verify the signed release', () => {
	/** The single upload of `id`, which must be a tar packed by an earlier step. */
	function tarUpload(id: string, packed: string): { name: string; tar: string; at: number } {
		const list = jobSteps[id];
		const uploads = list.filter((s) => uses(s, 'actions/upload-artifact'));
		expect(uploads, id).toHaveLength(1);
		const tar = uploads[0].get('path')!;
		expect(tar, id).toMatch(/^[\w.-]+\.tar$/);
		const packLine = `tar -cf ${tar} -C dist-packaged ${packed}`;
		const pack = indexWhere(list, (s) => s.run.includes(packLine));
		expect(pack, id).toBeGreaterThan(0);
		expect(uploads[0].index).toBeGreaterThan(pack);
		expect(uploads[0].get('if-no-files-found')).toBe('error');
		return { name: uploads[0].get('name')!, tar, at: uploads[0].index };
	}

	/**
	 * Where `id` downloads `name` (into `path`, or the workspace when undefined) and
	 * unpacks it with `unpackLine` into dist-packaged, after its checkout.
	 */
	function tarDownload(
		id: string,
		name: string,
		path: string | undefined,
		unpackLine: string
	): number {
		const list = jobSteps[id];
		const downloads = list.filter((s) => uses(s, 'actions/download-artifact'));
		expect(downloads, id).toHaveLength(1);
		expect(downloads[0].get('name')).toBe(name);
		expect(downloads[0].get('path')).toBe(path);
		const checkout = indexWhere(list, (s) => uses(s, 'actions/checkout'));
		const unpack = indexWhere(list, (s) => s.run.includes(unpackLine));
		expect(downloads[0].index).toBeGreaterThan(checkout);
		expect(unpack).toBeGreaterThan(downloads[0].index);
		return unpack;
	}

	it('build-macos packages unsigned and uploads the .app only as a tar', () => {
		const pack = indexWhere(jobSteps['build-macos'], (s) => runs(s, 'pnpm package:desktop'));
		const { at } = tarUpload('build-macos', 'mac-universal');
		expect(at).toBeGreaterThan(pack);
	});

	it('sign-macos needs build-macos and downloads its tar into RUNNER_TEMP before signing', () => {
		expect(wf.jobKey(SIGN_JOB, 'needs')).toEqual(['tag', 'build-macos']);
		const { name, tar } = tarUpload('build-macos', 'mac-universal');
		expect(UNSIGNED_UNPACK).toContain(`/${tar}"`);
		const unpack = tarDownload(SIGN_JOB, name, UNSIGNED_DIR, UNSIGNED_UNPACK);
		expect(signStep.index).toBeGreaterThan(unpack);
	});

	it("build-macos publishes the packed tar's sha256 as a job output", () => {
		const pack = jobSteps['build-macos'].find((s) => s.get('id') === 'pack')!;
		expect(pack).toBeDefined();
		expect(pack.run).toEqual([
			'set -euo pipefail',
			'tar -cf mac-unsigned.tar -C dist-packaged mac-universal',
			UNSIGNED_DIGEST
		]);
		expect(wf.jobKey('build-macos', 'outputs')).toEqual({
			'unsigned-sha256': '${{ steps.pack.outputs.sha256 }}'
		});
	});

	it("sign-macos checks the download against build-macos's sha256, then unpacks it, then signs", () => {
		expect(unsignedCheck).toBeDefined();
		expect(stepEnv(unsignedCheck)).toEqual({ UNSIGNED_SHA256: UNSIGNED_SHA_REF });
		const run = unsignedCheck.run;
		expect(run[0]).toBe('set -euo pipefail');
		expect(run.at(-1)).toBe(UNSIGNED_UNPACK);
		const check = run.findIndex((l) => l.includes('shasum -a 256 -c'));
		expect(check).toBeLessThan(run.length - 1);
		const download = indexWhere(jobSteps[SIGN_JOB], (s) => uses(s, 'actions/download-artifact'));
		expect(unsignedCheck.index).toBeGreaterThan(download);
		expect(signStep.index).toBeGreaterThan(unsignedCheck.index);
		// The one unpack in the job is the checked one.
		const unpacks = jobSteps[SIGN_JOB].flatMap((s) => s.run).filter((l) => /\btar -x/.test(l));
		expect(unpacks).toEqual([UNSIGNED_UNPACK]);
		// The sha256 reaches the script by env, never spliced into it.
		expect(run.join('\n')).not.toContain('${{');
	});

	it('sign-macos installs only signing/ and runs only sign-mac.ts', () => {
		const list = jobSteps[SIGN_JOB];
		const install = indexWhere(list, (s) => s.run.includes(SIGNING_INSTALL));
		expect(install).toBeGreaterThan(0);
		expect(signStep.index).toBeGreaterThan(install);
		const node = list.flatMap((s) => s.run).filter((r) => /\b(node|pnpm|npm|npx)\b/.test(r));
		expect(node).toEqual([SIGNING_INSTALL, SIGN_MAC]);
	});

	it('sets the .p8 cleanup trap before decoding the key, then signs with it', () => {
		const run = signStep.run;
		const trap = run.indexOf(`trap 'rm -f "$RUNNER_TEMP/AuthKey.p8"' EXIT`);
		const decode = run.indexOf(
			`printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$RUNNER_TEMP/AuthKey.p8"`
		);
		const exportKey = run.indexOf('export APPLE_API_KEY="$RUNNER_TEMP/AuthKey.p8"');
		const sign = run.indexOf(SIGN_MAC);
		expect(run.slice(0, 2)).toEqual(['set -euo pipefail', 'umask 077']);
		expect(trap).toBeGreaterThanOrEqual(0);
		expect(decode).toBeGreaterThan(trap);
		expect(exportKey).toBeGreaterThan(decode);
		expect(sign).toBeGreaterThan(exportKey);
		expect(run.filter((r) => /\btrap\b/.test(r))).toHaveLength(1);
	});

	it('verify-macos needs sign-macos and verifies the signed release it downloads', () => {
		expect(wf.jobKey('verify-macos', 'needs')).toEqual(['tag', 'sign-macos']);
		const { name, tar, at } = tarUpload(SIGN_JOB, '.');
		expect(at).toBeGreaterThan(signStep.index);
		const unpack = tarDownload('verify-macos', name, undefined, `tar -xf ${tar} -C dist-packaged`);
		const list = jobSteps['verify-macos'];
		const layout = indexWhere(list, (s) => s.run.includes(LAYOUT));
		const signed = indexWhere(list, (s) =>
			s.run.includes(`node scripts/verify-packaged.ts mac ${MAC_APP} --signed`)
		);
		const upload = indexWhere(list, (s) => uses(s, 'actions/upload-artifact'));
		expect(layout).toBeGreaterThan(unpack);
		expect(signed).toBeGreaterThan(unpack);
		expect(upload).toBeGreaterThan(signed);
	});
});

describe('Windows and Linux', () => {
	it('Windows: silent install, then verify win and the fuses of the installed exe, then the smoke', () => {
		const list = jobSteps['build-windows'];
		const install = list.find((s) => runs(s, 'node scripts/packaged-app.ts install dist-packaged'));
		expect(install).toBeDefined();
		const r = install!.run;
		const installAt = r.findIndex((l) => l.includes('packaged-app.ts install dist-packaged'));
		const verifyAt = r.indexOf('node scripts/verify-packaged.ts win dist-packaged');
		expect(verifyAt).toBeGreaterThan(installAt);
		expect(r.at(-1)).toBe('echo "PRICE_CHECK_PACKAGED_EXE=$exe" >> "$GITHUB_ENV"');
		const fuses = indexWhere(list, (s) => s.run.includes(FUSES.win32));
		const smoke = indexWhere(list, (s) => runs(s, SMOKE));
		expect(fuses).toBeGreaterThan(install!.index);
		expect(smoke).toBeGreaterThan(install!.index);
	});

	it('Linux: the smoke runs under xvfb-run -a after the AppArmor userns sysctl', () => {
		const smoke = jobSteps['build-linux'].find((s) => runs(s, SMOKE))!;
		const sysctl = smoke.run.indexOf(
			'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'
		);
		const xvfb = smoke.run.indexOf(`xvfb-run -a ${SMOKE}`);
		expect(sysctl).toBeGreaterThanOrEqual(0);
		expect(xvfb).toBeGreaterThan(sysctl);
		expect(smoke.run.filter((r) => r.includes(SMOKE))).toEqual([`xvfb-run -a ${SMOKE}`]);
		expect(text).not.toContain('--no-sandbox');
	});
});

describe('any failed build publishes nothing', () => {
	it('publish needs exactly the tag, the verified macOS release and the other two builds', () => {
		expect(wf.jobKey('publish', 'needs')).toEqual([
			'tag',
			'verify-macos',
			'build-windows',
			'build-linux'
		]);
	});

	it('no job or step runs regardless of failure', () => {
		expect(text).not.toMatch(/\balways\(\)|\bcancelled\(\)|\bfailure\(\)/);
		for (const id of JOBS) expect(wf.jobKey(id, 'if'), id).toBeUndefined();
		expect(text).not.toMatch(/continue-on-error/);
	});
});

describe('publish runs no repo or dependency code', () => {
	it('has no checkout or setup-node, and one SHA-pinned download-artifact as its only uses', () => {
		const usesLines = wf.job('publish').filter((l) => /^\s*(- )?uses:/.test(l));
		expect(usesLines).toHaveLength(1);
		const download = jobSteps.publish.find((s) => s.get('uses') !== undefined)!;
		expect(download.get('uses')).toMatch(SHA_PINNED('actions/download-artifact'));
		expect(download.get('pattern')).toBe('release-*');
		expect(download.get('merge-multiple')).toBe('true');
		expect(download.get('path')).toBe('release-files');
	});

	it('invokes no node, pnpm, npm or npx', () => {
		const lines = jobSteps.publish.flatMap((s) => s.run);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(line).not.toMatch(/\b(node|pnpm|npm|npx)\b/);
	});

	it('takes the tag, version and prerelease from the run, never from a step output', () => {
		expect(stepEnv(publishStep)).toEqual({
			GH_TOKEN: '${{ github.token }}',
			TAG: '${{ github.ref_name }}',
			VERSION: VERSION_REF,
			PRERELEASE: PRERELEASE_REF
		});
	});
});

/** The publish script's `required=( … )` names with $VERSION set to `version`. */
function requiredFiles(run: string[], version: string): string[] {
	const start = run.indexOf('required=(');
	const end = run.indexOf(')', start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return run
		.slice(start + 1, end)
		.map((l) => l.replace(/^"(.*)"$/, '$1').replaceAll('$VERSION', version));
}

const union = (version: string) =>
	PACKAGED_PLATFORMS.flatMap((p) => expectedArtefacts(p, version)).sort();

describe("publish's release", () => {
	it.each(['0.1.5', '0.1.5-rc.1'])(
		'requires exactly the union of expectedArtefacts for darwin, win32 and linux (%s)',
		(version) => {
			expect(requiredFiles(publishStep.run, version).sort()).toEqual(union(version));
		}
	);

	it('lists releases including drafts before its single gh release create', () => {
		const run = publishStep.run;
		const lists = run.filter((l) => l.includes('gh release list'));
		const creates = run.filter((l) => l.includes('gh release create'));
		expect(lists).toHaveLength(1);
		expect(creates).toHaveLength(1);
		expect(lists[0]).not.toContain('--exclude-drafts');
		expect(lists[0]).toContain('--repo "$GITHUB_REPOSITORY"');
		expect(run.indexOf(lists[0])).toBeLessThan(run.indexOf(creates[0]));
		expect(text.match(/gh release create/g)).toHaveLength(1);
		expect(text).not.toMatch(/gh release (upload|edit|delete)/);
	});

	it('creates with --verify-tag, --repo "$GITHUB_REPOSITORY" and --prerelease tied to the tag job', () => {
		const create = publishStep.run.find((l) => l.includes('gh release create'))!;
		expect(create).toContain('--verify-tag');
		expect(create).toContain('--repo "$GITHUB_REPOSITORY"');
		expect(create).toContain('"${required[@]}"');
		expect(create).not.toContain('--prerelease');
		expect(create).not.toContain('--draft');
		expect(publishStep.run).toContain('true) flags=(--prerelease) ;;');
		expect(stepEnv(publishStep).PRERELEASE).toBe(PRERELEASE_REF);
	});
});

describe('PR CI never checks signing', () => {
	it('ci.yml has no codesign, spctl or stapler', () => {
		expect(read('.github/workflows/ci.yml')).not.toMatch(/codesign|spctl|stapler/i);
	});
});

// The publish script itself, under bash with a stub gh (c-4 empty and idempotency
// edges). Bash and the stub are POSIX-only.
describe.skipIf(process.platform === 'win32')('publish script under a stub gh', () => {
	const SEP = '\u001f';
	const STUB = `#!/usr/bin/env bash
(IFS=$'\\x1f'; printf '%s\\n' "$*") >> "$GH_LOG"
if [ "$1 $2" = "release list" ]; then
  if [ -n "\${STUB_LIST_FAILS:-}" ]; then echo "stub: list failed" >&2; exit 1; fi
  for t in \${STUB_PUBLISHED:-}; do echo "$t"; done
  case " $* " in *" --exclude-drafts "*) ;; *) for t in \${STUB_DRAFTS:-}; do echo "$t"; done ;; esac
  exit 0
fi
if [ "$1 $2" = "release create" ]; then exit 0; fi
echo "stub: unexpected gh $*" >&2
exit 2
`;

	let dir = '';
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = '';
	});

	type Run = {
		status: number | null;
		calls: string[][];
		creates: string[][];
		stderr: string;
		stdout: string;
	};

	type PublishInput = {
		version?: string;
		tag?: string;
		prerelease?: string;
		files?: string[];
		empty?: string[];
		published?: string;
		drafts?: string;
		listFails?: boolean;
	};

	function runPublish({
		version = '0.1.5',
		tag = `v${version}`,
		prerelease = version.includes('-rc.') ? 'true' : 'false',
		files = union(version),
		empty = [],
		published = '',
		drafts = '',
		listFails = false
	}: PublishInput = {}): Run {
		dir = mkdtempSync(join(tmpdir(), 'release-publish-'));
		const bin = join(dir, 'bin');
		const work = join(dir, 'work');
		const out = join(work, 'release-files');
		mkdirSync(bin);
		mkdirSync(out, { recursive: true });
		writeFileSync(join(bin, 'gh'), STUB);
		chmodSync(join(bin, 'gh'), 0o755);
		for (const f of files) writeFileSync(join(out, f), empty.includes(f) ? '' : `${f}\n`);
		const script = join(dir, 'publish.sh');
		writeFileSync(script, `${publishStep.run.join('\n')}\n`);
		const log = join(dir, 'gh.log');
		writeFileSync(log, '');
		const res = spawnSync('bash', [script], {
			cwd: work,
			encoding: 'utf8',
			env: {
				PATH: `${bin}:${process.env.PATH ?? ''}`,
				GH_LOG: log,
				GH_TOKEN: 'stub-token',
				GITHUB_REPOSITORY: 'owner/repo',
				TAG: tag,
				VERSION: version,
				PRERELEASE: prerelease,
				STUB_PUBLISHED: published,
				STUB_DRAFTS: drafts,
				...(listFails ? { STUB_LIST_FAILS: '1' } : {})
			}
		});
		const calls = readFileSync(log, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => l.split(SEP));
		return {
			status: res.status,
			calls,
			creates: calls.filter((c) => c[0] === 'release' && c[1] === 'create'),
			stderr: res.stderr,
			stdout: res.stdout
		};
	}

	it('creates one final release with every file, --verify-tag and --repo, no --prerelease', () => {
		const r = runPublish();
		expect(r.status, r.stderr + r.stdout).toBe(0);
		expect(r.creates).toHaveLength(1);
		const args = r.creates[0];
		expect(args.slice(0, 3)).toEqual(['release', 'create', 'v0.1.5']);
		const files = args.slice(3, 3 + union('0.1.5').length);
		expect([...files].sort()).toEqual(union('0.1.5'));
		expect(args.slice(3 + files.length)).toEqual([
			'--repo',
			'owner/repo',
			'--verify-tag',
			'--title',
			'v0.1.5',
			'--notes',
			'Price Check 0.1.5'
		]);
		const list = r.calls.find((c) => c[0] === 'release' && c[1] === 'list')!;
		expect(list).not.toContain('--exclude-drafts');
		expect(r.calls.indexOf(list)).toBeLessThan(r.calls.indexOf(r.creates[0]));
	});

	it('marks an rc tag a pre-release', () => {
		const r = runPublish({ version: '0.1.5-rc.2' });
		expect(r.status, r.stderr + r.stdout).toBe(0);
		expect(r.creates).toHaveLength(1);
		expect(r.creates[0][2]).toBe('v0.1.5-rc.2');
		expect(r.creates[0].filter((a) => a === '--prerelease')).toHaveLength(1);
	});

	it('publishes alongside releases for other tags', () => {
		const r = runPublish({ published: 'v0.1.4 v0.1.5-rc.1', drafts: 'v0.1.5-rc.2' });
		expect(r.status, r.stderr + r.stdout).toBe(0);
		expect(r.creates).toHaveLength(1);
	});

	it('refuses when a published release exists for the tag', () => {
		const r = runPublish({ published: 'v0.1.4 v0.1.5' });
		expect(r.status).toBe(1);
		expect(r.creates).toEqual([]);
		expect(r.stdout).toContain('already exists');
	});

	it('refuses when only a draft exists for the tag', () => {
		const r = runPublish({ drafts: 'v0.1.5' });
		expect(r.status).toBe(1);
		expect(r.creates).toEqual([]);
	});

	it('refuses when the release list fails', () => {
		const r = runPublish({ listFails: true });
		expect(r.status).toBe(1);
		expect(r.creates).toEqual([]);
	});

	it.each(union('0.1.5'))('refuses with %s missing', (missing) => {
		const r = runPublish({ files: union('0.1.5').filter((f) => f !== missing) });
		expect(r.status).toBe(1);
		expect(r.creates).toEqual([]);
	});

	it('refuses an extra file', () => {
		const r = runPublish({ files: [...union('0.1.5'), 'price-check-0.1.5-mac-arm64.dmg'] });
		expect(r.status).toBe(1);
		expect(r.creates).toEqual([]);
	});

	it("refuses another version's file set", () => {
		const r = runPublish({ files: union('0.1.4') });
		expect(r.status).toBe(1);
		expect(r.creates).toEqual([]);
	});

	it('refuses an empty file', () => {
		const r = runPublish({ empty: ['latest.yml'] });
		expect(r.status).toBe(1);
		expect(r.creates).toEqual([]);
	});

	it('refuses a tag that is not v<version>', () => {
		const r = runPublish({ tag: 'v0.1.6' });
		expect(r.status).toBe(1);
		expect(r.calls).toEqual([]);
	});

	it('refuses a prerelease output that is neither true nor false', () => {
		const r = runPublish({ prerelease: '' });
		expect(r.status).toBe(1);
		expect(r.calls).toEqual([]);
	});
});

// sign-macos's check of the unsigned tar under bash (SEC-18): only exactly one regular
// file, mac-unsigned.tar, with build-macos's sha256 is unpacked. build-macos's pack
// step runs too, so the output it publishes is the sha256 the check compares. Bash,
// shasum and tar are POSIX-only here.
describe.skipIf(process.platform === 'win32')('the unsigned tar under bash', () => {
	let dir = '';
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = '';
	});

	const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
	const bash = (script: string[], cwd: string, env: Record<string, string>) =>
		spawnSync('bash', ['-c', script.join('\n')], {
			cwd,
			encoding: 'utf8',
			env: { PATH: process.env.PATH ?? '', ...env }
		});

	/** A tar of a stand-in mac-universal/Price Check.app, packed by build-macos's step. */
	function packed(): { tar: string; sha: string } {
		const build = join(dir, 'build');
		mkdirSync(join(build, 'dist-packaged', 'mac-universal', 'Price Check.app'), {
			recursive: true
		});
		writeFileSync(join(build, 'dist-packaged', 'mac-universal', 'Price Check.app', 'app'), 'app\n');
		const output = join(dir, 'github-output');
		writeFileSync(output, '');
		const pack = jobSteps['build-macos'].find((s) => s.get('id') === 'pack')!;
		const res = bash(pack.run, build, { GITHUB_OUTPUT: output });
		expect(res.status, res.stderr).toBe(0);
		const tar = join(build, 'mac-unsigned.tar');
		expect(readFileSync(output, 'utf8')).toBe(`sha256=${sha256(tar)}\n`);
		return { tar, sha: sha256(tar) };
	}

	type Layout = (download: string, tar: string) => void;

	/** Runs the check step with the download laid out by `layout`. */
	function check(layout: Layout, sha?: string) {
		dir = mkdtempSync(join(tmpdir(), 'release-unsigned-'));
		const { tar, sha: real } = packed();
		const temp = join(dir, 'temp');
		const download = join(temp, 'macos-unsigned');
		const work = join(dir, 'work');
		mkdirSync(download, { recursive: true });
		mkdirSync(work);
		layout(download, tar);
		const res = bash(unsignedCheck.run, work, {
			RUNNER_TEMP: temp,
			UNSIGNED_SHA256: sha ?? real
		});
		const unpacked = existsSync(
			join(work, 'dist-packaged', 'mac-universal', 'Price Check.app', 'app')
		);
		return { status: res.status, unpacked, stderr: res.stderr };
	}

	const copy: Layout = (download, tar) =>
		writeFileSync(join(download, 'mac-unsigned.tar'), readFileSync(tar));

	it('unpacks the one tar build-macos packed into dist-packaged', () => {
		const r = check(copy);
		expect(r.status, r.stderr).toBe(0);
		expect(r.unpacked).toBe(true);
	});

	it.each<[string, Layout, string?]>([
		["a sha256 other than build-macos's", copy, '0'.repeat(64)],
		['an empty sha256', copy, ''],
		[
			'a planted scripts/sign-mac.ts beside the tar',
			(download, tar) => {
				copy(download, tar);
				mkdirSync(join(download, 'scripts'));
				writeFileSync(join(download, 'scripts', 'sign-mac.ts'), 'evil\n');
			}
		],
		[
			'a second file',
			(download, tar) => {
				copy(download, tar);
				writeFileSync(join(download, 'other.tar'), 'x');
			}
		],
		[
			'a hidden file',
			(download, tar) => {
				copy(download, tar);
				writeFileSync(join(download, '.hidden'), 'x');
			}
		],
		[
			'the tar under another name',
			(download, tar) => writeFileSync(join(download, 'other.tar'), readFileSync(tar))
		],
		['an empty download', () => {}],
		[
			'a directory named mac-unsigned.tar',
			(download) => mkdirSync(join(download, 'mac-unsigned.tar'))
		],
		[
			'a symlink to the right tar',
			(download, tar) => symlinkSync(tar, join(download, 'mac-unsigned.tar'))
		]
	])('refuses %s and unpacks nothing', (_name, layout, sha) => {
		const r = check(layout, sha);
		expect(r.status).not.toBe(0);
		expect(r.unpacked).toBe(false);
	});
});
