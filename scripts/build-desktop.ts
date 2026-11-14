// pnpm build:desktop [entry] — bundles the Electron main process (spec c-1).
//
// One ESM file, dist-desktop/main.js (package.json `main`), platform node. Our own
// code is inlined, #lib/* included: those subpath imports point at .ts files, which
// Electron cannot load. Bare package imports stay external: `electron` is provided by
// Electron at runtime, and the adapter's build/handler.js loads node_modules at runtime
// anyway. It also means esbuild never resolves into node_modules, so a stray Yarn PnP
// manifest in a parent directory cannot fail the build.
//
// Refused imports, wherever in the graph they appear:
// - $app/* — SvelteKit virtual modules; they only exist inside the Kit build.
// - @libsql/*, libsql, drizzle-orm/libsql — a second libsql client in main would hold
//   its own handle on the DB file (and lock it on Windows). The server bundle owns
//   the only one.
//
// Runs under Node type stripping: erasable syntax only, no $app/* imports.
import {
	build,
	type BuildOptions,
	type BuildResult,
	type Plugin,
	type StdinOptions
} from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: every relative path below resolves against it, whatever the cwd. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ENTRY = 'src/desktop/main.ts';
/** Must equal package.json `main`; build-desktop.spec pins the two together. */
export const OUTFILE = 'dist-desktop/main.js';

// esbuild filters are Go regexps: no lookaround.
const REFUSED = /^(\$app(\/|$)|@libsql\/|libsql(\/|$)|drizzle-orm\/libsql(\/|$))/;

function reason(path: string): string {
	return path.startsWith('$app')
		? 'SvelteKit virtual modules exist only inside the Kit build'
		: 'the server bundle owns the only libsql client';
}

const refuseServerOnlyImports: Plugin = {
	name: 'desktop-import-boundary',
	setup(b) {
		b.onResolve({ filter: REFUSED }, (args) => ({
			errors: [
				{ text: `'${args.path}' is not allowed in the desktop main bundle: ${reason(args.path)}` }
			]
		}));
	}
};

export type DesktopBuildInput = {
	/** Entry file relative to the repo root; ignored when stdin is given. */
	entry?: string;
	/** Inline entry source (spec fixtures); set resolveDir to the repo root. */
	stdin?: StdinOptions;
	/** false keeps the bundle in memory (result.outputFiles). */
	write?: boolean;
	logLevel?: BuildOptions['logLevel'];
};

export function desktopBuildOptions(input: DesktopBuildInput = {}): BuildOptions {
	return {
		absWorkingDir: ROOT,
		...(input.stdin ? { stdin: input.stdin } : { entryPoints: [input.entry ?? DEFAULT_ENTRY] }),
		outfile: OUTFILE,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node24',
		packages: 'external',
		external: ['electron'],
		plugins: [refuseServerOnlyImports],
		write: input.write ?? true,
		logLevel: input.logLevel ?? 'silent'
	};
}

export function buildDesktop(input: DesktopBuildInput = {}): Promise<BuildResult> {
	return build(desktopBuildOptions(input));
}

// import.meta.main is missing on Node < 24.2; fall back to argv.
const isEntry =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) {
	const entry = process.argv[2] ?? DEFAULT_ENTRY;
	try {
		// 'warning' prints esbuild's own diagnostics, errors included.
		await buildDesktop({ entry, logLevel: 'warning' });
		console.log(`build:desktop: ${entry} -> ${OUTFILE}`);
	} catch {
		process.exit(1);
	}
}
