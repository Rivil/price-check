// Checks the live repository's security settings (c-9, c-10, c-11): the settings
// that protect a release live in GitHub, not in this repo, so a check against the API
// is the only way to notice one has drifted. .github/workflows/repo-settings.yml runs
// it on every push to main and daily; it is not a required check.
//
// Required:
// - an active tag ruleset on refs/tags/v* with creation, update, deletion and
//   non_fast_forward rules, whose only bypass actor is the admin role
//   (RepositoryRole 5);
// - the release environment as .github/environments/release.json describes it: only
//   tag-type deployment policies (v*), protected_branches false,
//   custom_branch_policies true, and no required reviewer (decision
//   release_env_reviewer);
// - immutable releases on;
// - Dependabot vulnerability alerts on.
//
// Fails closed: a missing token, a non-2xx answer or a network error is a violation,
// never a pass. The token is never printed. Node built-ins only, so the workflow runs
// it with no install: node scripts/repo-settings.ts --repo owner/name
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const RELEASE_ENV_FILE = resolve(ROOT, '.github/environments/release.json');
export const ENVIRONMENT = 'release';
export const TAG_PATTERN = 'refs/tags/v*';
export const REQUIRED_TAG_RULES = ['creation', 'update', 'deletion', 'non_fast_forward'] as const;
/** Exclude patterns that take some or all v* tags back out of the ruleset. */
const EXCLUDES_V_TAGS = new Set([TAG_PATTERN, 'refs/tags/*', 'refs/tags/**', '~ALL']);
/** The repository admin role: the only actor allowed to bypass the tag ruleset. */
export const ADMIN_ROLE = { actor_type: 'RepositoryRole', actor_id: 5 } as const;

export type RulesetDetail = {
	name: string;
	target: string;
	enforcement: string;
	conditions?: { ref_name?: { include?: string[]; exclude?: string[] } } | null;
	rules?: { type: string }[];
	bypass_actors?: { actor_type: string; actor_id: number | null; bypass_mode?: string }[];
};

export type EnvironmentDetail = {
	deployment_branch_policy: { protected_branches: boolean; custom_branch_policies: boolean } | null;
	protection_rules?: { type: string }[];
};

export type BranchPolicy = { name: string; type?: string };

export type Snapshot = {
	rulesets: RulesetDetail[];
	environment: EnvironmentDetail;
	branchPolicies: BranchPolicy[];
	immutableReleases: { enabled: boolean };
	vulnerabilityAlerts: boolean;
};

/** What .github/environments/release.json pins. */
export type ExpectedEnvironment = {
	deployment_branch_policy: { protected_branches: boolean; custom_branch_policies: boolean };
	policies: BranchPolicy[];
	reviewers: unknown[];
};

const policyKey = (p: BranchPolicy) => `${p.type ?? 'branch'}:${p.name}`;

/** Why one tag ruleset over refs/tags/v* falls short; empty when it holds. */
function tagRulesetGaps(ruleset: RulesetDetail): string[] {
	const gaps: string[] = [];
	const label = `tag ruleset '${ruleset.name}'`;
	if (ruleset.enforcement !== 'active') {
		gaps.push(`${label} enforcement is '${ruleset.enforcement}', not 'active'`);
	}
	const types = new Set((ruleset.rules ?? []).map((rule) => rule.type));
	for (const rule of REQUIRED_TAG_RULES) {
		if (!types.has(rule)) gaps.push(`${label} has no '${rule}' rule`);
	}
	const bypass = ruleset.bypass_actors ?? [];
	const onlyAdmin =
		bypass.length === 1 &&
		bypass[0].actor_type === ADMIN_ROLE.actor_type &&
		bypass[0].actor_id === ADMIN_ROLE.actor_id;
	if (!onlyAdmin) {
		const actors = bypass.map((a) => `${a.actor_type}:${a.actor_id}`).join(', ') || 'none';
		gaps.push(`${label} bypass actors must be exactly RepositoryRole:5 (admin), got ${actors}`);
	}
	return gaps;
}

