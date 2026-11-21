// Pins how CI packages the desktop app and runs the packaged suites on every PR
// (05-release c-1, c-2, c-3, c-5, c-6; decisions artefacts, release_pipeline and
// update_flow): steps of the existing test job after the desktop e2e, never a job of
// their own (the required check names stay the same, see rulesets.spec). Every OS
// packages build A unsigned, verifies its layout, runs its OS checks (macOS lipo and
// libsql, Windows silent install then per-user/AUMID) and runs the packaged suites;
// Windows and Linux also package build B for the update test, served on the loopback
// feed's port. Linux runs under xvfb with the AppArmor userns sysctl, never
// --no-sandbox. The packaged suites run with the list reporter, so a failure's text
// attachments (the update test's diagnosis) reach the job log. Failures upload the
// packaged results and electron-builder's logs.
// SHA pins and permissions are `pnpm ci:policy`'s.
//
// The workflow is read by scripts/workflow-reader.ts (no YAML library). Which spec
// files each Playwright config collects is asked of Playwright itself (`--list`).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import packagedConfig from '../playwright.packaged.config.ts';
import { UPDATE_FEED_PORT } from './update-feed.ts';
import { block, map, readWorkflow, steps, type Step } from './workflow-reader.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

const OSES = ['Linux', 'macOS', 'Windows'] as const;
type Os = (typeof OSES)[number];

const DESKTOP_RUN = 'pnpm test:e2e:desktop';
const PACKAGED_RUN = 'pnpm test:e2e:packaged';
const PACKAGED_LIST = `${PACKAGED_RUN} --reporter=list`;
const PACKAGE = 'pnpm package:desktop';
const SYSCTL = 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0';
const LIBFUSE = 'sudo apt-get install -y libfuse2t64';
const FEED_URL = `http://127.0.0.1:${UPDATE_FEED_PORT}/`;
const FEED_DIR_ENV = 'PRICE_CHECK_UPDATE_FEED_DIR';
const MAC_VERIFY =
	'node scripts/verify-packaged.ts mac "dist-packaged/mac-universal/Price Check.app"';
const WIN_INSTALL = 'exe="$(node scripts/packaged-app.ts install dist-packaged)"';
const WIN_VERIFY = 'node scripts/verify-packaged.ts win dist-packaged';
const LOCATE = 'exe="$(node scripts/packaged-app.ts exe dist-packaged)"';
const layout = (mode: 'ci' | 'release') =>
	`node scripts/verify-packaged.ts layout dist-packaged --version "$PACKAGED_VERSION" --mode ${mode}`;

/** The packaged steps, in the order they must run. */
const STEP_NAMES = [
	'package',
	'verify packaged',
	'verify fuses',
	'package update build',
	'packaged e2e'
] as const;
type StepName = (typeof STEP_NAMES)[number];

type OsScript = {
	/** Lines before the case: run on every OS. */
	before: string[];
	arms: Record<Os, string[]>;
	/** Lines after esac: run on every OS. */
	after: string[];
};

/**
 * A step script as its per-OS arms. It must hold exactly one
 * `case "$RUNNER_OS" in … esac` with a Linux, a macOS and a Windows arm and a `*)` arm
 * that exits 1, each ended by `;;`, so every OS takes one of them and an unknown OS
 * fails. Null for any other shape.
 */
function osScript(run: string[]): OsScript | null {
	const start = run.indexOf('case "$RUNNER_OS" in');
	const end = run.indexOf('esac');
	const cases = run.filter((l) => /^case\b/.test(l)).length;
	const esacs = run.filter((l) => l === 'esac').length;
	if (start < 0 || end < start || cases !== 1 || esacs !== 1) return null;
	const arms: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of run.slice(start + 1, end)) {
		if (current === null) {
			const label = /^([^\s()]+)\)$/.exec(line)?.[1];
			if (label === undefined || label in arms) return null;
			current = label;
			arms[current] = [];
		} else if (line === ';;') current = null;
		else arms[current].push(line);
	}
	if (current !== null) return null;
	if (Object.keys(arms).sort().join() !== ['*', ...OSES].sort().join()) return null;
	if (!arms['*'].includes('exit 1')) return null;
	return {
		before: run.slice(0, start),
		arms: { Linux: arms.Linux, macOS: arms.macOS, Windows: arms.Windows },
		after: run.slice(end + 1)
	};
}

