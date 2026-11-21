import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	checkWorkflow,
	P8_TRAP,
	runPolicyCli,
	SIGNING_SECRETS,
	WRITE_SCOPE_ALLOWLIST
} from './workflow-policy.ts';

const SHA = 'a'.repeat(40);

/** A minimal valid workflow with one job; `jobExtra` / `steps` are spliced in. */
function workflow({
	top = 'permissions:\n  contents: read\n',
	jobExtra = '',
	steps = `      - uses: actions/checkout@${SHA} # v6.0.0\n`
}: { top?: string; jobExtra?: string; steps?: string } = {}): string {
	return `name: ci\non:\n  pull_request:\n${top}jobs:\n  build:\n    runs-on: ubuntu-24.04\n${jobExtra}    steps:\n${steps}`;
}

const messages = (file: string, text: string, allowlist?: Record<string, readonly string[]>) =>
	checkWorkflow(file, text, allowlist).map((v) => v.message);

describe('unpinned uses', () => {
	it.each([
		['a tag', 'actions/checkout@v4'],
		['a branch', 'actions/checkout@main'],
		['a 7-char short SHA', 'actions/checkout@8edcb1b'],
		['an uppercase SHA', `actions/checkout@${'A'.repeat(40)}`],
		['no ref at all', 'actions/checkout'],
		['a docker tag', 'docker://alpine:3.20'],
		['a quoted tag', '"actions/checkout@v4"']
	])('rejects %s', (_name, ref) => {
		const out = messages('ci.yml', workflow({ steps: `      - uses: ${ref}\n` }));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatch(/not pinned/);
	});

	it.each([
		['a 40-hex SHA', `actions/checkout@${SHA}`],
		['a SHA with a tag comment', `actions/checkout@${SHA} # v6.0.0`],
		['a sub-path action', `github/codeql-action/init@${SHA}`],
		['a local action', './.github/actions/x'],
		['a docker digest', `docker://alpine@sha256:${'b'.repeat(64)}`]
	])('accepts %s', (_name, ref) => {
		expect(messages('ci.yml', workflow({ steps: `      - uses: ${ref}\n` }))).toEqual([]);
	});

	it.each([
		['name: >-', '      - name: >-\n          Checkout\n        uses: actions/checkout@v4\n'],
		[
			'if: |',
			'      - if: |\n          github.event_name == 1\n        uses: actions/checkout@v4\n'
		]
	])('still checks a step sibling after a leading %s block scalar', (_name, steps) => {
		const out = messages('ci.yml', workflow({ steps }));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatch(/not pinned/);
	});

	it('ignores uses: text inside a run block scalar', () => {
		const steps = `      - run: |\n          echo "uses: actions/checkout@v4"\n          echo "permissions: write-all"\n`;
		expect(messages('ci.yml', workflow({ steps }))).toEqual([]);
	});

	it('does not flag a step name that merely mentions permissions', () => {
		const steps = `      - name: Check permissions are read-only\n        run: true\n`;
		expect(messages('ci.yml', workflow({ steps }))).toEqual([]);
	});
});

describe('permissions', () => {
	it.each([
		['no top-level permissions block', ''],
		['permissions: write-all', 'permissions: write-all\n'],
		['permissions: read-all', 'permissions: read-all\n'],
		['top-level contents: write', 'permissions:\n  contents: write\n'],
		['top-level extra scope', 'permissions:\n  contents: read\n  pull-requests: write\n'],
		['top-level {}', 'permissions: {}\n']
	])('rejects %s', (_name, top) => {
		expect(messages('ci.yml', workflow({ top }))).not.toEqual([]);
	});

	it.each([
		['pull-requests: write', '    permissions:\n      pull-requests: write\n'],
		['id-token: write', '    permissions:\n      id-token: write\n'],
		['contents: write', '    permissions:\n      contents: write\n'],
		['packages: read', '    permissions:\n      packages: read\n'],
		['write-all', '    permissions: write-all\n']
	])('rejects job-level %s', (_name, jobExtra) => {
		expect(messages('ci.yml', workflow({ jobExtra }))).not.toEqual([]);
	});

	it.each([
		['{}', '    permissions: {}\n'],
		['contents: read', '    permissions:\n      contents: read\n'],
		['contents: none', '    permissions:\n      contents: none\n']
	])('accepts job-level %s', (_name, jobExtra) => {
		expect(messages('ci.yml', workflow({ jobExtra }))).toEqual([]);
	});

	it('accepts the minimal valid workflow', () => {
		expect(messages('ci.yml', workflow())).toEqual([]);
	});
});

describe('fails closed', () => {
	it.each([
		['flow-style top-level permissions', workflow({ top: 'permissions: { contents: write }\n' })],
		[
			'flow-style job permissions',
			workflow({ jobExtra: '    permissions: { contents: write }\n' })
		],
		['an empty permissions key', workflow({ top: 'permissions:\n' })],
		['nested permissions block', workflow({ top: 'permissions:\n  contents:\n    deep: read\n' })],
		[
			'permissions inside a step',
			workflow({
				steps: `      - uses: actions/checkout@${SHA}\n        with:\n          permissions: write\n`
			})
		],
		[
			'a flow-style jobs map',
			`on: pull_request\npermissions:\n  contents: read\njobs: { build: { permissions: write-all } }\n`
		],
		['a flow-style uses', workflow({ steps: '      - { uses: actions/checkout@v4 }\n' })],
		['tab indentation', workflow().replace('    runs-on', '\truns-on')]
	])('rejects %s', (_name, text) => {
		expect(messages('ci.yml', text)).not.toEqual([]);
	});
});

describe('locates', () => {
	it('reports the file name and the 1-based line of the offending line', () => {
		const text = workflow({ steps: `      - uses: actions/checkout@v4\n` });
		const line = text.split('\n').findIndex((l) => l.includes('@v4')) + 1;
		expect(checkWorkflow('.github/workflows/ci.yml', text)).toEqual([
			expect.objectContaining({ file: '.github/workflows/ci.yml', line })
		]);
	});

	it('reports a missing top-level permissions block at line 1', () => {
		expect(checkWorkflow('ci.yml', workflow({ top: '' }))).toEqual([
			expect.objectContaining({ line: 1, message: expect.stringMatching(/missing/) })
		]);
	});
});

