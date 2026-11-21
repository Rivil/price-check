import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	collect,
	evaluate,
	readExpectedEnvironment,
	runCli,
	type FetchLike,
	type Snapshot
} from './repo-settings.ts';
import { checkWorkflow } from './workflow-policy.ts';

const expected = readExpectedEnvironment();
const TOKEN = 'SENTINEL_gh_token_0123456789';
const REPO = 'Rivil/price-check';

/** Every setting as required. */
function good(): Snapshot {
	return {
		rulesets: [
			{
				name: 'release tags',
				target: 'tag',
				enforcement: 'active',
				conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
				rules: [
					{ type: 'creation' },
					{ type: 'update' },
					{ type: 'deletion' },
					{ type: 'non_fast_forward' }
				],
				bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }]
			}
		],
		environment: {
			deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
			protection_rules: []
		},
		branchPolicies: [{ name: 'v*', type: 'tag' }],
		immutableReleases: { enabled: true },
		vulnerabilityAlerts: true
	};
}

function tag(snapshot: Snapshot) {
	return snapshot.rulesets[0];
}

describe('evaluate', () => {
	it('the release environment file is the one the check compares against', () => {
		expect(expected.policies).toEqual([{ name: 'v*', type: 'tag' }]);
		expect(expected.deployment_branch_policy).toEqual({
			protected_branches: false,
			custom_branch_policies: true
		});
		expect(expected.reviewers).toEqual([]);
	});

	it('the all-good snapshot passes', () => {
		expect(evaluate(good(), expected)).toEqual([]);
	});

	const cases: [string, (s: Snapshot) => void, RegExp][] = [
		['no tag ruleset', (s) => (s.rulesets = []), /no tag ruleset includes refs\/tags\/v\*/],
		[
			'only a branch ruleset',
			(s) => (tag(s).target = 'branch'),
			/no tag ruleset includes refs\/tags\/v\*/
		],
		['enforcement evaluate', (s) => (tag(s).enforcement = 'evaluate'), /enforcement is 'evaluate'/],
		[
			'refs/tags/* without v*',
			(s) => (tag(s).conditions = { ref_name: { include: ['refs/tags/*'] } }),
			/no tag ruleset includes refs\/tags\/v\*.*refs\/tags\/\*/
		],
		[
			'v* excluded again',
			(s) =>
				(tag(s).conditions = { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/*'] } }),
			/excludes refs\/tags\/\*, which covers v\* tags/
		],
		[
			'creation rule missing',
			(s) => (tag(s).rules = tag(s).rules!.filter((r) => r.type !== 'creation')),
			/no 'creation' rule/
		],
		[
			'non_fast_forward rule missing',
			(s) => (tag(s).rules = tag(s).rules!.filter((r) => r.type !== 'non_fast_forward')),
			/no 'non_fast_forward' rule/
		],
		[
			'a bypass actor other than admin',
			(s) => (tag(s).bypass_actors = [{ actor_type: 'Integration', actor_id: 15368 }]),
			/bypass actors must be exactly RepositoryRole:5.*Integration:15368/
		],
		[
			'an extra bypass actor',
			(s) =>
				tag(s).bypass_actors!.push({
					actor_type: 'RepositoryRole',
					actor_id: 2,
					bypass_mode: 'always'
				}),
			/bypass actors must be exactly RepositoryRole:5/
		],
		[
			'no bypass actor',
			(s) => (tag(s).bypass_actors = []),
			/bypass actors must be exactly RepositoryRole:5.*none/
		],
		[
			'a branch-type v* policy',
			(s) => (s.branchPolicies = [{ name: 'v*', type: 'branch' }]),
			/deployment policies are \[branch:v\*\]/
		],
		[
			'an extra deployment policy',
			(s) => s.branchPolicies.push({ name: 'main', type: 'branch' }),
			/deployment policies are/
		],
		[
			'protected_branches true',
			(s) =>
				(s.environment.deployment_branch_policy = {
					protected_branches: true,
					custom_branch_policies: false
				}),
			/protected_branches is true/
		],
		[
			'custom_branch_policies false',
			(s) =>
				(s.environment.deployment_branch_policy = {
					protected_branches: false,
					custom_branch_policies: false
				}),
			/custom_branch_policies is false/
		],
		[
			'no deployment branch policy',
			(s) => (s.environment.deployment_branch_policy = null),
			/no deployment branch policy/
		],
		[
			'a required reviewer',
			(s) => (s.environment.protection_rules = [{ type: 'required_reviewers' }]),
			/required reviewer/
		],
		[
			'immutable releases off',
			(s) => (s.immutableReleases = { enabled: false }),
			/immutable releases are off/
		],
		[
			'vulnerability alerts off',
			(s) => (s.vulnerabilityAlerts = false),
			/vulnerability alerts are off/
		]
	];

	it.each(cases)('%s is a violation naming it', (_what, mutate, message) => {
		const snapshot = good();
		mutate(snapshot);
		const violations = evaluate(snapshot, expected);
		expect(
			violations.some((v) => message.test(v)),
			violations.join(' | ')
		).toBe(true);
	});

	it('a second, compliant tag ruleset is enough', () => {
		const snapshot = good();
		snapshot.rulesets.unshift({ ...tag(snapshot), name: 'draft', enforcement: 'evaluate' });
		expect(evaluate(snapshot, expected)).toEqual([]);
	});
});

type Route = { status: number; body?: unknown } | 'throw';

/** A fetch answering from a route table; anything unrouted is a 404. */
function fakeFetch(overrides: Record<string, Route> = {}) {
	const routes: Record<string, Route> = {
		'/rulesets?per_page=100': {
			status: 200,
			body: [
				{ id: 7, target: 'tag' },
				{ id: 8, target: 'branch' }
			]
		},
		'/rulesets/7': { status: 200, body: good().rulesets[0] },
		'/environments/release': { status: 200, body: good().environment },
		'/environments/release/deployment-branch-policies?per_page=100': {
			status: 200,
			body: { branch_policies: [{ name: 'v*', type: 'tag' }] }
		},
		'/immutable-releases': { status: 200, body: { enabled: true, enforced_by_owner: false } },
		'/vulnerability-alerts': { status: 204 },
		...overrides
	};
	const seen: { url: string; headers: Record<string, string> }[] = [];
	const fetch: FetchLike = async (url, init) => {
		seen.push({ url, headers: init.headers });
		const path = url.replace(`https://api.github.com/repos/${REPO}`, '');
		const route = routes[path] ?? { status: 404 };
		if (route === 'throw') throw new Error(`connect ECONNREFUSED with ${TOKEN}`);
		return {
			status: route.status,
			json: async () => {
				if (route.body === undefined) throw new Error('no body');
				return route.body;
			}
		};
	};
	return { fetch, seen };
}

async function cli(env: NodeJS.ProcessEnv, fetch: FetchLike) {
	const lines: string[] = [];
	const code = await runCli(['--repo', REPO], { env, fetch, expected, log: (l) => lines.push(l) });
	return { code, lines };
}

describe('collect and the CLI', () => {
	it('passes when the live settings hold, sending the token only as a bearer header', async () => {
		const { fetch, seen } = fakeFetch();
		const { code, lines } = await cli({ GH_TOKEN: TOKEN }, fetch);
		expect(lines).toEqual([`repo-settings: ${REPO}: 0 violation(s)`]);
		expect(code).toBe(0);
		// Only tag rulesets are read in detail.
		expect(seen.map((s) => s.url)).not.toContain(`https://api.github.com/repos/${REPO}/rulesets/8`);
		for (const { headers } of seen) expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('maps immutable-releases 404 and vulnerability-alerts 404 to "off"', async () => {
		const { fetch } = fakeFetch({
			'/immutable-releases': { status: 404 },
			'/vulnerability-alerts': { status: 404 }
		});
		expect(await collect(REPO, TOKEN, fetch, expected)).toEqual([
			'immutable releases are off',
			'Dependabot vulnerability alerts are off'
		]);
	});

	it('fails closed', async () => {
		const unset = await cli({}, fakeFetch().fetch);
		expect(unset.code).toBe(1);
		expect(unset.lines[0]).toContain('GH_TOKEN is not set');
		expect((await cli({ GH_TOKEN: '  ' }, fakeFetch().fetch)).code).toBe(1);

		const endpoints = [
			'/rulesets?per_page=100',
			'/rulesets/7',
			'/environments/release',
			'/environments/release/deployment-branch-policies?per_page=100',
			'/immutable-releases',
			'/vulnerability-alerts'
		];
		for (const endpoint of endpoints) {
			for (const route of [
				{ status: 401 },
				{ status: 403 },
				{ status: 500 },
				{ status: 502 },
				'throw'
			] as Route[]) {
				const { code, lines } = await cli(
					{ GH_TOKEN: TOKEN },
					fakeFetch({ [endpoint]: route }).fetch
				);
				const what = `${endpoint} ${route === 'throw' ? 'network error' : route.status}`;
				expect(code, what).toBe(1);
				expect(lines.join('\n'), what).toContain(`cannot read ${endpoint.replace(/\?.*$/, '')}`);
			}
		}
		// A 404 where the endpoint must exist is a failure too.
		for (const endpoint of endpoints.slice(0, 4)) {
			const { code } = await cli(
				{ GH_TOKEN: TOKEN },
				fakeFetch({ [endpoint]: { status: 404 } }).fetch
			);
			expect(code, endpoint).toBe(1);
		}
		// A 2xx with no readable JSON body.
		const { code } = await cli(
			{ GH_TOKEN: TOKEN },
			fakeFetch({ '/environments/release': { status: 200 } }).fetch
		);
		expect(code).toBe(1);
	});

	it('never prints the token', async () => {
		const runs = [
			await cli({ GH_TOKEN: TOKEN }, fakeFetch().fetch),
			await cli({ GH_TOKEN: TOKEN }, fakeFetch({ '/rulesets/7': 'throw' }).fetch),
			await cli({ GH_TOKEN: TOKEN }, fakeFetch({ '/environments/release': { status: 403 } }).fetch),
			await cli(
				{ GH_TOKEN: TOKEN },
				fakeFetch({ '/immutable-releases': { status: 200, body: { enabled: TOKEN } } }).fetch
			)
		];
		const bad = await runCli(['--repo', REPO, `--token=${TOKEN}`], {
			env: { GH_TOKEN: TOKEN },
			fetch: fakeFetch().fetch,
			expected,
			log: (l) => runs[0].lines.push(l)
		});
		expect(bad).toBe(1);
		for (const { lines } of runs) {
			for (const line of lines) expect(line).not.toContain(TOKEN);
		}
	});
});

describe('repo-settings.yml', () => {
	const file = '.github/workflows/repo-settings.yml';
	const yaml = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
	const code = yaml
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('#'))
		.join('\n');

	it('runs on push to main, on a schedule and by hand', () => {
		expect(code).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]\n/);
		expect(code).toMatch(/\n {2}schedule:\n {4}- cron: '[^']+'\n/);
		expect(code).toMatch(/\n {2}workflow_dispatch:\n/);
		expect(code).not.toMatch(/\n {2}pull_request(_target)?:/);
	});

	it('passes the workflow policy: SHA-pinned actions, contents: read only', () => {
		expect(checkWorkflow(file, yaml)).toEqual([]);
		expect(code).toMatch(/\npermissions:\n {2}contents: read\n/);
		expect(code.match(/permissions:/g)).toHaveLength(1);
	});

	it('runs no install', () => {
		expect(code).not.toMatch(/\b(pnpm|npm|yarn|npx|corepack)\b/);
		expect(code).not.toMatch(/action-setup/);
		expect(code).not.toMatch(/\binstall\b/);
	});

	it('exposes the token to the check step alone', () => {
		expect(code.match(/secrets\./g)).toHaveLength(1);
		const steps = code.split(/\n {6}- /).slice(1);
		const withSecret = steps.filter((step) => step.includes('secrets.'));
		expect(withSecret).toHaveLength(1);
		expect(withSecret[0]).toMatch(/^name: check repository security settings\n/);
		expect(withSecret[0]).toContain('GH_TOKEN: ${{ secrets.REPO_SETTINGS_TOKEN }}');
		expect(withSecret[0]).toContain(
			'run: node scripts/repo-settings.ts --repo "$GITHUB_REPOSITORY"'
		);
		// No workflow- or job-level env that could carry it further.
		expect(code).not.toMatch(/\n(?: {4})?env:\n/);
	});
});
