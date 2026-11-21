// Pins spec c-12 (SEC-10): the root lockfile resolves the patched SvelteKit and
// adapter-node releases, and no peer drags an unpatched second copy back in.
// Also pins @electron/fuses as an exact devDependency: the fuse wire the released
// app is tested against (c-8) must not drift with a transitive bump.
//
// No YAML library (same reason as scripts/workflow-reader.ts: no new supply-chain
// dependency). It reads only the pnpm v9 lockfile shape: top-level sections at
// column 0, entries at 2, keys at 4, importer dependency fields at 6.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	devDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
};

const unquote = (s: string) => s.trim().replace(/^'(.*)'$/, '$1');

/** The lines of a top-level section (`importers:`, `packages:`…), header excluded. */
function section(name: string): string[] {
	const lines = lock.split('\n');
	const start = lines.indexOf(`${name}:`);
	if (start < 0) throw new Error(`pnpm-lock.yaml has no ${name}: section`);
	const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
	return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** importers['.'] dependency name → resolved version, across every dependency kind. */
function rootResolved(): Map<string, string> {
	const out = new Map<string, string>();
	let inRoot = false;
	let name: string | undefined;
	for (const line of section('importers')) {
		const entry = /^ {2}(\S.*):\s*$/.exec(line);
		if (entry) {
			inRoot = unquote(entry[1]) === '.';
			continue;
		}
		if (!inRoot) continue;
		const dep = /^ {6}(\S.*):\s*$/.exec(line);
		if (dep) {
			name = unquote(dep[1]);
			continue;
		}
		const version = /^ {8}version:\s*(\S+)/.exec(line);
		if (version && name) out.set(name, unquote(version[1]));
	}
	return out;
}

/** Entry keys (`name@version(peers…)`) of a top-level section. */
const keys = (name: string) =>
	section(name)
		.map((l) => /^ {2}(\S.*):(?:\s*\{\})?\s*$/.exec(l)?.[1])
		.filter((k): k is string => k !== undefined)
		.map(unquote);

/** A resolved version without its peer suffix: `6.0.1(@sveltejs/kit@…)` → `6.0.1`. */
const bare = (version: string) => version.replace(/\(.*$/, '');

/** x.y.z as numbers; throws on anything else so a prerelease can't slip through as "newer". */
function triple(version: string): [number, number, number] {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!m) throw new Error(`not a plain x.y.z release: ${version}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a >= b on x.y.z. */
function atLeast(a: string, b: string): boolean {
	const [x, y] = [triple(a), triple(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
	return true;
}

const PATCHED = [
	['@sveltejs/kit', '3.1.1', '3.1.0'],
	['@sveltejs/adapter-node', '6.0.1', '6.0.0']
] as const;

describe('pnpm-lock.yaml', () => {
	it('reads the root importer', () => {
		const root = rootResolved();
		expect(root.size).toBeGreaterThan(20);
		expect(root.has('vite')).toBe(true);
	});

	it.each(PATCHED)('kit and adapter-node at patched versions: %s >= %s', (name, floor) => {
		const resolved = rootResolved().get(name);
		expect(resolved, `${name} missing from importers['.']`).toBeDefined();
		const version = bare(resolved!);
		expect(atLeast(version, floor), `${name} resolves ${version}`).toBe(true);
	});

	it.each(PATCHED)('no unpatched copy of %s in packages or snapshots', (name, _floor, bad) => {
		const all = [...keys('packages'), ...keys('snapshots')];
		expect(all.some((k) => k.startsWith(`${name}@`))).toBe(true);
		expect(all.filter((k) => bare(k) === `${name}@${bad}`)).toEqual([]);
	});
});

describe('package.json', () => {
	it('@electron/fuses is an exact x.y.z devDependency', () => {
		const spec = pkg.devDependencies?.['@electron/fuses'];
		expect(spec, '@electron/fuses not in devDependencies').toBeDefined();
		expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
