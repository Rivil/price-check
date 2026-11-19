// pnpm package:desktop --version <v> [--feed-url <loopback>] [--sign] [--out <dir>]
//
// Packages the desktop app with electron-builder for the host OS only (decision
// artefacts: each OS packages on its own runner), never publishing: release.yml's
// publish job uploads the files. Needs `pnpm build` (build/handler.js) and
// `pnpm build:desktop` (dist-desktop/main.js) first.
//
// - macOS: one universal app, dmg to install and zip for updates. Both
//   @libsql/darwin-* binaries ship; they are single-arch and identical in the x64 and
//   arm64 halves, so x64ArchFiles lets @electron/universal skip lipo for them.
// - Windows: x64 one-click NSIS installed per user (no UAC prompt), never signed.
// - Linux: x64 AppImage only, Chromium sandbox kept (no --no-sandbox).
// libsql's .node files cannot load from inside app.asar, so libsql and the
// @libsql/<platform> binaries are unpacked, and never rebuilt (prebuilt N-API). The
// migrator reads drizzle/ as a folder, so it is unpacked too.
//
// Signing: an unsigned run (the default; PRs and local) sets
// CSC_IDENTITY_AUTO_DISCOVERY=false and mac.identity null. --sign is macOS-only and
// refuses unless the five release_secrets variables are set, naming only the missing
// ones: electron-builder would otherwise skip notarisation with just a warning.
//
// The builder is a type-only import here; the CLI loads it at run time, so the spec
// can drive packageDesktop() with a fake build().
import type { CliOptions, Configuration } from 'electron-builder';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { APP_ID } from '../src/desktop/app-id.ts';

/** Repo root: electron-builder's projectDir, whatever the cwd. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The app's display name: the .app bundle, Start Menu entry and uninstall DisplayName. */
export const PRODUCT_NAME = 'Price Check';

/**
 * Every artefact's file name. No whitespace and no ${productName}: GitHub renames
 * 'Price Check' uploads to 'Price.Check', and the latest*.yml files would then name
 * files the release does not have.
 */
export const ARTIFACT_NAME = 'price-check-${version}-${os}-${arch}.${ext}';

export const DEFAULT_OUT = 'dist-packaged';

/**
 * electron-builder never packs its buildResources dir. Its default is 'build', which
 * is adapter-node's output, so it must live elsewhere. It holds the app icon.
 */
export const BUILD_RESOURCES = 'build-resources';

/** The app icon's source; scripts/render-icon.ts rasterises it into ICON_PNG. */
export const ICON_SVG = `${BUILD_RESOURCES}/icon.svg`;

/**
 * The one app icon electron-builder converts per OS (icns, ico, Linux sizes). Named
 * from the repo root: the builder resolves it there after missing it under
 * buildResources, and refuses to build if it is absent.
 */
export const ICON_PNG = `${BUILD_RESOURCES}/icon.png`;

/** ICON_PNG's width and height: the largest size macOS asks for. */
export const ICON_SIZE = 1024;

/** Build outputs the packaged app runs; packaging refuses without them. */
export const REQUIRED_INPUTS = ['build/handler.js', 'dist-desktop/main.js'] as const;

/** decision release_secrets, by name only: their values are never read into output. */
export const SIGNING_VARIABLES = [
	'CSC_LINK',
	'CSC_KEY_PASSWORD',
	'APPLE_API_KEY',
	'APPLE_API_KEY_ID',
	'APPLE_API_ISSUER'
] as const;

export const GITHUB_RELEASES = { provider: 'github', owner: 'Rivil', repo: 'price-check' } as const;

/** What goes into the app (package.json and production node_modules are added by the builder). */
export const APP_FILES = [
	'dist-desktop/**/*',
	'build/**/*',
	'src/desktop/assets/**/*',
	'drizzle/**/*',
	'!**/*.db',
	'!**/.env',
	'!**/.env.*'
] as const;

/** Unpacked out of app.asar: native modules cannot load from inside it. */
export const ASAR_UNPACK = [
	'node_modules/libsql/**/*',
	'node_modules/@libsql/darwin-x64/**/*',
	'node_modules/@libsql/darwin-arm64/**/*',
	'node_modules/@libsql/linux-x64-gnu/**/*',
	'node_modules/@libsql/win32-x64-msvc/**/*',
	'drizzle/**/*'
] as const;

/**
 * The app files plus, per OS, the libsql binaries it does not ship: pnpm installs
 * every CPU's (supportedArchitectures). Negations are the only file patterns
 * electron-builder applies to node_modules.
 *
 * Each OS gets the whole list and the top-level `files` stays unset: electron-builder
 * turns a top-level list into a FileSet that copies on its own, and a platform list
 * next to it would then copy the whole repo (.env and .dross included).
 */