/** Every line one OS runs, in order. */
const linesFor = (script: OsScript, os: Os) => [
	...script.before,
	...script.arms[os],
	...script.after
];

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

/** The value of `--<flag> <value>` in a command line, or undefined. */
const flag = (line: string, name: string) =>
	new RegExp(`(?:^|\\s)--${name} (\\S+)`).exec(line)?.[1];

const stepEnv = (s: Step) => map(block(s.lines, 'env', 8));

// Read afresh before each test, never at collection: the reader's mutants then count
// as covered by the tests that use it (Stryker treats load-time coverage as static).
let lines: string[];
let testJob: string[];
let testSteps: Step[];
let named: Record<StepName, Step[]>;
let scripts: Record<StepName, OsScript | null>;
beforeEach(() => {
	const workflow = readWorkflow(ci, 'ci.yml');
	lines = workflow.lines;
	testJob = workflow.job('test');
	testSteps = steps(testJob);
	named = Object.fromEntries(
		STEP_NAMES.map((name) => [name, testSteps.filter((s) => s.get('name') === name)])
	) as Record<StepName, Step[]>;
	scripts = Object.fromEntries(
		STEP_NAMES.map((name) => [name, osScript(named[name][0]?.run ?? [])])
	) as Record<StepName, OsScript | null>;
});

const step = (name: StepName) => named[name][0];
const arm = (name: StepName, os: Os) => scripts[name]?.arms[os] ?? [];
const everyOs = (name: StepName, os: Os) => {
	const script = scripts[name];
	return script ? linesFor(script, os) : [];
};
const indexOfRun = (pred: (line: string) => boolean) =>
	testSteps.findIndex((s) => s.run.some(pred));

describe('the OS case reader', () => {
	const GOOD: Record<string, string[]> = {
		Linux: ['l1', 'l2'],
		macOS: ['mac'],
		Windows: ['win'],
		'*': ['exit 1']
	};
	/** A case over `arms`, label by label, each ended by `;;`. */
	const caseOf = (arms: Record<string, string[]>) => [
		'case "$RUNNER_OS" in',
		...Object.entries(arms).flatMap(([label, body]) => [`${label})`, ...body, ';;']),
		'esac'
	];
	const without = (label: string) =>
		Object.fromEntries(Object.entries(GOOD).filter(([key]) => key !== label));

	it('reads the lines before, each arm and the lines after', () => {
		expect(osScript(['a', ...caseOf(GOOD), 'z'])).toEqual({
			before: ['a'],
			arms: { Linux: ['l1', 'l2'], macOS: ['mac'], Windows: ['win'] },
			after: ['z']
		});
	});

	it('refuses a script with no case, or an if/else', () => {
		expect(osScript(['pnpm x'])).toBeNull();
		expect(osScript(['if [ "$RUNNER_OS" = "Linux" ]; then', 'a', 'else', 'b', 'fi'])).toBeNull();
	});

	it.each(['Linux', 'macOS', 'Windows', '*'])('refuses a case without the %s arm', (label) => {
		expect(osScript(caseOf(without(label)))).toBeNull();
	});

	it('refuses an extra arm, or one OS twice', () => {
		expect(osScript(caseOf({ ...GOOD, Darwin: ['x'] }))).toBeNull();
		const twice = caseOf(GOOD);
		twice.splice(1, 0, 'Linux)', 'x', ';;');
		expect(osScript(twice)).toBeNull();
	});

	it('refuses a catch-all that does not fail, or an unterminated arm', () => {
		expect(osScript(caseOf({ ...GOOD, '*': ['true'] }))).toBeNull();
		const open = caseOf(GOOD);
		open.splice(open.lastIndexOf(';;'), 1);
		expect(osScript(open)).toBeNull();
	});

	it('refuses a second case', () => {
		expect(osScript([...caseOf(GOOD), ...caseOf(GOOD)])).toBeNull();
	});
});