/** Every way the snapshot falls short of the required settings. Pure. */
export function evaluate(snapshot: Snapshot, expected: ExpectedEnvironment): string[] {
	const violations: string[] = [];

	const tagRulesets = snapshot.rulesets.filter((r) => r.target === 'tag');
	const covering = tagRulesets.filter((r) =>
		(r.conditions?.ref_name?.include ?? []).includes(TAG_PATTERN)
	);
	for (const r of covering) {
		const excluded = (r.conditions?.ref_name?.exclude ?? []).filter((e) => EXCLUDES_V_TAGS.has(e));
		if (excluded.length > 0) {
			violations.push(
				`tag ruleset '${r.name}' excludes ${excluded.join(', ')}, which covers v* tags`
			);
		}
	}
	if (covering.length === 0) {
		const seen = tagRulesets.map(
			(r) => `'${r.name}' on ${(r.conditions?.ref_name?.include ?? []).join(', ') || 'nothing'}`
		);
		violations.push(
			`no tag ruleset includes ${TAG_PATTERN}${seen.length ? ` (tag rulesets: ${seen.join('; ')})` : ''}`
		);
	} else {
		const gaps = covering.map(tagRulesetGaps);
		if (!gaps.some((g) => g.length === 0)) violations.push(...gaps.flat());
	}

	const policy = snapshot.environment.deployment_branch_policy;
	const want = expected.deployment_branch_policy;
	if (policy === null) {
		violations.push(`environment '${ENVIRONMENT}' has no deployment branch policy`);
	} else {
		if (policy.protected_branches !== want.protected_branches) {
			violations.push(
				`environment '${ENVIRONMENT}' protected_branches is ${policy.protected_branches}, want ${want.protected_branches}`
			);
		}
		if (policy.custom_branch_policies !== want.custom_branch_policies) {
			violations.push(
				`environment '${ENVIRONMENT}' custom_branch_policies is ${policy.custom_branch_policies}, want ${want.custom_branch_policies}`
			);
		}
	}
	const have = snapshot.branchPolicies.map(policyKey).sort();
	const need = expected.policies.map(policyKey).sort();
	if (JSON.stringify(have) !== JSON.stringify(need)) {
		violations.push(
			`environment '${ENVIRONMENT}' deployment policies are [${have.join(', ')}], want [${need.join(', ')}]`
		);
	}
	const reviewers = (snapshot.environment.protection_rules ?? []).filter(
		(rule) => rule.type === 'required_reviewers'
	);
	if (reviewers.length > 0 && expected.reviewers.length === 0) {
		violations.push(
			`environment '${ENVIRONMENT}' has a required reviewer (decision release_env_reviewer: none)`
		);
	}

	if (snapshot.immutableReleases.enabled !== true) violations.push('immutable releases are off');
	if (!snapshot.vulnerabilityAlerts) violations.push('Dependabot vulnerability alerts are off');
	return violations;
}