export const PLATFORM_FILES = {
	mac: [...APP_FILES, '!node_modules/@libsql/{linux,win32}-*/**'],
	win: [
		...APP_FILES,
		'!node_modules/@libsql/{darwin,linux}-*/**',
		'!node_modules/@libsql/win32-!(x64-msvc)/**'
	],
	linux: [
		...APP_FILES,
		'!node_modules/@libsql/{darwin,win32}-*/**',
		'!node_modules/@libsql/linux-!(x64-gnu)/**'
	]
} as const;

/**
 * Mach-O files that are x64 in both halves of the universal build, so @electron/universal
 * leaves them as they are rather than lipo them. Only the two libsql binaries: anything
 * broader would hide a framework that failed to merge.
 */
export const X64_ARCH_FILES =
	'Contents/Resources/app.asar.unpacked/node_modules/@libsql/darwin-{x64,arm64}/*.node';

/** MAJOR.MINOR.PATCH with an optional -rc.N: what a v* tag may carry (c-4). */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.[1-9]\d*)?$/;

/** Hosts a baked-in test feed may name (decision update_flow: CI's local feed only). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

export type BuilderConfigInput = {
	/** The version stamped into the app, e.g. 0.1.5 or 0.1.5-rc.1. */
	version: string;
	/** A loopback generic update feed for CI's update test; GitHub Releases otherwise. */
	feedUrl?: string;
	/** Sign and notarise (macOS release builds only). */
	sign: boolean;
	/** Output dir relative to the repo root. */
	out?: string;
};

function checkVersion(version: string): string {
	if (!VERSION.test(version)) {
		throw new Error(
			`version must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N, got '${version}'`
		);
	}
	return version;
}

function publishTo(feedUrl: string | undefined, sign: boolean): Configuration['publish'] {
	if (feedUrl === undefined) return [{ ...GITHUB_RELEASES }];
	if (sign) throw new Error('a signed build publishes to GitHub Releases only: drop --feed-url');
	let url: URL;
	try {
		url = new URL(feedUrl);
	} catch {
		throw new Error(`--feed-url is not a URL: '${feedUrl}'`);
	}
	if (
		url.protocol !== 'http:' ||
		!LOOPBACK_HOSTS.has(url.hostname) ||
		url.username ||
		url.password
	) {
		throw new Error(
			`--feed-url must be an http loopback URL (127.0.0.1 or [::1]), got '${feedUrl}'`
		);
	}
	return [{ provider: 'generic', url: feedUrl }];
}

/** The electron-builder configuration. Pure: throws on a bad version or feed URL. */
export function builderConfig({ version, feedUrl, sign, out }: BuilderConfigInput): Configuration {
	const stamped = checkVersion(version);
	return {
		appId: APP_ID,
		productName: PRODUCT_NAME,
		artifactName: ARTIFACT_NAME,
		extraMetadata: { version: stamped },
		directories: { output: out ?? DEFAULT_OUT, buildResources: BUILD_RESOURCES },
		icon: ICON_PNG,
		asar: true,
		asarUnpack: [...ASAR_UNPACK],
		npmRebuild: false,
		// An rc version would otherwise write rc*.yml, not the latest*.yml c-4 publishes.
		detectUpdateChannel: false,
		publish: publishTo(feedUrl, sign),
		mac: {
			target: [
				{ target: 'dmg', arch: ['universal'] },
				{ target: 'zip', arch: ['universal'] }
			],
			x64ArchFiles: X64_ARCH_FILES,
			files: [...PLATFORM_FILES.mac],
			hardenedRuntime: true,
			notarize: sign,
			// null skips signing; unset lets CSC_LINK pick the Developer ID identity.
			...(sign ? {} : { identity: null })
		},
		win: {
			target: [{ target: 'nsis', arch: ['x64'] }],
			files: [...PLATFORM_FILES.win]
		},
		nsis: { oneClick: true, perMachine: false },
		linux: {
			target: [{ target: 'AppImage', arch: ['x64'] }],
			files: [...PLATFORM_FILES.linux]
		}
	};
}

/** Environment the builder runs with: an unsigned run never auto-discovers an identity. */
export function signingEnv(sign: boolean): Record<string, string> {
	return { CSC_IDENTITY_AUTO_DISCOVERY: sign ? 'true' : 'false' };
}

/** Byte size of a regular file, or null when there is none at that path. */
export type FileSize = (path: string) => number | null;