describe('write-scope allowlist', () => {
	const job = (scope: string) =>
		workflow({ jobExtra: `    permissions:\n      ${scope}: write\n` });
	const allow = { 'release.yml': ['contents'] } as const;

	it("allowlist: only release.yml, and only contents (its publish job's write)", () => {
		expect(WRITE_SCOPE_ALLOWLIST).toEqual({ 'release.yml': ['contents'] });
	});

	it('the shipped allowlist lets release.yml write contents and nothing else', () => {
		expect(messages('.github/workflows/release.yml', job('contents'))).toEqual([]);
		expect(messages('.github/workflows/release.yml', job('packages'))).toEqual([
			'job-level permissions may not grant packages: write'
		]);
		expect(messages('.github/workflows/ci.yml', job('contents'))).toEqual([
			'job-level permissions may not grant contents: write'
		]);
		expect(messages('.github/workflows/audit.yml', job('contents'))).toEqual([
			'job-level permissions may not grant contents: write'
		]);
	});

	it('the shipped allowlist never lets release.yml write at workflow level', () => {
		const top = 'permissions:\n  contents: write\n';
		expect(messages('.github/workflows/release.yml', workflow({ top }))).toEqual([
			'workflow-level permissions must be exactly contents: read, found contents: write'
		]);
	});

	it('an empty allowlist still rejects every write scope', () => {
		expect(messages('release.yml', job('contents'), {})).toEqual([
			'job-level permissions may not grant contents: write'
		]);
	});

	it("lets a listed workflow's jobs write only its listed scopes", () => {
		expect(messages('.github/workflows/release.yml', job('contents'), allow)).toEqual([]);
		expect(messages('.github/workflows/release.yml', job('packages'), allow)).not.toEqual([]);
		expect(messages('.github/workflows/ci.yml', job('contents'), allow)).not.toEqual([]);
	});

	it('never allows a write scope at workflow level, even for a listed workflow', () => {
		const top = 'permissions:\n  contents: write\n';
		expect(messages('release.yml', workflow({ top }), allow)).not.toEqual([]);
	});
});

describe('cli exit', () => {
	let dir = '';
	const lines: string[] = [];
	const log = (line: string) => lines.push(line);
	const fresh = () => {
		dir = mkdtempSync(join(tmpdir(), 'workflow-policy-'));
		lines.length = 0;
		return dir;
	};
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('returns 1 when the directory holds no workflow file', () => {
		writeFileSync(join(fresh(), 'README.md'), '# not a workflow\n');
		expect(runPolicyCli(dir, log)).toBe(1);
		expect(lines.join('\n')).toMatch(/no workflow files/);
	});

	it('returns 1 when the directory does not exist', () => {
		expect(runPolicyCli(join(fresh(), 'missing'), log)).toBe(1);
	});

	it('returns 1 and names file:line when one file has a violation', () => {
		writeFileSync(join(fresh(), 'good.yml'), workflow());
		writeFileSync(
			join(dir, 'bad.yaml'),
			workflow({ steps: '      - uses: actions/checkout@v4\n' })
		);
		expect(runPolicyCli(dir, log)).toBe(1);
		expect(lines.some((l) => /bad\.yaml:\d+: .*not pinned/.test(l))).toBe(true);
	});

	it('returns 0 when every workflow file is clean', () => {
		writeFileSync(join(fresh(), 'ci.yml'), workflow());
		mkdirSync(join(dir, 'nested.yml'));
		expect(runPolicyCli(dir, log)).toBe(0);
	});

	it('passes the allowlist through to the checker', () => {
		writeFileSync(
			join(fresh(), 'release.yml'),
			workflow({ jobExtra: '    permissions:\n      contents: write\n' })
		);
		expect(runPolicyCli(dir, log, {})).toBe(1);
		expect(runPolicyCli(dir, log, { 'release.yml': ['contents'] })).toBe(0);
	});

	it('defaults to the shipped allowlist', () => {
		writeFileSync(
			join(fresh(), 'release.yml'),
			workflow({ jobExtra: '    permissions:\n      contents: write\n' })
		);
		writeFileSync(
			join(dir, 'ci.yml'),
			workflow({ jobExtra: '    permissions:\n      contents: write\n' })
		);
		expect(runPolicyCli(dir, log)).toBe(1);
		expect(lines.filter((l) => /write/.test(l))).toEqual([
			`${join(dir, 'ci.yml')}:10: job-level permissions may not grant contents: write`
		]);
	});
});

