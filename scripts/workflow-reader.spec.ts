// Pins the shared workflow line reader: jobs, job and top-level keys, `on` triggers,
// steps and the Linux/else branch split, against a fixture shaped like this repo's
// workflows and against the real ci.yml and audit.yml.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	block,
	branches,
	map,
	readWorkflow,
	steps,
	unquote,
	value,
	type Step,
	type Workflow
} from './workflow-reader.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(join(ROOT, '.github/workflows', file), 'utf8');

const FIXTURE = `# a comment before everything
name: release

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: release-\${{ github.ref }}
  cancel-in-progress: false

defaults:
  run:
    shell: bash

jobs:
  tag:
    runs-on: ubuntu-24.04 # cheap
    permissions:
      contents: read
    outputs:
      version: \${{ steps.check.outputs.version }}
    steps:
      # checkout first
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 0
      - name: check
        id: check
        run: node scripts/release-tag.ts
      - name: script
        run: |
          echo one
          name: not-a-key
          - not a step

          echo two
        env:
          CI: 'true'
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9
        with:
          path: out/
          run: not-a-script
      # quoted next
      - name: quoted
        run: "pnpm build"

  # the mac build
  build-macos:
    needs: [tag]
    runs-on: macos-15
    environment: release
    if: \${{ needs.tag.outputs.version != '' }}
    steps:
      - run: echo mac | tee log

  publish:
    needs:
      - tag
      - build-macos # signed
    permissions: { contents: write }
    concurrency: publish
    if: >
      github.ref_type == 'tag'
      && success()
    steps:
      - run: gh release create
  empty:
    permissions: {}
    steps: []
`;

// Read in beforeEach, never at collection: Stryker counts load-time coverage as static.
let wf: Workflow;
beforeEach(() => {
	wf = readWorkflow(FIXTURE, 'release.yml');
});

describe('job', () => {
	it('throws an error naming the missing job and the file', () => {
		expect(() => wf.job('missing')).toThrow("release.yml has no job 'missing'");
		expect(() => readWorkflow('jobs:\n  a:\n    steps: []\n').job('b')).toThrow(
			"workflow has no job 'b'"
		);
	});

	it('only finds jobs under jobs:, never another two-space key', () => {
		expect(() => wf.job('run')).toThrow("release.yml has no job 'run'");
		expect(() => wf.job('push')).toThrow(/'push'/);
		expect(() => readWorkflow('name: x\n  a:\n').job('a')).toThrow(
			"workflow has no jobs: key, so no job 'a'"
		);
		expect(() => readWorkflow('  a:\n    b: 1\n').job('a')).toThrow(/no jobs: key/);
	});

	it('does not take a job-key scalar for a job', () => {
		expect(() => readWorkflow('jobs:\n  a: x\n').job('a')).toThrow(/'a'/);
	});

	it('returns the body up to the next job, keeping comments and blanks inside', () => {
		const body = wf.job('tag');
		expect(body[0]).toBe('    runs-on: ubuntu-24.04 # cheap');
		expect(body).toContain('      # checkout first');
		expect(body).toContain('          name: not-a-key');
		// A comment never ends a body, so one above the next job stays in this one.
		expect(body.slice(-2)).toEqual(['', '  # the mac build']);
		expect(body.some((l) => l.includes('build-macos') || l.includes('needs:'))).toBe(false);
	});

	it('runs to the end of the file for the last job, and takes a job id with a comment', () => {
		expect(wf.job('empty')).toEqual(['    permissions: {}', '    steps: []', '']);
		expect(readWorkflow('jobs:\n  a: # x\n    b: 1\n').job('a')).toEqual(['    b: 1', '']);
		expect(readWorkflow('jobs:\n  a:  \n    b: 1\n').job('a')).toEqual(['    b: 1', '']);
	});

	it('stops at a top-level key after jobs', () => {
		expect(readWorkflow('jobs:\n  a:\n    b: 1\nenv:\n  c: 2\n').job('a')).toEqual(['    b: 1']);
	});

	it('reads CRLF text', () => {
		expect(readWorkflow('jobs:\r\n  a:\r\n    b: 1\r\n').job('a')).toEqual(['    b: 1', '']);
	});
});

