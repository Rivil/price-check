// Pins .github/environments/release.json, the GitHub environment 'release' as applied
// with `gh api` (decision release_secrets): only tags matching v* may deploy to it, so
// only a release tag's run can read the signing secrets. A branch-type 'v*' policy
// would let a branch named v1 read them. The file holds no secret names or values:
// those are set in the GitHub UI, never committed.
//
// Applied with:
//   jq '{wait_timer, prevent_self_review, reviewers, deployment_branch_policy}' \
//     .github/environments/release.json \
//     | gh api -X PUT repos/Rivil/price-check/environments/release --input -
//   gh api -X POST repos/Rivil/price-check/environments/release/deployment-branch-policies \
//     -f name='v*' -f type=tag
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const release = JSON.parse(
	readFileSync(new URL('../.github/environments/release.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

/** Every object key in a JSON value, at any depth. */
function keys(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(keys);
	if (value !== null && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]);
	}
	return [];
}

describe('release environment', () => {
	it('is the environment named release', () => {
		expect(release.name).toBe('release');
	});

	it('deploys only from custom policies, never from any protected branch', () => {
		expect(release.deployment_branch_policy).toEqual({
			protected_branches: false,
			custom_branch_policies: true
		});
	});

	it('has exactly one policy: tags matching v*', () => {
		expect(release.policies).toEqual([{ name: 'v*', type: 'tag' }]);
	});

	it('needs no reviewer and no wait: the tag gate is the check', () => {
		expect(release.reviewers).toEqual([]);
		expect(release.wait_timer).toBe(0);
	});

	it('names no secret', () => {
		expect(keys(release).length).toBeGreaterThan(0);
		expect(keys(release).filter((key) => /secret|CSC_|APPLE_/i.test(key))).toEqual([]);
	});

	it('the key check sees nested keys', () => {
		expect(keys({ a: [{ secrets: { CSC_LINK: 'x' } }] })).toEqual(['a', 'secrets', 'CSC_LINK']);
	});
});
