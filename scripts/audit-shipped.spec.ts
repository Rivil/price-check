import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHIPPED_DEV, runAudit } from './audit-shipped.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const packageJson = JSON.parse(read('package.json')) as {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
};

/**
 * One advisory as `pnpm audit --json` (pnpm 10) prints it, cut from a real run on
 * this repo (GHSA-67mh-4wv8-2f99, trimmed to the fields the script reads plus a few
 * it ignores). Each fixture below changes only the module, severity and paths.
 */
const REAL_ADVISORY = {
	findings: [
		{
			version: '0.18.20',
			paths: ['.>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild']
		}
	],
	id: 1102341,
	title: 'esbuild enables any website to send any requests to the development server',
	severity: 'moderate',
	module_name: 'esbuild',
	vulnerable_versions: '<=0.24.2',
	github_advisory_id: 'GHSA-67mh-4wv8-2f99',
	patched_versions: '>=0.25.0',
	url: 'https://github.com/advisories/GHSA-67mh-4wv8-2f99'
};

const REAL_METADATA = {
	vulnerabilities: { info: 0, low: 0, moderate: 7, high: 0, critical: 0 },
	dependencies: 1201,
	devDependencies: 0,
	optionalDependencies: 0,
	totalDependencies: 1201
};

function advisory(module: string, severity: string, paths: string[], id = 900001) {
	return {
		...REAL_ADVISORY,
		id,
		module_name: module,
		severity,
		findings: [{ version: '1.0.0', paths }]
	};
}

function report(...advisories: ReturnType<typeof advisory>[]): string {
	return JSON.stringify({
		actions: [],
		advisories: Object.fromEntries(advisories.map((a) => [String(a.id), a])),
		muted: [],
		metadata: REAL_METADATA
	});
}

const CLEAN = report(advisory('esbuild', 'moderate', REAL_ADVISORY.findings[0].paths));

function run(root: string, signing = CLEAN) {
	const lines: string[] = [];
	const code = runAudit(
		[
			{ tree: 'root', text: root },
			{ tree: 'signing', text: signing }
		],
		packageJson,
		(line) => lines.push(line)
	);
	return { code, lines };
}

describe('runAudit', () => {
	it('passes the real tree as captured (moderates only, all reported)', () => {
		const { code, lines } = run(CLEAN);
		expect(code).toBe(0);
		expect(lines.some((l) => l.startsWith('audit-shipped: note root: moderate esbuild'))).toBe(
			true
		);
	});

	it.each([
		['kit > devalue', advisory('devalue', 'high', ['.>@sveltejs/kit>devalue'])],
		['electron', advisory('electron', 'critical', ['.>electron'])],
		[
			'electron transitive',
			advisory('extract-zip', 'high', ['.>electron>@electron/get>extract-zip'])
		],
		['nodemailer (production)', advisory('nodemailer', 'high', ['.>nodemailer'])],
		['only through svelte', advisory('acorn', 'high', ['.>svelte>acorn'])],
		['adapter-node', advisory('rollup', 'high', ['.>@sveltejs/adapter-node>rollup'])],
		[
			'shipped and dev paths together',
			advisory('esbuild', 'high', ['.>drizzle-kit>esbuild', '.>@sveltejs/kit>vite>esbuild'])
		],
		['an unknown severity', advisory('devalue', 'severe', ['.>@sveltejs/kit>devalue'])],
		['no paths at all', advisory('mystery', 'high', [])]
	])('fails on a shipped high advisory: %s', (_what, shipped) => {
		const { code, lines } = run(report(shipped));
		expect(code).toBe(1);
		expect(
			lines.some(
				(l) => l.startsWith(`audit-shipped: FAIL root:`) && l.includes(shipped.module_name)
			)
		).toBe(true);
	});

	it('fails on any high advisory in the signing tree', () => {
		const signing = report(
			advisory('minimatch', 'high', ['.>electron-builder>app-builder-lib>minimatch'])
		);
		const { code, lines } = run(CLEAN, signing);
		expect(code).toBe(1);
		expect(lines).toContainEqual(
			expect.stringMatching(/^audit-shipped: FAIL signing: high minimatch/)
		);
	});

	it.each([
		['drizzle-kit > esbuild', advisory('esbuild', 'high', ['.>drizzle-kit>esbuild'])],
		['vitest', advisory('vite', 'critical', ['.>vitest>vite'])],
		['Stryker', advisory('qs', 'high', ['.>@stryker-mutator/core>typed-rest-client>qs'])],
		['a moderate on kit', advisory('cookie', 'moderate', ['.>@sveltejs/kit>cookie'])],
		['a low on electron', advisory('got', 'low', ['.>electron>@electron/get>got'])]
	])('reports but passes: %s', (_what, devOnly) => {
		const { code, lines } = run(report(devOnly));
		expect(code).toBe(0);
		expect(
			lines.some(
				(l) => l.startsWith('audit-shipped: note root:') && l.includes(devOnly.module_name)
			)
		).toBe(true);
	});

	it.each([
		['empty', ''],
		['whitespace', '  \n'],
		['not JSON', 'ERR_PNPM_AUDIT_BAD_RESPONSE The audit endpoint responded with 503'],
		['truncated', CLEAN.slice(0, CLEAN.length / 2)],
		['an error object', JSON.stringify({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } })],
		['an array', '[]'],
		['no advisories map', JSON.stringify({ actions: [], metadata: REAL_METADATA })],
		['no metadata', JSON.stringify({ actions: [], advisories: {} })]
	])('fails closed on %s output', (_what, text) => {
		expect(run(text).code, 'root').toBe(1);
		expect(run(CLEAN, text).code, 'signing').toBe(1);
	});
});

describe('shipped devDependencies', () => {
	it('every SHIPPED_DEV name is a devDependency', () => {
		for (const name of SHIPPED_DEV) expect(packageJson.devDependencies, name).toHaveProperty(name);
	});
});

describe('audit.yml', () => {
	const yaml = read('.github/workflows/audit.yml');
	const code = yaml
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('#'))
		.join('\n');

	it('audits the full tree, not --prod, and the signing tree', () => {
		expect(code).not.toMatch(/--prod\b/);
		expect(code).toMatch(/pnpm audit --json > "\$RUNNER_TEMP\/audit-root\.json"/);
		expect(code).toMatch(
			/pnpm --dir signing audit --ignore-workspace --json > "\$RUNNER_TEMP\/audit-signing\.json"/
		);
	});

	it('feeds both reports to audit-shipped.ts', () => {
		expect(code).toMatch(
			/node scripts\/audit-shipped\.ts "\$RUNNER_TEMP\/audit-root\.json" "\$RUNNER_TEMP\/audit-signing\.json"/
		);
	});

	it('runs no install', () => {
		expect(code).not.toMatch(/\binstall\b/);
		expect(code).not.toMatch(/\bnpm (ci|i)\b/);
	});
});
