import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