// Verify (2026-11-11) left survivors behind tests that only asserted "some violation".
// These pin the exact line and message for each path, plus the false negatives the
// mutants exposed.
describe('exact reports', () => {
	const PIN = `actions/checkout@${SHA}`;
	const NOT_PINNED = (ref: string) =>
		`uses: '${ref}' is not pinned to a full commit SHA (or sha256 digest)`;
	const UNCLASSIFIED_USES = 'uses reference cannot be classified';
	const MISPLACED = 'permissions in a place the policy cannot classify';
	const MISSING = 'workflow-level permissions block is missing (need contents: read)';
	const TOP = 'permissions:\n  contents: read\n';

	/** [line, message] pairs, in reported order. */
	const report = (text: string, allowlist?: Record<string, readonly string[]>, file = 'ci.yml') =>
		checkWorkflow(file, text, allowlist).map((v) => [v.line, v.message]);
	const lineOf = (text: string, needle: string) =>
		text.split('\n').findIndex((l) => l.includes(needle)) + 1;
	/** A workflow whose only job has the given steps block (6-space step indent). */
	const steps = (body: string) =>
		`name: ci\non: pull_request\n${TOP}jobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;

	it('carries file, line and message on every violation', () => {
		const text = steps('      - uses: actions/checkout@v4\n');
		expect(checkWorkflow('w/ci.yml', text)).toEqual([
			{ file: 'w/ci.yml', line: lineOf(text, '@v4'), message: NOT_PINNED('actions/checkout@v4') }
		]);
	});

	describe('uses refs', () => {
		it.each([
			['a ref with a space before owner/repo', 'foo bar/baz@' + SHA],
			['a 41-hex ref', 'actions/checkout@' + SHA + 'a'],
			['a docker digest with a prefix', `x docker://alpine@sha256:${'b'.repeat(64)}`],
			['a docker digest with a suffix', `docker://alpine@sha256:${'b'.repeat(64)}x`],
			['mismatched quotes', `"${PIN}'`]
		])('rejects %s, quoting the ref', (_name, ref) => {
			const text = steps(`      - uses: ${ref}\n`);
			expect(report(text)).toEqual([[lineOf(text, 'uses:'), NOT_PINNED(ref)]]);
		});

		it.each([
			['double quotes', `"${PIN}"`],
			['single quotes', `'${PIN}'`]
		])('unquotes a pinned ref in %s', (_name, ref) => {
			expect(report(steps(`      - uses: ${ref}\n`))).toEqual([]);
		});

		it('reports the unquoted ref of a quoted unpinned one', () => {
			const text = steps('      - uses: "actions/checkout@v4"\n');
			expect(report(text)).toEqual([[lineOf(text, 'uses:'), NOT_PINNED('actions/checkout@v4')]]);
		});

		it('reports an empty uses:', () => {
			const text = steps('      - uses:\n');
			expect(report(text)).toEqual([[lineOf(text, 'uses:'), NOT_PINNED('')]]);
		});

		it('reads a uses: key with a space before the colon', () => {
			const text = steps('      - uses : actions/checkout@v4\n');
			expect(report(text)).toEqual([[lineOf(text, 'uses'), NOT_PINNED('actions/checkout@v4')]]);
		});

		it('keeps a hyphenated ref intact when uses: is not the first key of a step', () => {
			const text = steps('      - name: x\n        uses: my-org/my-action@v4\n');
			expect(report(text)).toEqual([[lineOf(text, 'uses:'), NOT_PINNED('my-org/my-action@v4')]]);
		});

		it('keeps the ref intact after a dash with extra spaces', () => {
			const text = steps('      -   uses: actions/checkout@v4\n');
			expect(report(text)).toEqual([[lineOf(text, 'uses:'), NOT_PINNED('actions/checkout@v4')]]);
		});

		it.each([
			['no space after the colon', '      - uses:actions/checkout@v4\n'],
			['flow style', '      - { uses: actions/checkout@v4 }\n'],
			['a double-quoted key in a list item', `      - "uses": ${PIN}\n`],
			['a single-quoted key in a list item', `      - 'uses': ${PIN}\n`],
			['a quoted key with a space before the colon', `      - "uses" : ${PIN}\n`],
			['a quoted key starting a line', `      - name: x\n        "uses": ${PIN}\n`]
		])('cannot classify %s', (_name, body) => {
			const text = steps(body);
			expect(report(text)).toEqual([[lineOf(text, 'uses'), UNCLASSIFIED_USES]]);
		});
	});

	describe('block scalars and comments', () => {
		const hidden = '          uses: actions/checkout@v4 permissions: write-all\n';

		it('still checks a later step after a run: | block', () => {
			const text = steps(`      - run: |\n${hidden}      - uses: actions/checkout@v4\n`);
			expect(report(text)).toEqual([
				[
					text.split('\n').lastIndexOf('      - uses: actions/checkout@v4') + 1,
					NOT_PINNED('actions/checkout@v4')
				]
			]);
		});

		it.each([
			['a |- chomping indicator', '      - run: |-\n'],
			['a >+ chomping indicator', '      - run: >+\n']
		])('skips the body of %s', (_name, head) => {
			expect(report(steps(`${head}${hidden}`))).toEqual([]);
		});

		it('keeps skipping the body across a whitespace-only line', () => {
			expect(report(steps(`      - run: |\n${hidden}  \n${hidden}`))).toEqual([]);
		});

		it('skips the body of a top-level block scalar', () => {
			const text = `name: ci\nrun-name: >\n  uses: actions/checkout@v4\n${TOP}on: pull_request\njobs:\n  build:\n    runs-on: x\n`;
			expect(report(text)).toEqual([]);
		});

		it('checks a sibling after a dash with extra spaces before a block scalar', () => {
			const text = steps(
				`      -   run: |\n            echo hi\n          uses: actions/checkout@v4\n`
			);
			expect(report(text)).toEqual([[lineOf(text, 'uses:'), NOT_PINNED('actions/checkout@v4')]]);
		});

		it('checks an indented first line', () => {
			const text = `    uses: actions/checkout@v4\n${TOP}`;
			expect(report(text)).toEqual([[1, NOT_PINNED('actions/checkout@v4')]]);
		});

		it('ignores a comment line that mentions uses:', () => {
			expect(report(steps(`      # uses: actions/checkout@v4\n      - uses: ${PIN}\n`))).toEqual(
				[]
			);
		});

		it('ignores a column-0 comment between jobs', () => {
			const text = `on: pull_request\n${TOP}jobs:\n  a:\n    runs-on: x\n# note\n  b:\n    permissions: {}\n    runs-on: x\n`;
			expect(report(text)).toEqual([]);
		});
	});

	describe('tabs', () => {
		it('reports a tab after leading spaces', () => {
			const text = steps('      - run: x\n  \tname: y\n');
			expect(checkWorkflow('ci.yml', text)).toContainEqual({
				file: 'ci.yml',
				line: lineOf(text, '\tname'),
				message: 'tab indentation cannot be classified'
			});
		});

		it('allows a tab inside a value', () => {
			expect(report(steps('      - run: echo "a\tb"\n'))).toEqual([]);
		});
	});

	describe('permissions', () => {
		const wf = (top: string) => `on: pull_request\n${top}jobs:\n  build:\n    runs-on: x\n`;
		const job = (perm: string) =>
			`on: pull_request\n${TOP}jobs:\n  build:\n    runs-on: x\n${perm}`;

		it.each([
			[
				'read-all',
				'permissions: read-all\n',
				'workflow-level permissions: read-all grants every scope'
			],
			[
				'write-all',
				'permissions: write-all\n',
				'workflow-level permissions: write-all grants every scope'
			],
			[
				'flow',
				'permissions: { contents: read }\n',
				'workflow-level flow-style permissions cannot be verified; use a block'
			],
			[
				'a scalar',
				'permissions: write\n',
				"workflow-level permissions: 'write' is not an allowed form"
			],
			[
				'{}',
				'permissions: {}\n',
				'workflow-level flow-style permissions cannot be verified; use a block'
			],
			[
				'actions: read',
				'permissions:\n  actions: read\n',
				'workflow-level permissions must be exactly contents: read, found actions: read'
			],
			[
				'contents: none',
				'permissions:\n  contents: none\n',
				'workflow-level permissions must be exactly contents: read, found contents: none'
			]
		])('workflow-level %s', (_name, top, message) => {
			const text = wf(top);
			const line = lineOf(text, top.includes('\n  ') ? top.split('\n')[1].trim() : 'permissions:');
			expect(report(text)).toEqual([[line, message]]);
		});

		it.each([
			['a misindented sibling', 'permissions:\n  contents: read\n    actions: write\n'],
			['a list child', 'permissions:\n  - contents\n'],
			['an empty block', 'permissions:\n']
		])('workflow-level block with %s cannot be classified', (_name, top) => {
			const text = wf(top);
			expect(report(text)).toEqual([
				[lineOf(text, 'permissions:'), 'workflow-level permissions block cannot be classified']
			]);
		});

		it('reads a permissions block at the end of the file', () => {
			expect(report(`on: pull_request\njobs:\n  build:\n    runs-on: x\n${TOP}`)).toEqual([]);
		});

		it.each([
			[
				'write-all',
				'    permissions: write-all\n',
				'job-level permissions: write-all grants every scope'
			],
			[
				'flow',
				'    permissions: { contents: write }\n',
				'job-level flow-style permissions cannot be verified; use a block'
			],
			[
				'pull-requests: write',
				'    permissions:\n      pull-requests: write\n',
				'job-level permissions may not grant pull-requests: write'
			]
		])('job-level %s', (_name, perm, message) => {
			const text = job(perm);
			const line = lineOf(
				text,
				perm.includes('\n      ') ? perm.split('\n')[1].trim() : perm.trimEnd()
			);
			expect(report(text)).toEqual([[line, message]]);
		});

		it('an allowlisted workflow may only write, not grant other values', () => {
			const allow = { 'release.yml': ['packages'] };
			const text = job('    permissions:\n      packages: read\n');
			expect(report(text, allow, 'release.yml')).toEqual([
				[lineOf(text, 'packages: read'), 'job-level permissions may not grant packages: read']
			]);
		});

		it.each([
			[
				'inside a step',
				steps(`      - uses: ${PIN}\n        with:\n          permissions: write\n`)
			],
			[
				'under on:',
				`on:\n  push:\n    permissions: write-all\n${TOP}jobs:\n  build:\n    runs-on: x\n`
			],
			['in a jobs list item', `on: pull_request\n${TOP}jobs:\n  - permissions: write-all\n`]
		])('misplaced %s', (_name, text) => {
			expect(report(text)).toEqual([[lineOf(text, 'permissions: write'), MISPLACED]]);
		});

		it.each([
			['double', '"permissions"'],
			['single', "'permissions'"],
			['spaced double', '"permissions" ']
		])(
			'a %s-quoted top-level permissions key is misplaced, and the real block missing',
			(_q, key) => {
				const text = `on: pull_request\n${key}: write-all\njobs:\n  build:\n    runs-on: x\n`;
				expect(report(text)).toEqual([
					[1, MISSING],
					[2, MISPLACED]
				]);
			}
		);

		it('finds a job-level block in a later job after a job with steps', () => {
			const text = `on: pull_request\n${TOP}jobs:\n  a:\n    steps:\n      - uses: ${PIN}\n        with:\n          x: y\n  b:\n    permissions:\n      contents: write\n`;
			expect(report(text)).toEqual([
				[lineOf(text, 'contents: write'), 'job-level permissions may not grant contents: write']
			]);
		});

		it('sorts violations by line', () => {
			const text = steps('      - uses: actions/checkout@v4\n').replace(TOP, '');
			expect(report(text)).toEqual([
				[1, MISSING],
				[lineOf(text, '@v4'), NOT_PINNED('actions/checkout@v4')]
			]);
		});
	});

	describe('cli', () => {
		let dir = '';
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		it('logs to stderr by default, one line per violation plus a summary', () => {
			dir = mkdtempSync(join(tmpdir(), 'workflow-policy-'));
			writeFileSync(join(dir, 'ci.yml'), steps('      - uses: actions/checkout@v4\n'));
			const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
			try {
				expect(runPolicyCli(dir)).toBe(1);
				const out = write.mock.calls.map((c) => String(c[0]));
				expect(out).toContain(`${join(dir, 'ci.yml')}:9: ${NOT_PINNED('actions/checkout@v4')}\n`);
				expect(out).toContain('ci:policy: 1 workflow file(s), 1 violation(s)\n');
			} finally {
				write.mockRestore();
			}
		});

		it('reads only *.yml / *.yaml files', () => {
			dir = mkdtempSync(join(tmpdir(), 'workflow-policy-'));
			writeFileSync(join(dir, 'ci.yml'), steps(`      - uses: ${PIN}\n`));
			writeFileSync(join(dir, 'README.md'), 'uses: actions/checkout@v4\n');
			writeFileSync(join(dir, 'ci.yml.bak'), 'uses: actions/checkout@v4\n');
			const lines: string[] = [];
			expect(runPolicyCli(dir, (l) => lines.push(l))).toBe(0);
			expect(lines).toEqual(['ci:policy: 1 workflow file(s), 0 violation(s)']);
		});

		it('runs as a separate process: exit 1 naming file:line, exit 0 when clean', () => {
			dir = mkdtempSync(join(tmpdir(), 'workflow-policy-'));
			const script = fileURLToPath(new URL('./workflow-policy.ts', import.meta.url));
			writeFileSync(join(dir, 'ci.yml'), steps('      - uses: actions/checkout@v4\n'));
			const bad = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
			expect(bad.status).toBe(1);
			expect(bad.stderr).toContain(`ci.yml:9: ${NOT_PINNED('actions/checkout@v4')}`);
			writeFileSync(join(dir, 'ci.yml'), steps(`      - uses: ${PIN}\n`));
			const good = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
			expect(good.status).toBe(0);
		});
	});
});