/** Names of the signing variables that are missing or unusable. Never their values. */
export function missingSigningVariables(env: NodeJS.ProcessEnv, fileSize: FileSize): string[] {
	const missing: string[] = [];
	for (const name of SIGNING_VARIABLES) {
		const value = env[name];
		if (value === undefined || value.trim() === '') missing.push(name);
		else if (name === 'APPLE_API_KEY' && !((fileSize(value) ?? 0) > 0)) {
			missing.push('APPLE_API_KEY (must name an existing, non-empty .p8 file)');
		}
	}
	return missing;
}

const HOST_TARGET: Partial<Record<NodeJS.Platform, 'mac' | 'win' | 'linux'>> = {
	darwin: 'mac',
	win32: 'win',
	linux: 'linux'
};

export type PackageDeps = {
	/** electron-builder's build(). */
	build: (options: CliOptions) => Promise<string[]>;
	platform: NodeJS.Platform;
	/** Mutated: the builder reads CSC_IDENTITY_AUTO_DISCOVERY from it. */
	env: NodeJS.ProcessEnv;
	root: string;
	exists: (path: string) => boolean;
	fileSize: FileSize;
};

/** Packages for the host OS. Throws, before build() runs, on anything it refuses. */
export async function packageDesktop(
	input: BuilderConfigInput,
	deps: PackageDeps
): Promise<string[]> {
	const config = builderConfig(input);
	const target = HOST_TARGET[deps.platform];
	if (target === undefined) throw new Error(`cannot package on ${deps.platform}`);
	const absent = REQUIRED_INPUTS.filter((path) => !deps.exists(resolve(deps.root, path)));
	if (absent.length > 0) {
		throw new Error(`missing ${absent.join(', ')}: run pnpm build && pnpm build:desktop first`);
	}
	if (input.sign) {
		if (target !== 'mac')
			throw new Error('--sign is macOS-only: Windows and Linux are never signed');
		const missing = missingSigningVariables(deps.env, deps.fileSize);
		if (missing.length > 0) {
			throw new Error(`--sign needs ${missing.join(', ')}; nothing was built`);
		}
	}
	Object.assign(deps.env, signingEnv(input.sign));
	return deps.build({ [target]: [], config, publish: 'never', projectDir: deps.root });
}

/** Parses the CLI arguments; unknown options (--win, --publish, ...) throw. */
export function parseCliArgs(argv: string[]): BuilderConfigInput {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		allowPositionals: false,
		options: {
			version: { type: 'string' },
			'feed-url': { type: 'string' },
			sign: { type: 'boolean', default: false },
			out: { type: 'string' }
		}
	});
	if (values.version === undefined)
		throw new Error('--version <MAJOR.MINOR.PATCH[-rc.N]> is required');
	return {
		version: values.version,
		sign: values.sign,
		...(values['feed-url'] === undefined ? {} : { feedUrl: values['feed-url'] }),
		...(values.out === undefined ? {} : { out: values.out })
	};
}

export type CliDeps = PackageDeps & {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
};

/** The CLI: exit code 0 on a packaged build, 1 on any refusal or builder failure. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	try {
		const input = parseCliArgs(argv);
		const artifacts = await packageDesktop(input, deps);
		for (const file of artifacts) deps.stdout(`package:desktop: ${file}`);
		return 0;
	} catch (error) {
		deps.stderr(`package:desktop: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

/**
 * Sets the process exit code so that no exit hook can turn a failure into success.
 * electron-builder's temp-dir cleanup (temp-file, via async-exit-hook) listens for
 * 'beforeExit' and then calls process.exit(0), which replaces an exitCode of 1: a
 * failed notarisation exited 0. The 'exit' listener runs after that call and puts
 * the failure back. It never clears a failure something else reported.
 */
export function setExitCode(
	code: number,
	proc: Pick<NodeJS.Process, 'exitCode' | 'on'> = process
): void {
	proc.exitCode = code;
	if (code === 0) return;
	proc.on('exit', () => {
		if (!proc.exitCode) proc.exitCode = code;
	});
}

export const fileSize: FileSize = (path) => {
	try {
		const stat = statSync(path);
		return stat.isFile() ? stat.size : null;
	} catch {
		return null;
	}
};

// import.meta.main is missing on Node < 24.2; fall back to argv.
const isEntry =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) {
	const { build } = await import('electron-builder');
	const code = await runCli(process.argv.slice(2), {
		build,
		platform: process.platform,
		env: process.env,
		root: ROOT,
		exists: existsSync,
		fileSize,
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line)
	});
	setExitCode(code);
}
