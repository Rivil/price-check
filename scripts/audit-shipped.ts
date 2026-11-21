// Audits what the app actually ships (c-11, SEC-10). `pnpm audit --prod` saw only
// package.json's dependencies, but electron, SvelteKit, svelte and adapter-node are
// devDependencies whose code ends up in the release, and the release signing job
// installs signing/'s own tree. So .github/workflows/audit.yml feeds `pnpm audit --json`
// over the full tree and over signing/ to this script, which fails on a high or
// critical advisory that ships:
//
// - in the root tree, when its path starts at a production dependency or at one of
//   SHIPPED_DEV (a transitive dependency reached through svelte ships too);
// - anywhere in the signing tree, which runs beside the signing secrets.
//
// Advisories that reach only dev tooling (drizzle-kit, vitest, Stryker...) and
// moderate or low ones are reported, not fatal. Output it cannot read (not JSON,
// empty, truncated, an error object) fails closed.
//
//   node scripts/audit-shipped.ts <root-audit.json> <signing-audit.json>
//
// Node built-ins only: the workflow runs it with no install.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** devDependencies whose code is bundled into or runs as the shipped app. */
export const SHIPPED_DEV = [
	'electron',
	'@sveltejs/kit',
	'svelte',
	'@sveltejs/adapter-node'
] as const;

/** Severities that fail the audit when they ship. */
export const FATAL = new Set(['high', 'critical']);

type Finding = { version?: string; paths?: string[] };
type Advisory = {
	id?: number;
	module_name?: string;
	severity?: string;
	title?: string;
	url?: string;
	findings?: Finding[];
};

export type AuditReport = { advisories: Record<string, Advisory> };

export type TreeName = 'root' | 'signing';

/** The report, or why it cannot be trusted. */
export function parseAudit(text: string): AuditReport | string {
	if (text.trim() === '') return 'empty audit output';
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// Truncated or not JSON at all: never a pass.
		return 'audit output is not JSON';
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return 'audit output is not a report object';
	}
	const report = value as Record<string, unknown>;
	if ('error' in report) return 'pnpm audit reported an error';
	const { advisories, metadata } = report;
	if (typeof advisories !== 'object' || advisories === null || Array.isArray(advisories)) {
		return 'audit output has no advisories map';
	}
	if (typeof metadata !== 'object' || metadata === null) return 'audit output has no metadata';
	return { advisories: advisories as Record<string, Advisory> };
}

/** The direct dependency a path like '.>@sveltejs/kit>devalue' starts at. */
export function pathRoot(path: string): string | null {
	const parts = path.split('>');
	return parts[0] === '.' && parts[1] ? parts[1] : null;
}

export type Verdict = { fatal: string[]; notes: string[] };

/**
 * Sorts every advisory in one tree into fatal (a high or critical one that ships)
 * or a note. `shipped` is the set of direct dependencies whose code ships.
 */
export function classify(
	tree: TreeName,
	report: AuditReport,
	shipped: ReadonlySet<string>
): Verdict {
	const verdict: Verdict = { fatal: [], notes: [] };
	for (const [key, advisory] of Object.entries(report.advisories)) {
		const severity = advisory.severity ?? 'unknown';
		const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []);
		const label = `${severity} ${advisory.module_name ?? '?'} (${advisory.url ?? `advisory ${advisory.id ?? key}`})`;
		const shippingPaths =
			tree === 'signing' ? paths : paths.filter((path) => shipped.has(pathRoot(path) ?? ''));
		// An advisory with no path at all cannot be placed: treat it as shipped.
		const ships = tree === 'signing' || paths.length === 0 || shippingPaths.length > 0;
		const via = (shippingPaths.length > 0 ? shippingPaths : paths).slice(0, 3).join(', ');
		const line = `${tree}: ${label}${via ? ` via ${via}` : ''}`;
		const fatal = ships && (FATAL.has(severity) || !['low', 'moderate', 'info'].includes(severity));
		(fatal ? verdict.fatal : verdict.notes).push(line);
	}
	return verdict;
}

/** Production dependencies plus SHIPPED_DEV, from package.json. */
export function shippedRoots(packageJson: { dependencies?: Record<string, string> }): Set<string> {
	return new Set([...Object.keys(packageJson.dependencies ?? {}), ...SHIPPED_DEV]);
}

/** The CLI: 0 when nothing shipped has a high or critical advisory, 1 otherwise. */
export function runAudit(
	inputs: { tree: TreeName; text: string }[],
	packageJson: { dependencies?: Record<string, string> },
	log: (line: string) => void
): number {
	const shipped = shippedRoots(packageJson);
	let failed = false;
	for (const { tree, text } of inputs) {
		const report = parseAudit(text);
		if (typeof report === 'string') {
			log(`audit-shipped: FAIL ${tree}: ${report}`);
			failed = true;
			continue;
		}
		const { fatal, notes } = classify(tree, report, shipped);
		for (const line of fatal) log(`audit-shipped: FAIL ${line}`);
		for (const line of notes) log(`audit-shipped: note ${line}`);
		if (fatal.length > 0) failed = true;
	}
	log(`audit-shipped: ${failed ? 'failed' : 'nothing shipped has a high or critical advisory'}`);
	return failed ? 1 : 0;
}

// import.meta.main is missing on Node < 24.2; fall back to argv.
const isEntry =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) {
	const [rootFile, signingFile] = process.argv.slice(2);
	const read = (file: string | undefined) => {
		if (file === undefined) return '';
		try {
			return readFileSync(file, 'utf8');
		} catch {
			// A missing file reads as empty, which parseAudit fails closed on.
			return '';
		}
	};
	process.exitCode = runAudit(
		[
			{ tree: 'root', text: read(rootFile) },
			{ tree: 'signing', text: read(signingFile) }
		],
		JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>;
		},
		(line) => console.log(line)
	);
}