// Verify attempt 2 (2026-11-11): the last surviving mutants, each killed by one of
// these inputs. The checker already reports them correctly; these pin it.
describe('edge layouts', () => {
	const TOP = 'permissions:\n  contents: read\n';
	const report = (text: string) => checkWorkflow('ci.yml', text).map((v) => [v.line, v.message]);
	const steps = (body: string) =>
		`${TOP}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${body}`;

	it('reports permissions on a flow-mapping continuation line', () => {
		const text = `${TOP}jobs:\n  a: { runs-on: ubuntu-latest, name: "x:>y",\n       permissions: write-all, steps: [ { run: echo } ] }\n`;
		expect(report(text)).toEqual([
			[5, "job-level permissions: 'write-all, steps: [ { run: echo } ] }' is not an allowed form"]
		]);
	});

	it.each([
		['two spaces before the indicator', '      - run:  |\n'],
		['a trailing comment after the indicator', '      - run: |  # note\n']
	])('treats a block scalar with %s as a scalar', (_name, head) => {
		expect(report(steps(`${head}          echo "uses: foo"\n`))).toEqual([]);
	});

	it('refuses a lone-CR line after a comment instead of reading through it', () => {
		// A lone CR is a YAML line break, but the checker splits on \n only: the comment
		// strip must stop at the CR and leave the line unclassified (fail closed).
		const text = steps(`      - uses: # c\r          actions/checkout@${SHA}\n`);
		expect(report(text)).toEqual([[7, 'uses reference cannot be classified']]);
	});

	it("skips a hyphenated key's block scalar body", () => {
		const body =
			'      - uses: ./local\n        with:\n          my-input: |\n           permissions: write-all\n';
		expect(report(steps(body))).toEqual([]);
	});

	it.each([
		['contents: read', '    permissions:\n      contents: read\n', []],
		[
			'write-all',
			'    permissions: write-all\n',
			[[8, 'job-level permissions: write-all grants every scope']]
		]
	] as const)('classifies job-level %s after indentless steps', (_name, perm, expected) => {
		expect(report(steps(`    - run: echo hi\n${perm}`))).toEqual(expected);
	});
});