export type FetchLike = (
	url: string,
	init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** A read that failed: the endpoint and a fixed reason, never a body or error text. */
class FailureAt extends Error {
	readonly path: string;
	readonly reason: string;
	constructor(path: string, reason: string) {
		super(`${path}: ${reason}`);
		this.path = path;
		this.reason = reason;
	}
}

/**
 * Reads the snapshot through the REST API. Every failure becomes a violation (a
 * fixed text naming the endpoint and status, never a response body or error text).
 */
export async function collect(
	repo: string,
	token: string | undefined,
	fetchImpl: FetchLike,
	expected: ExpectedEnvironment
): Promise<string[]> {
	if (token === undefined || token.trim() === '') {
		return ['GH_TOKEN is not set: cannot read the repository settings'];
	}
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
		return [`--repo must be owner/name, got '${repo}'`];
	}
	const headers = {
		accept: 'application/vnd.github+json',
		authorization: `Bearer ${token}`,
		'x-github-api-version': '2022-11-28',
		'user-agent': 'price-check-repo-settings'
	};
	const call = async (path: string): Promise<{ status: number; body: unknown }> => {
		let response: Awaited<ReturnType<FetchLike>>;
		try {
			response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
				headers,
				signal: AbortSignal.timeout(20_000)
			});
		} catch {
			// The error's text is not printed: report the endpoint only.
			throw new FailureAt(path, 'network error');
		}
		if (response.status === 204) return { status: 204, body: null };
		if (response.status < 200 || response.status > 299) {
			return { status: response.status, body: null };
		}
		try {
			return { status: response.status, body: await response.json() };
		} catch {
			// A 2xx whose body is not JSON cannot be read: fail closed.
			throw new FailureAt(path, 'unreadable response');
		}
	};
	const get = async <T>(path: string): Promise<T> => {
		const { status, body } = await call(path);
		if (status < 200 || status > 299) throw new FailureAt(path, `HTTP ${status}`);
		return body as T;
	};

	try {
		const list = await get<{ id: number; target?: string }[]>('/rulesets?per_page=100');
		const rulesets: RulesetDetail[] = [];
		for (const item of list) {
			if (item.target !== undefined && item.target !== 'tag') continue;
			rulesets.push(await get<RulesetDetail>(`/rulesets/${item.id}`));
		}
		const environment = await get<EnvironmentDetail>(`/environments/${ENVIRONMENT}`);
		const { branch_policies } = await get<{ branch_policies: BranchPolicy[] }>(
			`/environments/${ENVIRONMENT}/deployment-branch-policies?per_page=100`
		);
		const immutable = await call('/immutable-releases');
		if (immutable.status !== 200 && immutable.status !== 404) {
			throw new FailureAt('/immutable-releases', `HTTP ${immutable.status}`);
		}
		const alerts = await call('/vulnerability-alerts');
		if (alerts.status !== 204 && alerts.status !== 404) {
			throw new FailureAt('/vulnerability-alerts', `HTTP ${alerts.status}`);
		}
		return evaluate(
			{
				rulesets,
				environment,
				branchPolicies: branch_policies,
				immutableReleases: {
					enabled:
						immutable.status === 200 && (immutable.body as { enabled?: unknown })?.enabled === true
				},
				vulnerabilityAlerts: alerts.status === 204
			},
			expected
		);
	} catch (error) {
		if (error instanceof FailureAt) return [`cannot read ${error.path}: ${error.reason}`];
		// Anything else is a bug in the checker: still a failure, never a pass.
		return ['the settings check failed unexpectedly'];
	}
}

/** release.json's environment, as evaluate() expects it. */
export function readExpectedEnvironment(file = RELEASE_ENV_FILE): ExpectedEnvironment {
	return JSON.parse(readFileSync(file, 'utf8')) as ExpectedEnvironment;
}

export type CliDeps = {
	env: NodeJS.ProcessEnv;
	fetch: FetchLike;
	expected: ExpectedEnvironment;
	log: (line: string) => void;
};

/** The CLI: 0 when every setting holds, 1 on any violation or failure to read. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const token = deps.env.GH_TOKEN;
	const scrub = (line: string) =>
		token !== undefined && token !== '' ? line.split(token).join('[token]') : line;
	let repo: string;
	try {
		const { values } = parseArgs({
			args: argv,
			strict: true,
			allowPositionals: false,
			options: { repo: { type: 'string' } }
		});
		repo = values.repo ?? deps.env.GITHUB_REPOSITORY ?? '';
	} catch (error) {
		deps.log(scrub(`repo-settings: ${error instanceof Error ? error.message : String(error)}`));
		return 1;
	}
	const violations = await collect(repo, token, deps.fetch, deps.expected);
	for (const line of violations) deps.log(scrub(`repo-settings: ${line}`));
	deps.log(scrub(`repo-settings: ${repo || '(no repo)'}: ${violations.length} violation(s)`));
	return violations.length === 0 ? 0 : 1;
}

// import.meta.main is missing on Node < 24.2; fall back to argv.
const isEntry =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) {
	process.exitCode = await runCli(process.argv.slice(2), {
		env: process.env,
		fetch: (url, init) => fetch(url, init),
		expected: readExpectedEnvironment(),
		log: (line) => console.log(line)
	});
}