describe('jobKey', () => {
	it("reads needs as a flow list or a block list, as ['a','b']", () => {
		expect(wf.jobKey('build-macos', 'needs')).toEqual(['tag']);
		expect(wf.jobKey('publish', 'needs')).toEqual(['tag', 'build-macos']);
		expect(readWorkflow('jobs:\n  a:\n    needs: [a, b]\n').jobKey('a', 'needs')).toEqual([
			'a',
			'b'
		]);
		expect(readWorkflow('jobs:\n  a:\n    needs: [\'a\', "b"]\n').jobKey('a', 'needs')).toEqual([
			'a',
			'b'
		]);
		expect(
			readWorkflow('jobs:\n  a:\n    needs:\n      - a\n      - b\n').jobKey('a', 'needs')
		).toEqual(['a', 'b']);
		expect(readWorkflow('jobs:\n  a:\n    needs: [a, b]   \n').jobKey('a', 'needs')).toEqual([
			'a',
			'b'
		]);
		expect(readWorkflow('jobs:\n  a:\n    needs: []\n').jobKey('a', 'needs')).toEqual([]);
	});

	it('reads permissions as a block map, a flow map or an empty map', () => {
		expect(wf.jobKey('tag', 'permissions')).toEqual({ contents: 'read' });
		expect(wf.jobKey('publish', 'permissions')).toEqual({ contents: 'write' });
		expect(wf.jobKey('empty', 'permissions')).toEqual({});
		expect(
			readWorkflow(
				'jobs:\n  a:\n    permissions: { contents: read, "id-token": \'write\' }\n'
			).jobKey('a', 'permissions')
		).toEqual({ contents: 'read', 'id-token': 'write' });
		// No key before the colon, or no colon: not a pair.
		expect(
			readWorkflow('jobs:\n  a:\n    permissions: { :x, contents:write, junk }\n').jobKey(
				'a',
				'permissions'
			)
		).toEqual({ contents: 'write' });
	});

	it('reads scalars without their trailing comment', () => {
		expect(wf.jobKey('tag', 'runs-on')).toBe('ubuntu-24.04');
		expect(wf.jobKey('build-macos', 'environment')).toBe('release');
		expect(wf.jobKey('build-macos', 'if')).toBe("${{ needs.tag.outputs.version != '' }}");
		expect(wf.jobKey('publish', 'concurrency')).toBe('publish');
	});

	it('reads a scalar that only contains | > [ ] { } as a scalar', () => {
		const text = [
			'jobs:',
			'  a:',
			'    if: a || b > c',
			'    name: [wip] build',
			'    ref: github.event.commits[0]',
			'    note: {a} b',
			''
		].join('\n');
		const a = readWorkflow(text);
		expect(a.jobKey('a', 'if')).toBe('a || b > c');
		expect(a.jobKey('a', 'name')).toBe('[wip] build');
		expect(a.jobKey('a', 'ref')).toBe('github.event.commits[0]');
		expect(a.jobKey('a', 'note')).toBe('{a} b');
	});

	it('reads a folded or literal block scalar', () => {
		expect(wf.jobKey('publish', 'if')).toBe("github.ref_type == 'tag' && success()");
		expect(readWorkflow('jobs:\n  a:\n    if: |\n      x\n      y\n').jobKey('a', 'if')).toBe(
			'x\ny'
		);
	});

	it('reads only keys directly under the job', () => {
		// persist-credentials sits under a step's with:, environment is another job's.
		expect(wf.jobKey('tag', 'persist-credentials')).toBeUndefined();
		expect(wf.jobKey('tag', 'environment')).toBeUndefined();
		expect(wf.jobKey('tag', 'outputs')).toEqual({
			version: '${{ steps.check.outputs.version }}'
		});
	});

	it('gives undefined for a key with nothing under it, and throws for a missing job', () => {
		expect(readWorkflow('jobs:\n  a:\n    needs:\n  b:\n').jobKey('a', 'needs')).toBeUndefined();
		expect(
			readWorkflow('jobs:\n  a:\n    needs:\n    if: x\n').jobKey('a', 'needs')
		).toBeUndefined();
		expect(() => wf.jobKey('missing', 'needs')).toThrow(/'missing'/);
	});
});

describe('top', () => {
	it('reads top-level maps and scalars', () => {
		expect(wf.top('permissions')).toEqual({ contents: 'read' });
		expect(wf.top('concurrency')).toEqual({
			group: 'release-${{ github.ref }}',
			'cancel-in-progress': 'false'
		});
		expect(wf.top('name')).toBe('release');
		expect(wf.top('missing')).toBeUndefined();
	});

	it('takes only the direct children of a nested map', () => {
		expect(wf.top('defaults')).toEqual({ run: '' });
	});
});