describe('ci.yml runs the packaged steps in the test job on every OS (c-1)', () => {
	it('adds steps, not a job: the jobs are still static, gitleaks and test', () => {
		expect(jobIds(lines)).toEqual(['static', 'gitleaks', 'test']);
	});

	it('gives the test job 75 minutes', () => {
		expect(testJob).toContain('    timeout-minutes: 75');
	});

	it.each(STEP_NAMES)('%s: one step, no if or continue-on-error, an arm per OS', (name) => {
		expect(named[name]).toHaveLength(1);
		const s = step(name);
		expect(s.get('if')).toBeUndefined();
		expect(s.get('continue-on-error')).toBeUndefined();
		expect(scripts[name], s.run.join('\n')).not.toBeNull();
		// An arm that leaves early would skip what follows it.
		for (const os of OSES) {
			expect(everyOs(name, os).filter((l) => /^(exit|return)\b/.test(l))).toEqual([]);
		}
	});

	it('runs after the desktop e2e, in order: package, verify, fuses, update build, packaged e2e', () => {
		const desktop = indexOfRun((l) => l.includes(DESKTOP_RUN));
		expect(desktop).toBeGreaterThanOrEqual(0);
		const order = STEP_NAMES.map((name) => step(name).index);
		expect(order[0]).toBeGreaterThan(desktop);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(new Set(order).size).toBe(order.length);
	});

	it.each(OSES)('%s packages build A at package.json version', (os) => {
		const run = everyOs('package', os);
		expect(run).toContain(`version="$(node -p 'require("./package.json").version')"`);
		expect(run).toContain('echo "PACKAGED_VERSION=$version" >> "$GITHUB_ENV"');
		const packages = run.filter((l) => l.startsWith(PACKAGE));
		expect(packages).toHaveLength(1);
		expect(flag(packages[0], 'version')).toBe('"$version"');
		expect(flag(packages[0], 'out')).toBeUndefined();
	});

	it.each(OSES)('%s verifies the layout and locates the app', (os) => {
		const run = everyOs('verify packaged', os);
		expect(run).toContain(layout(os === 'macOS' ? 'release' : 'ci'));
		expect(run.filter((l) => l.startsWith('exe='))).toHaveLength(1);
		expect(run.at(-1)).toBe('echo "PRICE_CHECK_PACKAGED_EXE=$exe" >> "$GITHUB_ENV"');
	});

	it.each(OSES)('%s runs pnpm test:e2e:packaged', (os) => {
		expect(everyOs('packaged e2e', os).some((l) => l.endsWith(PACKAGED_LIST))).toBe(true);
		expect(stepEnv(step('packaged e2e')).CI).toBe('true');
	});

	it.each(OSES)('%s runs the packaged suites with the list reporter only', (os) => {
		const runs = everyOs('packaged e2e', os).filter((l) => l.includes(PACKAGED_RUN));
		expect(runs).toHaveLength(1);
		const reporters = [...runs[0].matchAll(/--reporter[= ](\S+)/g)].map((m) => m[1]);
		expect(reporters, runs[0]).toEqual(['list']);
	});
});

// 06-remediate-security c-8, c-22: the fuses hold in the binary the packaged suites
// launch, checked before they run; Linux reads the unpacked executable, since the
// AppImage's compressed squashfs hides the wire.
describe('the fuses are checked on every OS before the packaged suites', () => {
	const FUSES = 'node scripts/verify-packaged.ts fuses';

	it.each(OSES)('%s verifies the fuses of the binary it launches', (os) => {
		const run = everyOs('verify fuses', os).filter((l) => l.startsWith(FUSES));
		expect(run).toEqual([
			os === 'Linux'
				? `${FUSES} dist-packaged/linux-unpacked/price-check-app`
				: `${FUSES} "$PRICE_CHECK_PACKAGED_EXE"`
		]);
	});

	it('checks the fuses after the exe is located and before the packaged e2e', () => {
		expect(step('verify fuses').index).toBeGreaterThan(step('verify packaged').index);
		expect(step('verify fuses').index).toBeLessThan(step('packaged e2e').index);
	});
});

