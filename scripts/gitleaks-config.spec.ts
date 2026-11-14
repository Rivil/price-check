// c-3: the gitleaks allowlist stays narrow. Every entry names its rule and exact
// files; generic-api-key entries also pin the fake value (condition AND), so a new
// real key in an allowlisted file is still reported. No stopwords, no global paths.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8');
const [head, ...entries] = config.split(/^\[\[allowlists\]\]\s*$/m);

/** The '''…''' strings of one array key in an entry. */
function list(entry: string, key: string): string[] | undefined {
	// Up to the ] that ends a line, so a ] inside a path's character class can't cut it short.
	const m = new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*$`, 'm').exec(entry);
	return m ? [...m[1].matchAll(/'''(.*?)'''|"(.*?)"/g)].map((x) => x[1] ?? x[2]) : undefined;
}
const value = (entry: string, key: string) =>
	new RegExp(`^${key}\\s*=\\s*"(.*?)"`, 'm').exec(entry)?.[1];

describe('.gitleaks.toml', () => {
	it('extends the default rules and has allowlist entries', () => {
		expect(head).toMatch(/^\[extend\]\s*\nuseDefault = true/m);
		expect(entries.length).toBeGreaterThan(0);
	});

	it('has no global allowlist, stopwords or ignore-everything switches', () => {
		expect(config).not.toMatch(/^\s*\[allowlist\]/m);
		expect(config).not.toMatch(/^\s*stopwords\s*=/m);
		// No custom rules: a [[rules]] table or a rule-scoped allowlist would sit outside
		// the [[allowlists]] entries these checks cover.
		expect(config).not.toMatch(/^\s*\[\[?\s*rules\s*[\].]/m);
		expect(config).not.toMatch(/^\s*rules\s*=/m);
		// Nor may a default rule be switched off wholesale.
		expect(config).not.toMatch(/disabledRules/);
	});

	it.each(entries.map((entry, i) => [i, entry] as const))(
		'entry %i names its rules and only exact anchored files',
		(_i, entry) => {
			expect(list(entry, 'targetRules')?.length).toBeGreaterThan(0);
			const paths = list(entry, 'paths') ?? [];
			expect(paths.length).toBeGreaterThan(0);
			for (const path of paths) {
				expect(path, path).toMatch(/^\^.+\$$/);
				// Exact files only: the only regex syntax allowed is ^, $ and escaped dots.
				const body = path.slice(1, -1).replace(/\\\./g, '');
				expect(body, path).not.toMatch(/[\\^$.*+?()[\]{}|]/);
			}
		}
	);

	const generic = entries
		.map((entry, i) => [i, entry] as const)
		.filter(([, entry]) => list(entry, 'targetRules')?.includes('generic-api-key'));

	// dross verify writes each phase's tests.json with survivor ids that read as keys.
	// A phase missing here fails the gitleaks job only once verify has run for it.
	it('every phase allowlisted: each phase with a spec.toml has its exact tests.json path', () => {
		// A branch that ships without .dross/phases has no phase to check, but 03 is
		// always required, so the allowlist can never quietly lose this phase.
		const phasesDir = new URL('../.dross/phases/', import.meta.url);
		const onDisk = existsSync(phasesDir)
			? readdirSync(phasesDir, { withFileTypes: true })
					.filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/spec.toml`, phasesDir)))
					.map((d) => d.name)
			: [];
		const phases = new Set(['03-desktop-shell', ...onDisk]);
		const testsJson = entries.filter((entry) =>
			(list(entry, 'paths') ?? []).some((p) => p.endsWith('/tests\\.json$'))
		);
		expect(testsJson).toHaveLength(1);
		const paths = list(testsJson[0], 'paths') ?? [];
		for (const id of phases) {
			expect(paths, id).toContain(`^\\.dross/phases/${id.replace(/\./g, '\\.')}/tests\\.json$`);
		}
	});

	it('has generic-api-key entries to check', () => {
		expect(generic.length).toBeGreaterThan(0);
	});

	it.each(generic)(
		'entry %i: a generic-api-key allowance also pins the value (condition AND)',
		(_i, entry) => {
			expect(value(entry, 'condition')).toBe('AND');
			const regexes = list(entry, 'regexes') ?? [];
			expect(regexes.length).toBeGreaterThan(0);
			for (const re of regexes) expect(re, re).not.toMatch(/^\.\*$|^\.\+$/);
		}
	);
});