describe('triggers', () => {
	it("reads push.tags ['v*'] and a filterless event", () => {
		expect(wf.triggers()).toEqual({ push: { tags: ['v*'] }, workflow_dispatch: {} });
	});

	it('reads block-list filters and several filters per event', () => {
		const text = "on:\n  push:\n    tags:\n      - 'v*'\n    branches: main\n  pull_request:\n";
		expect(readWorkflow(text).triggers()).toEqual({
			push: { tags: ['v*'], branches: ['main'] },
			pull_request: {}
		});
	});

	it('reads a scalar or flow-list on, and a quoted on key', () => {
		expect(readWorkflow('on: push\n').triggers()).toEqual({ push: {} });
		expect(readWorkflow('on: [push, pull_request]\n').triggers()).toEqual({
			push: {},
			pull_request: {}
		});
		expect(readWorkflow('"on":\n  push:\n    tags: [v*]\n').triggers()).toEqual({
			push: { tags: ['v*'] }
		});
	});

	it('skips keys nested below a filter', () => {
		const text =
			'on:\n  workflow_dispatch:\n    inputs:\n      tag:\n        required: true\n  push:\n';
		expect(readWorkflow(text).triggers()).toEqual({
			workflow_dispatch: { inputs: ['tag'] },
			push: {}
		});
	});

	it('reads an empty on as no events', () => {
		expect(readWorkflow('on:\njobs:\n').triggers()).toEqual({});
	});

	it('skips blanks and comments in the on block', () => {
		const text = [
			'on:',
			'',
			'  # note: push first',
			'  push:',
			'',
			'    # note: tags only',
			'    tags: [v*]',
			'  pull_request:',
			''
		].join('\n');
		expect(readWorkflow(text).triggers()).toEqual({ push: { tags: ['v*'] }, pull_request: {} });
	});

	it('collects every item of a list-shaped event, skipping item continuations', () => {
		const text = 'on:\n  schedule:\n    - cron: a\n      timezone: x\n    - cron: b\n';
		expect(readWorkflow(text).triggers()).toEqual({ schedule: { cron: ['a', 'b'] } });
	});

	it('gives a filter with nothing under it no values', () => {
		expect(readWorkflow('on:\n  push:\n    branches:\n').triggers()).toEqual({
			push: { branches: [] }
		});
	});

	it('throws when there is no on key', () => {
		expect(() => readWorkflow('name: x\njobs:\n', 'x.yml').triggers()).toThrow(
			"x.yml has no 'on' triggers"
		);
	});

	it('reads the real ci.yml and audit.yml', () => {
		expect(readWorkflow(read('ci.yml')).triggers()).toEqual({
			pull_request: { branches: ['main', 'milestone/**'] }
		});
		expect(readWorkflow(read('audit.yml')).triggers()).toEqual({
			pull_request: {
				branches: ['main', 'milestone/**'],
				paths: ['pnpm-lock.yaml', 'package.json']
			},
			schedule: { cron: ['17 6 * * 1'] }
		});
		expect(readWorkflow(read('ci.yml')).jobKey('test', 'needs')).toEqual(['static', 'gitleaks']);
	});
});