// c-26 and c-15 (decision signing_job_split): what a job holding the signing secrets
// may run, and the decoded .p8's cleanup. Fixtures pin every action, so the only
// violations are the rule under test.
describe('secret-bearing jobs', () => {
	const PINNED = (action: string) => `${action}@${SHA}`;
	const TOP = 'permissions:\n  contents: read\n';
	const SECRET_ENV = SIGNING_SECRETS.map((n) => `          ${n}: \${{ secrets.${n} }}\n`).join('');
	const block = (lines: string[]) => lines.map((l) => `          ${l}\n`).join('');
	const SIGN_LINES = [
		'set -euo pipefail',
		'umask 077',
		P8_TRAP,
		`printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$RUNNER_TEMP/AuthKey.p8"`,
		'export APPLE_API_KEY="$RUNNER_TEMP/AuthKey.p8"',
		'node scripts/sign-mac.ts --version "$RELEASE_VERSION" --app "dist-packaged/mac-universal/Price Check.app"'
	];
	/** release.yml's check of the downloaded tar before it unpacks it (SEC-18). */
	const UNPACK_LINES = [
		'set -euo pipefail',
		'shopt -s nullglob dotglob',
		'set -- "$RUNNER_TEMP/macos-unsigned"/*',
		'test "$#" -eq 1',
		'test "$1" = "$RUNNER_TEMP/macos-unsigned/mac-unsigned.tar"',
		'test -f "$1"',
		'test ! -L "$1"',
		`printf '%s  %s\\n' "$UNSIGNED_SHA256" "$1" | shasum -a 256 -c --strict -`,
		'mkdir -p dist-packaged',
		'tar -xf "$RUNNER_TEMP/macos-unsigned/mac-unsigned.tar" -C dist-packaged'
	];
	const DOWNLOAD = (withLines: string) =>
		`      - uses: ${PINNED('actions/download-artifact')}\n        with:\n${withLines}`;
	const UNSIGNED_DOWNLOAD = DOWNLOAD(
		'          name: macos-unsigned\n          path: ${{ runner.temp }}/macos-unsigned\n'
	);
	/** release.yml's sign-macos steps, `insert` spliced in after the sign step. */
	const signSteps = (insert = '', signLines = SIGN_LINES, download = UNSIGNED_DOWNLOAD) =>
		[
			`      - uses: ${PINNED('actions/checkout')}\n        with:\n          persist-credentials: false\n`,
			`      - uses: ${PINNED('pnpm/action-setup')}\n`,
			`      - uses: ${PINNED('actions/setup-node')}\n        with:\n          node-version-file: .node-version\n`,
			download,
			`      - run: |\n${block(UNPACK_LINES)}        env:\n          UNSIGNED_SHA256: \${{ needs.build-macos.outputs.unsigned-sha256 }}\n`,
			'      - run: pnpm install --dir signing --ignore-workspace --frozen-lockfile --ignore-scripts\n',
			`      - name: sign and notarise\n        run: |\n${block(signLines)}        env:\n${SECRET_ENV}`,
			insert,
			'      - run: tar -cf mac-signed.tar -C dist-packaged .\n',
			`      - uses: ${PINNED('actions/upload-artifact')}\n        with:\n          name: macos-signed\n          path: mac-signed.tar\n`
		].join('');
	const job = (steps: string, extra = '', top = '') =>
		`name: release\non:\n  push:\n    tags: ['v*']\n${TOP}${top}jobs:\n  sign:\n    runs-on: macos-15\n${extra}    steps:\n${steps}`;
	const report = (text: string) =>
		checkWorkflow('release.yml', text).map((v) => [v.line, v.message]);
	const lineOf = (text: string, needle: string) =>
		text.split('\n').findIndex((l) => l.includes(needle)) + 1;
	const REFUSED = /^secret-bearing job 'sign'(?: may not run |: cannot classify )'/;

	it('names the five signing secrets', () => {
		expect(SIGNING_SECRETS).toEqual([
			'CSC_LINK',
			'CSC_KEY_PASSWORD',
			'APPLE_API_KEY_P8_BASE64',
			'APPLE_API_KEY_ID',
			'APPLE_API_ISSUER'
		]);
	});

	it("accepts release.yml's sign-macos shape", () => {
		expect(report(job(signSteps()))).toEqual([]);
	});

	describe('signing job isolation', () => {
		const FORBIDDEN = [
			// Root installs: anything but signing/, frozen, without scripts.
			'pnpm install',
			'pnpm install --frozen-lockfile',
			'pnpm i --frozen-lockfile',
			'pnpm install --dir signing --frozen-lockfile',
			'pnpm install --dir signing --ignore-scripts',
			'pnpm install --dir . --frozen-lockfile --ignore-scripts',
			'pnpm install --dir signing --frozen-lockfile --ignore-scripts electron',
			'pnpm install --dir signing --frozen-lockfile --ignore-scripts --dir .',
			'pnpm --dir signing install --frozen-lockfile --ignore-scripts',
			// Build, package and test.
			'pnpm build',
			'pnpm run build',
			'pnpm build:desktop',
			'pnpm package:desktop --version "$RELEASE_VERSION" --sign',
			'pnpm test',
			'pnpm test:e2e',
			'pnpm test:e2e:packaged',
			'pnpm exec electron-builder',
			'pnpm dlx electron-builder',
			'npx electron-builder',
			'npm ci',
			'npm run build',
			// node on anything but sign-mac.ts.
			'node scripts/package-desktop.ts --version "$RELEASE_VERSION" --sign',
			'node scripts/verify-packaged.ts mac x.app --signed',
			'node ./scripts/sign-mac.ts',
			'node --import ./x.ts scripts/sign-mac.ts',
			'node -e 1',
			// The same, hidden.
			'FOO=1 pnpm build',
			'set -e; pnpm build',
			'true && npx electron-builder',
			'echo hi | node scripts/packaged-app.ts exe dist-packaged',
			'exe="$(node scripts/packaged-app.ts exe dist-packaged)"',
			'x=`npm ci`',
			'bash -c "pnpm build"',
			'eval pnpm build',
			"trap 'pnpm build' EXIT",
			'tar -xf a.tar --to-command=node',
			'tar -xf a.tar -C d --use-compress-program=node',
			// shopt for globbing only, shasum in check mode only.
			'shopt -s extdebug',
			'shopt -s nullglob extdebug',
			'shopt -u dotglob',
			'shopt -s',
			'shasum -a 256 mac-unsigned.tar',
			'shasum -c -',
			'shasum -a 1 -c -',
			'shasum -a 256 -c --tag -',
			'if true; then pnpm build; fi',
			'"pnpm" build',
			'$PNPM build',
			'cat <<EOF',
			'echo "unclosed'
		];

		/** Refused, and every violation on the command's own line (`if …; fi` gives three). */
		const expectRefused = (text: string, line: string) => {
			const at = text.split('\n').indexOf(line) + 1;
			const out = report(text);
			expect(at).toBeGreaterThan(0);
			expect(out.length).toBeGreaterThan(0);
			for (const [l] of out) expect(l).toBe(at);
			expect(out[0][1]).toMatch(REFUSED);
		};

		it.each(FORBIDDEN)('reports %s as its own step', (cmd) => {
			expectRefused(job(signSteps(`      - run: ${cmd}\n`)), `      - run: ${cmd}`);
		});

		it.each(FORBIDDEN)('reports %s inside the sign step', (cmd) => {
			const lines = [...SIGN_LINES.slice(0, 3), cmd, ...SIGN_LINES.slice(3)];
			expectRefused(job(signSteps('', lines)), `          ${cmd}`);
		});

		it('quotes the command it refuses, without its redirections', () => {
			const text = job(signSteps('      - run: FOO=1 pnpm build:desktop > out.log 2>&1\n'));
			expect(report(text)).toEqual([
				[lineOf(text, 'FOO=1'), "secret-bearing job 'sign' may not run 'FOO=1 pnpm build:desktop'"]
			]);
		});

		it('quotes a line it cannot split', () => {
			const text = job(signSteps('      - run: x="$(npm ci)"\n'));
			expect(report(text)).toEqual([
				[lineOf(text, 'npm ci'), `secret-bearing job 'sign': cannot classify 'x="$(npm ci)"'`]
			]);
		});

		it('reads a command continued over lines', () => {
			const text = job(signSteps(`      - run: |\n${block(['echo a \\', '  && pnpm build'])}`));
			expect(report(text)).toEqual([
				[lineOf(text, 'echo a'), "secret-bearing job 'sign' may not run 'pnpm build'"]
			]);
		});

		it('reports every refused command on a line', () => {
			const text = job(signSteps('      - run: pnpm build; npm ci\n'));
			expect(report(text)).toEqual([
				[lineOf(text, 'npm ci'), "secret-bearing job 'sign' may not run 'pnpm build'"],
				[lineOf(text, 'npm ci'), "secret-bearing job 'sign' may not run 'npm ci'"]
			]);
		});

		it.each([
			['--dir signing', 'pnpm install --dir signing --frozen-lockfile --ignore-scripts'],
			['--dir=signing', 'pnpm install --dir=signing --frozen-lockfile --ignore-scripts'],
			[
				'the signing flags in another order',
				'pnpm install --ignore-workspace --ignore-scripts --frozen-lockfile --dir signing'
			],
			['node scripts/sign-mac.ts with its arguments', 'node scripts/sign-mac.ts --version 1.0.0'],
			['tar with no -C', 'tar -xf mac.tar'],
			['tar -cf with members', 'tar -cf out.tar -C dist-packaged a b'],
			['a comment', 'echo hi # pnpm build'],
			['a quoted separator', "echo 'a; pnpm build'"],
			['an escaped quote', 'echo "a \\" b"'],
			['an fd redirection', 'echo hi >&2'],
			['a redirection with no space', 'echo hi >out.log'],
			['an assignment alone', 'FOO=bar'],
			['shopt -s nullglob dotglob', 'shopt -s nullglob dotglob'],
			['shopt -s dotglob', 'shopt -s dotglob'],
			['shasum -c on stdin', `printf '%s  x\\n' "$S" | shasum -a 256 -c --strict -`],
			['shasum -c on a list file', 'shasum -a 256 -c sums.txt']
		])('allows %s', (_name, cmd) => {
			expect(report(job(signSteps(`      - run: ${cmd}\n`)))).toEqual([]);
		});

		it.each(SIGNING_SECRETS)('treats a job naming only %s as secret-bearing', (name) => {
			const steps = `      - run: pnpm build\n        env:\n          ${name}: \${{ secrets.${name} }}\n`;
			const text = job(steps);
			expect(report(text)).toEqual([
				[lineOf(text, 'pnpm build'), "secret-bearing job 'sign' may not run 'pnpm build'"]
			]);
		});

		it.each([
			['an environment', '    environment: release\n', ''],
			['an environment map', '    environment:\n      name: release\n', ''],
			['secrets[…]', '', "        env:\n          K: ${{ secrets['CSC' + '_LINK'] }}\n"],
			['toJSON(secrets)', '', '        env:\n          K: ${{ toJSON(secrets) }}\n']
		])('treats a job with %s as secret-bearing', (_name, extra, env) => {
			const text = job(`      - run: pnpm build\n${env}`, extra);
			expect(report(text)).toEqual([
				[lineOf(text, 'pnpm build'), "secret-bearing job 'sign' may not run 'pnpm build'"]
			]);
		});

		it('lets a job with no signing secret run anything', () => {
			const steps = `      - run: pnpm install --frozen-lockfile && pnpm build && npx x\n        env:\n          GH_TOKEN: \${{ secrets.REPO_SETTINGS_TOKEN }}\n`;
			expect(report(job(steps))).toEqual([]);
		});

		it('ignores a signing secret named only in a comment', () => {
			const steps = '      # CSC_LINK is read by sign-macos only\n      - run: pnpm build\n';
			expect(report(job(steps))).toEqual([]);
		});

		it('refuses a signing secret outside any job', () => {
			const top = 'env:\n  CSC_LINK: ${{ secrets.CSC_LINK }}\n';
			const text = job('      - run: echo hi\n', '', top);
			expect(report(text)).toEqual([
				[lineOf(text, 'CSC_LINK'), 'a signing secret outside a job cannot be confined to one job']
			]);
		});

		it.each([
			['a local action', './.github/actions/x'],
			['an unlisted action', PINNED('actions/github-script')]
		])('refuses %s', (_name, ref) => {
			const text = job(signSteps(`      - uses: ${ref}\n`));
			expect(report(text)).toEqual([
				[lineOf(text, `uses: ${ref}`), `secret-bearing job 'sign' may not use '${ref}'`]
			]);
		});

		it('refuses pnpm/action-setup run_install', () => {
			const step = `      - uses: ${PINNED('pnpm/action-setup')}\n        with:\n          run_install: true\n`;
			const text = job(signSteps(step));
			expect(report(text)).toEqual([
				[
					lineOf(text, 'run_install'),
					"secret-bearing job 'sign' may not set run_install: it runs a root install"
				]
			]);
		});

		it('refuses a reusable workflow call', () => {
			const text = `on: push\n${TOP}jobs:\n  sign:\n    uses: ${PINNED('o/r/.github/workflows/x.yml')}\n    secrets: inherit\n`;
			expect(report(text)).toEqual([
				[lineOf(text, 'uses:'), "secret-bearing job 'sign' may not call a reusable workflow"]
			]);
		});

		it.each([
			['a step shell', '      - run: echo hi\n        shell: node {0}\n', '', 'shell: node'],
			[
				'a job defaults shell',
				'',
				'    defaults:\n      run:\n        shell: pwsh\n',
				'shell: pwsh'
			]
		])('refuses %s other than bash', (_name, step, extra, needle) => {
			const text = job(signSteps(step), extra);
			expect(report(text)).toEqual([
				[lineOf(text, needle), "secret-bearing job 'sign' runs only under bash"]
			]);
		});

		it('refuses a flow-style job defaults shell and run', () => {
			const text = job(signSteps(), '    defaults: { run: { shell: bash } }\n');
			const line = lineOf(text, 'defaults:');
			expect(report(text)).toEqual([
				[line, "secret-bearing job 'sign': a shell the policy cannot classify"],
				[line, "secret-bearing job 'sign': a run the policy cannot classify"]
			]);
		});

		it('accepts a bash defaults shell in the job and the workflow', () => {
			const top = 'defaults:\n  run:\n    shell: bash\n';
			const extra = '    defaults:\n      run:\n        shell: bash\n';
			expect(report(job(signSteps(), extra, top))).toEqual([]);
		});

		it.each([
			['block', 'defaults:\n  run:\n    shell: pwsh\n'],
			['flow', 'defaults: { run: { shell: bash } }\n']
		])(
			'refuses a %s workflow defaults shell it cannot accept, only beside a secret-bearing job',
			(_name, top) => {
				const text = job(signSteps(), '', top);
				expect(report(text)).toEqual([
					[lineOf(text, 'shell:'), 'a workflow with a secret-bearing job runs only under bash']
				]);
				expect(report(job('      - run: pnpm build\n', '', top))).toEqual([]);
			}
		);

		it.each([
			[
				'a folded run',
				'      - run: >\n          echo a\n          pnpm build\n',
				'run: >',
				'a folded run (>) cannot be classified'
			],
			[
				'an escaped double-quoted run',
				'      - run: "echo hi\\npnpm build"\n',
				'run: "echo',
				'an escaped double-quoted run cannot be classified'
			],
			[
				'a multi-line plain run',
				'      - run: echo hi\n          pnpm build\n',
				'          pnpm build',
				'a multi-line plain run cannot be classified'
			],
			[
				'a flow-style run',
				'      - { run: pnpm build }\n',
				'{ run:',
				'a run the policy cannot classify'
			]
		])('cannot classify %s', (_name, step, needle, message) => {
			const text = job(signSteps(step));
			expect(report(text)).toEqual([
				[lineOf(text, needle), `secret-bearing job 'sign': ${message}`]
			]);
		});

		it('cannot classify a flow-style secret-bearing job', () => {
			const text = `on: push\n${TOP}jobs:\n  sign: { runs-on: x, env: { K: "\${{ secrets.CSC_LINK }}" } }\n`;
			expect(report(text)).toEqual([
				[lineOf(text, 'sign:'), "secret-bearing job 'sign' in flow style cannot be classified"]
			]);
		});

		it('confines the rules to the secret-bearing job', () => {
			const other = (id: string) =>
				`  ${id}:\n    runs-on: macos-15\n    steps:\n      - run: pnpm install --frozen-lockfile && pnpm build\n      - uses: ./.github/actions/x\n`;
			const text = `name: release\non: push\n${TOP}jobs:\n${other('build')}  sign:\n    runs-on: macos-15\n    steps:\n${signSteps()}${other('verify')}`;
			expect(report(text)).toEqual([]);
		});
	});

	// t-19 review FLAG: an allowed command still loads other code if a loader variable
	// is set beside it, by any route.
	describe('loader variables and runner env files', () => {
		const SETS = (name: string) =>
			`secret-bearing job 'sign' may not set ${name}: it changes what node, bash, perl or the loader loads`;
		const WRITES = "secret-bearing job 'sign' may not write $GITHUB_ENV or $GITHUB_PATH";

		it.each([
			['NODE_OPTIONS=--import=./x.ts node scripts/sign-mac.ts', [SETS('NODE_OPTIONS')]],
			['export NODE_OPTIONS=--import=./x.ts', [SETS('NODE_OPTIONS')]],
			['echo "NODE_OPTIONS=--import=./x.ts" >> "$GITHUB_ENV"', [WRITES]]
		])('reports %s', (cmd, messages) => {
			const text = job(signSteps(`      - run: ${cmd}\n`));
			const line = text.split('\n').indexOf(`      - run: ${cmd}`) + 1;
			expect(report(text)).toEqual(messages.map((m) => [line, m]));
		});

		it.each([
			['PATH=./bin:$PATH node scripts/sign-mac.ts', 'PATH'],
			['PATH+=:./bin', 'PATH'],
			['export PATH="./bin:$PATH"', 'PATH'],
			['export -n FOO BASH_ENV=./x.sh', 'BASH_ENV'],
			['ENV=./x.sh', 'ENV'],
			['NODE_PATH=./lib node scripts/sign-mac.ts', 'NODE_PATH'],
			['NODE_EXTRA_CA_CERTS=./ca.pem node scripts/sign-mac.ts', 'NODE_EXTRA_CA_CERTS'],
			['LD_PRELOAD=./x.so node scripts/sign-mac.ts', 'LD_PRELOAD'],
			['LD_LIBRARY_PATH=./lib node scripts/sign-mac.ts', 'LD_LIBRARY_PATH'],
			['DYLD_INSERT_LIBRARIES=./x.dylib node scripts/sign-mac.ts', 'DYLD_INSERT_LIBRARIES'],
			["printf -v PATH '%s' ./bin", 'PATH'],
			["printf -vNODE_OPTIONS '%s' x", 'NODE_OPTIONS'],
			['PERL5OPT=-Mx shasum -a 256 -c -', 'PERL5OPT'],
			['export PERL5LIB=./lib', 'PERL5LIB'],
			['PERLLIB=./lib shasum -a 256 -c -', 'PERLLIB'],
			['set -e; export NODE_OPTIONS', 'NODE_OPTIONS']
		])('reports %s as setting %s', (cmd, name) => {
			const text = job(signSteps(`      - run: ${cmd}\n`));
			const line = text.split('\n').indexOf(`      - run: ${cmd}`) + 1;
			expect(report(text)).toEqual([[line, SETS(name)]]);
		});

		it.each([
			['a tee', 'echo ./bin | tee -a "$GITHUB_PATH"'],
			['a braced name', 'echo x >> "${GITHUB_ENV}"'],
			['a GITHUB_PATH redirect', 'echo ./bin >> $GITHUB_PATH']
		])('reports a runner env file write through %s', (_name, cmd) => {
			const text = job(signSteps(`      - run: ${cmd}\n`));
			const line = text.split('\n').indexOf(`      - run: ${cmd}`) + 1;
			const out = report(text);
			expect(out[0]).toEqual([line, WRITES]);
			for (const [l] of out) expect(l).toBe(line);
		});

		it('reports a NODE_OPTIONS key in the sign step env', () => {
			const env = '        env:\n          NODE_OPTIONS: --import=./x.ts\n';
			const text = job(signSteps().replace('        env:\n', env));
			expect(report(text)).toEqual([[lineOf(text, 'NODE_OPTIONS:'), SETS('NODE_OPTIONS')]]);
		});

		it.each([
			['a job env key', '    env:\n      PATH: ./bin\n', 'PATH'],
			['a flow-style env', '    env: { DYLD_LIBRARY_PATH: ./lib }\n', 'DYLD_LIBRARY_PATH'],
			['a quoted key', '    env:\n      "BASH_ENV": ./x.sh\n', 'BASH_ENV']
		])('reports %s', (_name, extra, name) => {
			const text = job(signSteps(), extra);
			expect(report(text)).toEqual([[lineOf(text, name), SETS(name)]]);
		});

		it('reports a workflow-level loader variable beside a secret-bearing job only', () => {
			const top = 'env:\n  NODE_OPTIONS: --import=./x.ts\n';
			const text = job(signSteps(), '', top);
			expect(report(text)).toEqual([
				[
					lineOf(text, 'NODE_OPTIONS'),
					'a workflow with a secret-bearing job may not set NODE_OPTIONS: it changes what node, bash, perl or the loader loads'
				]
			]);
			expect(report(job('      - run: pnpm build\n', '', top))).toEqual([]);
		});

		it('lets a job with no signing secret set them', () => {
			const steps =
				'      - run: echo "PATH=x" >> "$GITHUB_ENV" && NODE_OPTIONS=x node a.js\n        env:\n          NODE_OPTIONS: x\n';
			expect(report(job(steps))).toEqual([]);
		});

		it.each([
			[
				'a lowercase with: path',
				`      - uses: ${PINNED('actions/upload-artifact')}\n        with:\n          path: x.tar\n`
			],
			['a name that only contains PATH', '      - run: MY_PATH=x\n'],
			['an export of another name', '      - run: export APPLE_API_KEY_FILE="$RUNNER_TEMP/k"\n']
		])('allows %s', (_name, step) => {
			expect(report(job(signSteps(step)))).toEqual([]);
		});
	});

	// SEC-18: a download with no path extracts over the checkout, where the artefact
	// could replace scripts/sign-mac.ts before it runs with the secrets.
	describe('artifact downloads', () => {
		const NO_PATH =
			"secret-bearing job 'sign': download-artifact with no path extracts into the workspace; give it a path under ${{ runner.temp }}";
		const NOT_UNDER = (path: string) =>
			`secret-bearing job 'sign': download-artifact path '${path}' is not a fresh dir under \${{ runner.temp }}`;

		it('reports a download with no path at its uses: line', () => {
			const text = job(signSteps('', SIGN_LINES, DOWNLOAD('          name: macos-unsigned\n')));
			expect(report(text)).toEqual([[lineOf(text, 'download-artifact@'), NO_PATH]]);
		});

		it('reports a download with no with: at all', () => {
			const text = job(
				signSteps('', SIGN_LINES, `      - uses: ${PINNED('actions/download-artifact')}\n`)
			);
			expect(report(text)).toEqual([[lineOf(text, 'download-artifact@'), NO_PATH]]);
		});

		it('reports a flow-style with:, whose path it cannot read', () => {
			const step = `      - uses: ${PINNED('actions/download-artifact')}\n        with: { name: x, path: \${{ runner.temp }}/x }\n`;
			const text = job(signSteps('', SIGN_LINES, step));
			expect(report(text)).toEqual([[lineOf(text, 'download-artifact@'), NO_PATH]]);
		});

		it("does not take the next step's path for the download's", () => {
			const next = `      - uses: ${PINNED('actions/upload-artifact')}\n        with:\n          path: \${{ runner.temp }}/x\n`;
			const text = job(signSteps('', SIGN_LINES, DOWNLOAD('          name: x\n') + next));
			expect(report(text)).toEqual([[lineOf(text, 'download-artifact@'), NO_PATH]]);
		});

		it.each([
			['the workspace', 'dist-packaged'],
			['the workspace root', '.'],
			['a literal $RUNNER_TEMP, which the action does not expand', '$RUNNER_TEMP/x'],
			['a literal ${RUNNER_TEMP}', '${RUNNER_TEMP}/x'],
			['runner.temp itself', '${{ runner.temp }}'],
			['runner.temp with a trailing slash only', '${{ runner.temp }}/'],
			['a .. segment', '${{ runner.temp }}/../work'],
			['a trailing .. segment', '${{ runner.temp }}/x/..'],
			['a . segment', '${{ runner.temp }}/.'],
			['another context', '${{ github.workspace }}/x'],
			['an expression in the dir name', '${{ runner.temp }}/${{ github.head_ref }}'],
			['an absolute path', '/tmp/x'],
			['a block scalar', '|']
		])('reports a path in %s', (_name, path) => {
			const text = job(
				signSteps('', SIGN_LINES, DOWNLOAD(`          name: x\n          path: ${path}\n`))
			);
			expect(report(text)).toEqual([[lineOf(text, `path: ${path}`), NOT_UNDER(path)]]);
		});

		it.each([
			['a dir under runner.temp', '${{ runner.temp }}/macos-unsigned'],
			['a nested dir', '${{ runner.temp }}/a/b_c.d'],
			['no spaces in the braces', '${{runner.temp}}/x'],
			['a quoted path', '"${{ runner.temp }}/x"']
		])('accepts %s', (_name, path) => {
			const text = job(
				signSteps('', SIGN_LINES, DOWNLOAD(`          name: x\n          path: ${path}\n`))
			);
			expect(report(text)).toEqual([]);
		});

		it('reads the path when uses: is not the first key of the step', () => {
			const step = (path: string) =>
				`      - name: fetch\n        uses: ${PINNED('actions/download-artifact')}\n        with:\n          pattern: x-*\n          path: ${path}\n`;
			expect(report(job(signSteps('', SIGN_LINES, step('${{ runner.temp }}/x'))))).toEqual([]);
			const text = job(signSteps('', SIGN_LINES, step('out')));
			expect(report(text)).toEqual([[lineOf(text, 'path: out'), NOT_UNDER('out')]]);
		});

		it('holds every download in the job to it', () => {
			const text = job(signSteps(DOWNLOAD('          name: other\n')));
			const second =
				text.split('\n').lastIndexOf(`      - uses: ${PINNED('actions/download-artifact')}`) + 1;
			expect(report(text)).toEqual([[second, NO_PATH]]);
		});

		it('lets a job with no signing secret download anywhere', () => {
			const steps = `${DOWNLOAD('          name: x\n')}      - run: pnpm build\n`;
			expect(report(job(steps))).toEqual([]);
		});
	});

	describe('p8 cleanup', () => {
		const WRITE = `printf '%s' "$KEY" | base64 --decode > "$RUNNER_TEMP/AuthKey.p8"`;
		/** A job with no signing secret, so only the p8 rule applies. */
		const plain = (steps: string) =>
			`on: push\n${TOP}jobs:\n  build:\n    runs-on: macos-15\n    steps:\n${steps}`;
		const step = (lines: string[]) => `      - run: |\n${block(lines)}`;
		const NEEDS = `a step that writes a .p8 key needs ${P8_TRAP} first`;
		const BEFORE = `${P8_TRAP} must come before the step's first .p8 use`;
		const ONLY = (path: string) =>
			`the .p8 cleanup trap removes $RUNNER_TEMP/AuthKey.p8 only, not ${path}`;

		it('accepts the trap set before the write', () => {
			const lines = ['set -eu', P8_TRAP, WRITE, 'export K="$RUNNER_TEMP/AuthKey.p8"'];
			expect(report(plain(step(lines)))).toEqual([]);
		});

		it('reports a write with no trap', () => {
			const text = plain(step(['set -eu', WRITE]));
			expect(report(text)).toEqual([[lineOf(text, 'base64 --decode'), NEEDS]]);
		});

		it('reports an inline write with no trap', () => {
			const text = plain(`      - run: ${WRITE}\n`);
			expect(report(text)).toEqual([[lineOf(text, 'base64 --decode'), NEEDS]]);
		});

		it('reports a trap set after the write', () => {
			const text = plain(step([WRITE, P8_TRAP]));
			expect(report(text)).toEqual([[lineOf(text, 'base64 --decode'), BEFORE]]);
		});

		it('reports a trap set in an earlier step', () => {
			const text = plain(step([P8_TRAP]) + step([WRITE]));
			expect(report(text)).toEqual([[lineOf(text, 'base64 --decode'), NEEDS]]);
		});

		it('reports a trap for another file', () => {
			const text = plain(step([`trap 'rm -f "$RUNNER_TEMP/Other.p8"' EXIT`, WRITE]));
			expect(report(text)).toEqual([
				[lineOf(text, 'Other.p8'), NEEDS],
				[lineOf(text, 'Other.p8'), ONLY('$RUNNER_TEMP/Other.p8')]
			]);
		});

		it('reports a key written anywhere the trap does not remove', () => {
			const text = plain(step([P8_TRAP, 'printf x > key.p8']));
			expect(report(text)).toEqual([[lineOf(text, 'key.p8'), ONLY('key.p8')]]);
		});

		it('reports a later trap that replaces the cleanup', () => {
			const text = plain(step([P8_TRAP, WRITE, 'trap - EXIT']));
			expect(report(text)).toEqual([
				[lineOf(text, 'trap - EXIT'), 'a later trap replaces the .p8 cleanup']
			]);
		});

		it('ignores a step that names no .p8 file', () => {
			expect(report(plain(step(['echo "$APPLE_API_KEY_P8_LENGTH"'])))).toEqual([]);
		});

		it("holds release.yml's sign step to it", () => {
			const untrapped = SIGN_LINES.filter((l) => l !== P8_TRAP);
			const text = job(signSteps('', untrapped));
			expect(report(text)).toEqual([[lineOf(text, 'base64 --decode'), NEEDS]]);
		});
	});
});

describe('shipped workflows clean', () => {
	const ROOT = fileURLToPath(new URL('..', import.meta.url));

	it('pnpm ci:policy runs this checker', () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts['ci:policy']).toBe('node scripts/workflow-policy.ts');
	});

	it('exits 0 on .github/workflows', () => {
		const script = fileURLToPath(new URL('./workflow-policy.ts', import.meta.url));
		const res = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' });
		expect(res.stderr).toMatch(/workflow file\(s\), 0 violation\(s\)\n$/);
		expect(res.status).toBe(0);
	});
});
