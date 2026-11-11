import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkWorkflow, runPolicyCli, WRITE_SCOPE_ALLOWLIST } from './workflow-policy.ts';

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

	it('ships empty, so any write scope is rejected', () => {
		expect(WRITE_SCOPE_ALLOWLIST).toEqual({});
		expect(messages('release.yml', job('contents'))).not.toEqual([]);
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
		expect(runPolicyCli(dir, log)).toBe(1);
		expect(runPolicyCli(dir, log, { 'release.yml': ['contents'] })).toBe(0);
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