describe('steps', () => {
	let list: Step[];
	beforeEach(() => {
		list = steps(wf.job('tag'));
	});

	it('splits steps at each `- `, never merging the step after a run: | block', () => {
		expect(list.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
		expect(list[2].get('name')).toBe('script');
		expect(list[3].get('name')).toBeUndefined();
		expect(list[3].lines).toEqual([
			'      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
			'        with:',
			'          path: out/',
			'          run: not-a-script'
		]);
	});

	it('reads a - uses: step with with:', () => {
		const [checkout] = list;
		expect(checkout.get('uses')).toBe('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
		expect(checkout.get('persist-credentials')).toBe('false');
		expect(checkout.get('fetch-depth')).toBe('0');
		expect(checkout.run).toEqual([]);
		expect(list[3].get('path')).toBe('out/');
		expect(list[3].run).toEqual([]);
	});

	it("reads a block run script's trimmed non-empty lines, up to the step's next key", () => {
		expect(list[2].run).toEqual(['echo one', 'name: not-a-key', '- not a step', 'echo two']);
		expect(list[2].get('CI')).toBe('true');
		expect(list[2].get('env')).toBe('');
	});

	it('never reads a key out of a run script', () => {
		expect(list[2].get('name')).toBe('script');
		expect(list[2].get('run')).toBe('|');
		expect(steps(['    steps:', '      - run: |', '          uses: x']).at(0)?.get('uses')).toBe(
			undefined
		);
	});

	it('reads an inline run, quoted or not, with the step id beside it', () => {
		expect(list[1].run).toEqual(['node scripts/release-tag.ts']);
		expect(list[1].get('id')).toBe('check');
		expect(list[1].get('run')).toBe('node scripts/release-tag.ts');
		expect(list[4].run).toEqual(['pnpm build']);
		expect(steps(wf.job('build-macos'))[0].run).toEqual(['echo mac | tee log']);
	});

	it('drops comment lines and gives a job without steps none', () => {
		expect(list.flatMap((s) => s.lines).some((l) => l.trim().startsWith('#'))).toBe(false);
		expect(steps(wf.job('empty'))).toEqual([]);
	});
});

describe('block and map', () => {
	it('returns a mapping’s child lines, or none when absent', () => {
		expect(block(wf.job('tag'), 'outputs', 4)).toEqual([
			'      version: ${{ steps.check.outputs.version }}'
		]);
		expect(block(wf.job('tag'), 'env', 4)).toEqual([]);
		expect(block(['  a:', '    b: 1', '  # c', '    d: 2', '  e: 3'], 'a', 2)).toEqual([
			'    b: 1',
			'  # c',
			'    d: 2'
		]);
		// A whitespace-only line is a blank, not a sibling.
		expect(block(['  a:', '    b: 1', '  ', '    c: 2'], 'a', 2)).toEqual([
			'    b: 1',
			'  ',
			'    c: 2'
		]);
		expect(block(['  a:', '  b: 1'], 'a', 2)).toEqual([]);
		expect(block(['      deep: 1'], 'env', 4)).toEqual([]);
	});

	it('maps flat keys, dropping quotes, trailing comments and comment lines', () => {
		expect(
			map(['  AB: "xyz" # why', "  B: 'y'", '  # C: z', '  D:', 'E: top', 'F G: no', '  H:v'])
		).toEqual({ AB: 'xyz', B: 'y', D: '', H: 'v' });
	});
});

describe('value', () => {
	it('lists block items without comments', () => {
		expect(value(['k:', '  - a # x', "  - 'b'"], 'k', 0)).toEqual(['a', 'b']);
	});

	it('ignores a key at another indent', () => {
		expect(value(['  k: 1'], 'k', 0)).toBeUndefined();
		expect(value(['k: 1'], 'k', 2)).toBeUndefined();
	});

	it('escapes the key', () => {
		expect(value(['ab: 1'], 'a.', 0)).toBeUndefined();
		expect(value(['a: 1'], 'a.', 0)).toBeUndefined();
	});

	it('needs a space or the line end after the colon', () => {
		expect(value(['a:b'], 'a', 0)).toBeUndefined();
	});

	it('skips a direct child that is not a pair', () => {
		expect(value(['k:', '  a: 1', '  junk'], 'k', 0)).toEqual({ a: '1' });
	});
});

describe('unquote', () => {
	it.each([
		['"a"', 'a'],
		["'a'", 'a'],
		[' a ', 'a'],
		['"a\'', '"a\''],
		['"', '"'],
		['""', ''],
		['xax', 'xax'],
		['', '']
	])('%j -> %j', (input, out) => {
		expect(unquote(input)).toBe(out);
	});
});

describe('branches', () => {
	const ok = ['if [ "$RUNNER_OS" = "Linux" ]; then', 'a', 'b', 'else', 'c', 'fi'];

	it('splits the Linux branch from the other OSes', () => {
		expect(branches(ok)).toEqual({ linux: ['a', 'b'], other: ['c'] });
		const words = ['if [ "$RUNNER_OS" = "Linux" ]; then', 'echo if', 'else', 'echo fi', 'fi'];
		expect(branches(words)).toEqual({ linux: ['echo if'], other: ['echo fi'] });
	});

	it.each([
		['another condition', ['if [ "$RUNNER_OS" = "macOS" ]; then', 'a', 'else', 'c', 'fi']],
		['no else', ['if [ "$RUNNER_OS" = "Linux" ]; then', 'a', 'fi']],
		['no fi', ok.slice(0, -1)],
		['a command after fi', [...ok, 'echo after']],
		['an elif instead of else', ['if [ "$RUNNER_OS" = "Linux" ]; then', 'a', 'elif x', 'b', 'fi']],
		['an elif', [...ok.slice(0, 3), 'elif true; then', ...ok.slice(3)]],
		['a nested if', [...ok.slice(0, 2), 'if true; then x; fi', ...ok.slice(2)]],
		['nothing', []]
	])('rejects %s', (_, run) => {
		expect(branches(run)).toBeNull();
	});
});
