// Keeps .github/rulesets/*.json (applied with `gh api`, spec c-4) in step with the
// checks .github/workflows/ci.yml actually produces, and pins the locked decisions
// gated_refs (main + milestone/*) and protection_bypass (admin only).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

type Rule = { type: string; parameters?: Record<string, unknown> };
type Ruleset = {
	name: string;
	enforcement: string;
	bypass_actors: unknown[];
	conditions: { ref_name: { include: string[] } };
	rules: Rule[];
};

const rulesets: Record<string, Ruleset> = {
	main: JSON.parse(read('.github/rulesets/main.json')),
	milestone: JSON.parse(read('.github/rulesets/milestone.json'))
};

/** Check names ci.yml reports: each job's `name:` (its id when unnamed), matrix expanded. */
function ciCheckNames(yaml: string): string[] {
	const jobs = yaml.slice(yaml.indexOf('\njobs:\n') + '\njobs:\n'.length);
	const blocks = jobs.split(/^(?= {2}[\w-]+:\s*$)/m).filter((block) => /^ {2}[\w-]+:/.test(block));
	return blocks.flatMap((block) => {
		const id = /^ {2}([\w-]+):/.exec(block)![1];
		const name = /^ {4}name: (.+)$/m.exec(block)?.[1].trim() ?? id;
		const matrix = [...block.matchAll(/^ {10}- name: (\S+)$/gm)].map((m) => m[1]);
		return name.includes('${{ matrix.name }}')
			? matrix.map((m) => name.replace('${{ matrix.name }}', m))
			: [name];
	});
}

const ACTIONS_APP = 15368;
const expected = ciCheckNames(read('.github/workflows/ci.yml'));

describe('rulesets', () => {
	it('an unnamed job counts by its id', () => {
		const yaml = 'on: x\njobs:\n  lint:\n    runs-on: a\n  build:\n    name: b\n    runs-on: a\n';
		expect(ciCheckNames(yaml)).toEqual(['lint', 'b']);
	});

	it('ci.yml produces the five gate checks', () => {
		expect([...expected].sort()).toEqual(
			['gitleaks', 'static', 'test (linux)', 'test (macos)', 'test (windows)'].sort()
		);
	});

	it.each(Object.entries(rulesets))('%s: contexts match jobs', (_name, ruleset) => {
		const rule = ruleset.rules.find((r) => r.type === 'required_status_checks');
		const checks = (rule?.parameters?.required_status_checks ?? []) as {
			context: string;
			integration_id: number;
		}[];
		expect(checks.map((c) => c.context).sort()).toEqual([...expected].sort());
		for (const check of checks) expect(check.integration_id).toBe(ACTIONS_APP);
	});

	it.each(Object.entries(rulesets))('%s: requires a PR with no approvals', (_name, ruleset) => {
		const rule = ruleset.rules.find((r) => r.type === 'pull_request');
		expect(rule?.parameters).toEqual({
			required_approving_review_count: 0,
			dismiss_stale_reviews_on_push: false,
			require_code_owner_review: false,
			require_last_push_approval: false,
			required_review_thread_resolution: false,
			require_extra_approval_for_unattributed_changes: false,
			allowed_merge_methods: ['merge', 'squash']
		});
	});

	it.each(Object.entries(rulesets))('%s: active, admin-only bypass', (_name, ruleset) => {
		expect(ruleset.enforcement).toBe('active');
		expect(ruleset.bypass_actors).toEqual([
			{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }
		]);
	});

	it('targets main and every milestone branch', () => {
		expect(rulesets.main.conditions.ref_name.include).toEqual(['refs/heads/main']);
		expect(rulesets.milestone.conditions.ref_name.include).toEqual(['refs/heads/milestone/**']);
		expect(rulesets.main.name).toBe('ci: main');
		expect(rulesets.milestone.name).toBe('ci: milestones');
	});

	it('main also blocks deletion and force-push; milestones stay deletable', () => {
		const types = (r: Ruleset) => r.rules.map((rule) => rule.type);
		expect(types(rulesets.main)).toEqual(expect.arrayContaining(['deletion', 'non_fast_forward']));
		expect(types(rulesets.milestone)).not.toContain('deletion');
	});
});

// c-1: the gate checks only mean something if their jobs run the right commands.
describe('ci.yml steps', () => {
	const yaml = read('.github/workflows/ci.yml');
	/** The text of one job, from its id line to the next job id. */
	const job = (id: string) => {
		const jobs = yaml.slice(yaml.indexOf('\njobs:\n'));
		const start = jobs.search(new RegExp(`^ {2}${id}:\\s*$`, 'm'));
		expect(start, `job ${id}`).toBeGreaterThan(-1);
		const rest = jobs.slice(start + 1);
		const next = rest.search(/^ {2}[\w-]+:\s*$/m);
		return next === -1 ? rest : rest.slice(0, next);
	};
	const runs = (block: string) => [...block.matchAll(/^\s+run: (.+)$/gm)].map((m) => m[1].trim());

	it('static runs lint, typecheck and the workflow policy', () => {
		expect(runs(job('static'))).toEqual(
			expect.arrayContaining(['pnpm lint', 'pnpm check', 'pnpm ci:policy'])
		);
	});

	it('test runs the unit and e2e suites', () => {
		expect(runs(job('test'))).toEqual(
			expect.arrayContaining(['pnpm test:unit --run', 'pnpm test:e2e'])
		);
	});

	it('no gate step can pass while failing: no continue-on-error, only if: failure() on the report upload', () => {
		expect(yaml).not.toMatch(/continue-on-error/);
		const ifs = [...yaml.matchAll(/^[\s-]+if:\s*(.+)$/gm)];
		expect(ifs.map((m) => m[1].trim())).toEqual(['failure()']);
		const after = yaml.slice(yaml.indexOf('if: failure()'));
		expect(after.split('\n')[1]).toMatch(/uses: actions\/upload-artifact@/);
	});

	it('gitleaks scans the full history of HEAD with the repo config and fails on findings', () => {
		const block = job('gitleaks');
		expect(block).toMatch(/fetch-depth: 0/);
		expect(block).toMatch(/gitleaks" git --log-opts=HEAD --config \.gitleaks\.toml/);
		expect(block).toMatch(/--exit-code 1/);
		expect(block).toMatch(/sha256sum -c --strict/);
	});
});
