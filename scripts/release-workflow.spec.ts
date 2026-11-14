// Pins .github/workflows/release.yml (spec c-1, c-2, c-4; decisions release_pipeline
// and release_secrets): a v* tag push runs tag -> three OS builds -> publish; only
// publish writes, and it runs nothing but gh and one SHA-pinned download-artifact;
// only the macOS package step reads the five signing secrets; every build verifies its
// layout and runs the packaged smoke before uploading; any failed job publishes
// nothing, and publish refuses an existing release or draft for the tag. SHA pins and
// the allowlist itself are `pnpm ci:policy`'s (scripts/workflow-policy.ts).
//
// The publish script is also run under bash with a stub gh on PATH (the c-4 empty and
// idempotency edges). The workflow is read by scripts/workflow-reader.ts.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectedArtefacts, PACKAGED_PLATFORMS, type PackagedPlatform } from './packaged-app.ts';
import { block, map, readWorkflow, steps, type Step, type Workflow } from './workflow-reader.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const BUILDS: Record<string, PackagedPlatform> = {
	'build-macos': 'darwin',
	'build-windows': 'win32',
	'build-linux': 'linux'
};
const JOBS = ['tag', ...Object.keys(BUILDS), 'publish'];
const SECRETS = [
	'CSC_LINK',
	'CSC_KEY_PASSWORD',
	'APPLE_API_KEY_P8_BASE64',
	'APPLE_API_KEY_ID',
	'APPLE_API_ISSUER'
];
const VERSION_REF = '${{ needs.tag.outputs.version }}';
const PRERELEASE_REF = '${{ needs.tag.outputs.prerelease }}';
const MAC_APP = '"dist-packaged/mac-universal/Price Check.app"';
const LAYOUT =
	'node scripts/verify-packaged.ts layout dist-packaged --version "$RELEASE_VERSION" --mode release';
const SMOKE = 'pnpm test:e2e:packaged';
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
let macPackage: Step;
let publishStep: Step;
beforeEach(() => {
	text = read('.github/workflows/release.yml');
	wf = readWorkflow(text, 'release.yml');
	jobSteps = Object.fromEntries(JOBS.map((id) => [id, steps(wf.job(id))]));
	allSteps = Object.values(jobSteps).flat();
	macPackage = jobSteps['build-macos'].find((s) => runs(s, 'pnpm package:desktop'))!;
	publishStep = jobSteps.publish.find((s) => runs(s, 'gh release create'))!;
});