describe('PR builds never sign', () => {
	it('only the two package steps call package:desktop', () => {
		const calls = testSteps.filter((s) => s.run.some((l) => l.includes(PACKAGE)));
		expect(calls.map((s) => s.get('name'))).toEqual(['package', 'package update build']);
		expect(readWorkflow(ci, 'ci.yml').job('static').join('\n')).not.toContain(PACKAGE);
	});

	it.each(['package', 'package update build'] as const)(
		'%s: never --sign, identity auto-discovery off',
		(name) => {
			const s = step(name);
			for (const line of s.run.filter((l) => l.includes(PACKAGE))) {
				expect(line).not.toMatch(/--sign\b/);
			}
			expect(stepEnv(s).CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
		}
	);

	it('ci.yml reads no secret and no signing certificate', () => {
		expect(ci).not.toMatch(/\bsecrets\./);
		expect(ci).not.toContain('CSC_LINK');
	});

	it('ci.yml passes --sign nowhere outside a comment', () => {
		const code = lines.filter((l) => !/^\s*#/.test(l));
		expect(code.filter((l) => /--sign\b/.test(l))).toEqual([]);
	});
});

describe('the OS checks on every PR (c-2, c-3)', () => {
	it('macOS checks the universal app and both libsql binaries, unsigned', () => {
		const mac = arm('verify packaged', 'macOS');
		expect(mac).toContain(MAC_VERIFY);
		expect(mac).toContain(LOCATE);
		expect(ci).not.toContain('--signed');
	});

	it('Windows installs silently, then checks the per-user install and the AUMID', () => {
		const win = arm('verify packaged', 'Windows');
		const install = win.indexOf(WIN_INSTALL);
		expect(install).toBeGreaterThanOrEqual(0);
		expect(win.indexOf(WIN_VERIFY)).toBeGreaterThan(install);
		expect(win).not.toContain(LOCATE);
	});

	it('Linux installs FUSE 2 for the AppImage and locates it', () => {
		const linux = arm('verify packaged', 'Linux');
		expect(linux).toContain(LIBFUSE);
		expect(linux).toContain(LOCATE);
	});
});

describe('the update test runs on Windows and Linux only (c-5, c-6)', () => {
	it('every --feed-url is the loopback feed on UPDATE_FEED_PORT', () => {
		const urls = [...ci.matchAll(/--feed-url (\S+)/g)].map((m) => m[1]);
		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) expect(url).toBe(FEED_URL);
	});

	it('build A bakes the feed in on Windows and Linux, never on macOS', () => {
		for (const os of ['Linux', 'Windows'] as const) {
			const line = arm('package', os).find((l) => l.startsWith(PACKAGE)) ?? '';
			expect(flag(line, 'feed-url'), line).toBe(FEED_URL);
		}
		expect(everyOs('package', 'macOS').join('\n')).not.toContain('--feed-url');
	});

	it('build B is never packaged on macOS, and macOS gets no feed dir', () => {
		expect(everyOs('package update build', 'macOS').some((l) => l.includes(PACKAGE))).toBe(false);
		for (const name of STEP_NAMES) {
			expect(everyOs(name, 'macOS').join('\n')).not.toContain(FEED_DIR_ENV);
		}
		expect(map(block(testJob, 'env', 4))[FEED_DIR_ENV]).toBeUndefined();
	});

	it.each(['Linux', 'Windows'] as const)(
		'%s packages B with the feed into the dir it sets as PRICE_CHECK_UPDATE_FEED_DIR',
		(os) => {
			const run = everyOs('package update build', os);
			const packages = run.filter((l) => l.startsWith(PACKAGE));
			expect(packages).toHaveLength(1);
			const [line] = packages;
			expect(flag(line, 'version')).toBe('"$update"');
			expect(flag(line, 'feed-url')).toBe(FEED_URL);
			const out = flag(line, 'out');
			expect(out).toBeDefined();
			const sets = run.filter((l) => l.includes(`${FEED_DIR_ENV}=`));
			expect(sets).toEqual([`echo "${FEED_DIR_ENV}=$GITHUB_WORKSPACE/${out}" >> "$GITHUB_ENV"`]);
			expect(run.indexOf(sets[0])).toBeGreaterThan(run.indexOf(line));
		}
	);

	it('B is the next patch of package.json version', () => {
		const assign = everyOs('package update build', 'Linux').find((l) => l.startsWith('update='));
		const script = /^update="\$\(node -p '(.*)'\)"$/.exec(assign ?? '')?.[1];
		expect(script, assign).toBeDefined();
		const result = spawnSync(process.execPath, ['-p', script ?? ''], {
			cwd: ROOT,
			encoding: 'utf8'
		});
		expect(result.status, result.stderr).toBe(0);
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
		const [major, minor, patch] = pkg.version.split('.');
		expect(result.stdout.trim()).toBe(`${major}.${minor}.${Number(patch) + 1}`);
	});

	it('update.packaged.ts skips macOS and runs only with a feed dir', () => {
		const spec = readFileSync(join(ROOT, 'e2e/packaged/update.packaged.ts'), 'utf8');
		expect(spec).toMatch(/^\s*test\.skip\(platform === 'darwin', /m);
		expect(spec).toMatch(/^\s*test\.skip\(!feedDir, /m);
		expect(spec).toContain(`const UPDATE_FEED_DIR_ENV = '${FEED_DIR_ENV}';`);
	});
});

describe('Linux runs the packaged suites under xvfb with the sandbox on', () => {
	it('runs xvfb-run -a pnpm test:e2e:packaged after the userns sysctl and libfuse2t64', () => {
		const run = arm('packaged e2e', 'Linux');
		const sysctl = run.indexOf(SYSCTL);
		const xvfb = run.indexOf(`xvfb-run -a ${PACKAGED_LIST}`);
		expect(sysctl).toBeGreaterThanOrEqual(0);
		expect(xvfb).toBeGreaterThan(sysctl);
		for (const line of everyOs('packaged e2e', 'Linux').filter((l) => l.includes(PACKAGED_RUN)))
			expect(line).toBe(`xvfb-run -a ${PACKAGED_LIST}`);
		// FUSE 2 is installed by the verify step, which runs before this one.
		expect(arm('verify packaged', 'Linux')).toContain(LIBFUSE);
		expect(step('verify packaged').index).toBeLessThan(step('packaged e2e').index);
	});

	it('runs macOS and Windows without xvfb-run', () => {
		expect(everyOs('packaged e2e', 'macOS')).toEqual([PACKAGED_LIST]);
		expect(everyOs('packaged e2e', 'Windows')).toEqual([PACKAGED_LIST]);
	});

	const packagedFiles = readdirSync(join(ROOT, 'e2e/packaged'), {
		recursive: true,
		encoding: 'utf8'
	})
		.filter((f) => f.endsWith('.ts'))
		.map((f) => join('e2e/packaged', f));

	it('has packaged sources to check', () => {
		expect(packagedFiles.length).toBeGreaterThan(0);
	});

	it('ci.yml never passes --no-sandbox', () => {
		expect(ci).not.toContain('--no-sandbox');
	});

	/**
	 * The only code lines in e2e/packaged that may name a Node inspector switch: the
	 * smoke's detector for one in argv, and the switch its 'inspector refused' probe
	 * passes to prove the CLI inspect fuse ignores it (06-remediate-security c-22).
	 */
	const INSPECT_ALLOWED: Record<string, string[]> = {
		'e2e/packaged/smoke.packaged.ts': [
			'const INSPECT = /^--inspect/;',
			"const INSPECT_ANY_PORT = '--inspect=0';"
		]
	};

	it.each(packagedFiles)('%s neither uses _electron nor passes --inspect', (file) => {
		const code = readFileSync(join(ROOT, file), 'utf8')
			.split(/\r?\n/)
			.filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
			.map((l) => l.trim());
		expect(code.filter((l) => /\b_electron\b/.test(l))).toEqual([]);
		const allowed = INSPECT_ALLOWED[file.split(sep).join('/')] ?? [];
		expect(code.filter((l) => /--inspect/.test(l) && !allowed.includes(l))).toEqual([]);
	});

	it("passes --inspect=0 only inside smoke's 'inspector refused' test", () => {
		const smoke = readFileSync(join(ROOT, 'e2e/packaged/smoke.packaged.ts'), 'utf8').split(/\r?\n/);
		const start = smoke.findIndex((l) => /^\s*test\('inspector refused'/.test(l));
		expect(start).toBeGreaterThan(-1);
		const next = smoke.findIndex((l, i) => i > start && /^\s*test\(/.test(l));
		const uses = smoke
			.map((l, i) => ({ l, i }))
			.filter(({ l }) => /\bINSPECT_ANY_PORT\b/.test(l) && !/^\s*const INSPECT_ANY_PORT\b/.test(l));
		expect(uses.length).toBeGreaterThan(0);
		for (const { l, i } of uses) {
			expect(i > start && (next === -1 || i < next), `line ${i + 1}: ${l.trim()}`).toBe(true);
		}
		// No other file names it at all.
		for (const file of packagedFiles.filter((f) => !f.endsWith('smoke.packaged.ts'))) {
			expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(/\bINSPECT_ANY_PORT\b/);
		}
	});

	it.each(packagedFiles)('%s never passes --no-sandbox outside a comment', (file) => {
		const code = readFileSync(join(ROOT, file), 'utf8')
			.split(/\r?\n/)
			.filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
		expect(code.filter((l) => l.includes('--no-sandbox'))).toEqual([]);
	});
});

/** Repo-relative, '/'-separated paths of the spec files a Playwright config collects. */
function collected(config: string): string[] {
	const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
	const result = spawnSync(
		process.execPath,
		[cli, 'test', '--list', '--config', config, '--reporter=json'],
		{ cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
	);
	if (result.status !== 0) {
		throw new Error(
			`playwright --list --config ${config} exited ${result.status}: ${result.stderr}`
		);
	}
	type Suite = { file?: string; suites?: Suite[] };
	const report = JSON.parse(result.stdout) as {
		config: { rootDir: string };
		suites: Suite[];
		errors: unknown[];
	};
	if (report.errors.length > 0) {
		throw new Error(`playwright --list --config ${config}: ${JSON.stringify(report.errors)}`);
	}
	const files = (suite: Suite): string[] => [
		...(suite.file ? [suite.file] : []),
		...(suite.suites ?? []).flatMap(files)
	];
	return [...new Set(report.suites.flatMap(files))]
		.map((file) => relative(ROOT, join(report.config.rootDir, file)).split(sep).join('/'))
		.sort();
}

describe('the Playwright configs keep the packaged suites apart', () => {
	const lists: Record<string, string[]> = {};
	beforeAll(() => {
		for (const config of [
			'playwright.config.ts',
			'playwright.desktop.config.ts',
			'playwright.packaged.config.ts'
		]) {
			lists[config] = collected(config);
		}
	}, 120_000);

	it.each(['playwright.config.ts', 'playwright.desktop.config.ts'])(
		'%s collects no e2e/packaged file',
		(config) => {
			expect(lists[config].length).toBeGreaterThan(0);
			expect(lists[config].filter((f) => f.startsWith('e2e/packaged/'))).toEqual([]);
		}
	);

	it('playwright.packaged.config.ts collects the smoke and the update test, nothing else', () => {
		expect(lists['playwright.packaged.config.ts']).toEqual([
			'e2e/packaged/smoke.packaged.ts',
			'e2e/packaged/update.packaged.ts'
		]);
	});

	it('uploads the packaged results and the dist-packaged logs on failure', () => {
		const upload = testSteps.find((s) => s.get('uses')?.startsWith('actions/upload-artifact@'));
		expect(upload).toBeDefined();
		expect(upload?.get('if')).toBe('failure()');
		expect(upload!.index).toBeGreaterThan(step('packaged e2e').index);
		const paths = upload!.lines
			.map((l) => /^ {12}(\S.*?)\/?\s*$/.exec(l)?.[1])
			.filter((p): p is string => !!p);
		const outputDir = packagedConfig.outputDir ?? '';
		expect(outputDir).not.toBe('');
		expect(
			paths.some((p) => outputDir === p || outputDir.startsWith(`${p}/`)),
			`${outputDir} under one of ${paths.join(', ')}`
		).toBe(true);
		// builder-debug.yml, the latest*.yml files and each app's app-update.yml.
		expect(paths).toContain('dist-packaged/**/*.yml');
	});
});