describe('release.yml shape', () => {
	it('has exactly the tag, three build and publish jobs', () => {
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

	it('installs only from the frozen lockfile', () => {
		const installs = allSteps.flatMap((s) => s.run).filter((r) => /\bpnpm (i|install)\b/.test(r));
		expect(installs).toHaveLength(3);
		for (const line of installs) expect(line).toContain('--frozen-lockfile');
		expect(text).not.toMatch(/\bnpm (i|install|ci)\b/);
	});

	it('never persists the checkout credentials', () => {
		const checkouts = allSteps.filter((s) => uses(s, 'actions/checkout'));
		expect(checkouts).toHaveLength(4);
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
	it('puts exactly the five signing secrets in the mac package step env', () => {
		expect(macPackage).toBeDefined();
		expect(stepEnv(macPackage)).toEqual(
			Object.fromEntries(SECRETS.map((name) => [name, `\${{ secrets.${name} }}`]))
		);
	});

	it('reads secrets nowhere else, and never inside a run script', () => {
		const envLines = block(macPackage.lines, 'env', 8);
		const secretLines = wf.lines.filter((l) => l.includes('secrets.'));
		expect(secretLines).toHaveLength(SECRETS.length);
		for (const line of secretLines) expect(envLines).toContain(line);
		for (const s of allSteps) expect(s.run.filter((r) => r.includes('secrets.'))).toEqual([]);
		expect(text).not.toMatch(/secrets\s*:\s*inherit/);
	});

	it('gives only build-macos the release environment, named as release.json names it', () => {
		const { name } = JSON.parse(read('.github/environments/release.json')) as { name: string };
		expect(name).toBe('release');
		for (const id of JOBS) {
			expect(wf.jobKey(id, 'environment'), id).toEqual(id === 'build-macos' ? name : undefined);
		}
	});

	it('publishes with the workflow token, no other credential', () => {
		expect(stepEnv(publishStep).GH_TOKEN).toBe('${{ github.token }}');
	});
});

describe('builds', () => {
	it.each(Object.keys(BUILDS))('%s needs tag and stamps the tag job version', (id) => {
		expect(wf.jobKey(id, 'needs')).toEqual(['tag']);
		expect(map(block(wf.job(id), 'env', 4)).RELEASE_VERSION).toBe(VERSION_REF);
		const versions = jobSteps[id]
			.flatMap((s) => s.run)
			.flatMap((r) => [...r.matchAll(/--version\s+(\S+)/g)].map((m) => m[1]));
		expect(versions.length).toBeGreaterThanOrEqual(2);
		for (const v of versions) expect(v).toBe('"$RELEASE_VERSION"');
		for (const s of jobSteps[id]) expect(stepEnv(s).RELEASE_VERSION).toBeUndefined();
	});

	it.each(Object.keys(BUILDS))(
		'%s packages, verifies the layout and runs the packaged smoke before uploading',
		(id) => {
			const list = jobSteps[id];
			const pack = indexWhere(list, (s) => runs(s, 'pnpm package:desktop'));
			const layout = indexWhere(list, (s) => s.run.includes(LAYOUT));
			const smoke = indexWhere(list, (s) => runs(s, SMOKE));
			const uploads = list.filter((s) => uses(s, 'actions/upload-artifact'));
			expect(uploads).toHaveLength(1);
			const upload = uploads[0].index;
			expect(pack).toBeGreaterThan(0);
			expect(layout).toBeGreaterThan(pack);
			expect(smoke).toBeGreaterThan(layout);
			expect(upload).toBeGreaterThan(smoke);
			expect(uploads[0].get('if-no-files-found')).toBe('error');
			expect(uploads[0].get('name')).toMatch(/^release-/);
		}
	);

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

	it('signs only on macOS: --sign with the decoded .p8, then verify mac --signed before upload', () => {
		const list = jobSteps['build-macos'];
		const run = macPackage.run;
		const decode = run.indexOf(
			`printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$RUNNER_TEMP/AuthKey.p8"`
		);
		const exportKey = run.indexOf('export APPLE_API_KEY="$RUNNER_TEMP/AuthKey.p8"');
		const pack = run.indexOf('pnpm package:desktop --version "$RELEASE_VERSION" --sign');
		expect(decode).toBeGreaterThanOrEqual(0);
		expect(exportKey).toBeGreaterThan(decode);
		expect(pack).toBeGreaterThan(exportKey);
		const verify = indexWhere(list, (s) =>
			s.run.includes(`node scripts/verify-packaged.ts mac ${MAC_APP} --signed`)
		);
		const upload = indexWhere(list, (s) => uses(s, 'actions/upload-artifact'));
		expect(verify).toBeGreaterThan(macPackage.index);
		expect(upload).toBeGreaterThan(verify);
	});

	it('never signs Windows or Linux, and no build bakes in a feed URL', () => {
		for (const id of ['build-windows', 'build-linux']) {
			expect(wf.job(id).join('\n'), id).not.toMatch(/--sign\b/);
			expect(jobSteps[id].flatMap((s) => s.run)).toContain(
				'pnpm package:desktop --version "$RELEASE_VERSION"'
			);
		}
		expect(text).not.toContain('--feed-url');
	});

	it('Windows: silent install, then verify win, then the smoke on the installed app', () => {
		const list = jobSteps['build-windows'];
		const install = list.find((s) => runs(s, 'node scripts/packaged-app.ts install dist-packaged'));
		expect(install).toBeDefined();
		const r = install!.run;
		const installAt = r.findIndex((l) => l.includes('packaged-app.ts install dist-packaged'));
		const verifyAt = r.indexOf('node scripts/verify-packaged.ts win dist-packaged');
		expect(verifyAt).toBeGreaterThan(installAt);
		expect(r.at(-1)).toBe('echo "PRICE_CHECK_PACKAGED_EXE=$exe" >> "$GITHUB_ENV"');
		const smoke = indexWhere(list, (s) => runs(s, SMOKE));
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
	it('publish needs exactly the tag and all three builds', () => {
		expect(wf.jobKey('publish', 'needs')).toEqual([
			'tag',
			'build-macos',
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
