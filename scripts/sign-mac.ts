// Signs and notarises the prepackaged macOS app, then builds the release files from
// it (decision release_secrets, c-26, SEC-09). This is the only code the release job
// that holds CSC_LINK, CSC_KEY_PASSWORD and the App Store Connect key runs, so it
// must work without the project install: its static imports are node:*, relative
// files and types only, and electron-builder comes from signing/, a separate install
// pinned to the root devDependency's exact version with its own frozen lockfile:
//
//   pnpm install --dir signing --ignore-workspace --frozen-lockfile --ignore-scripts
//   node scripts/sign-mac.ts --version 0.2.1 --app "dist-packaged/mac-universal/Price Check.app"
//
// electron-builder's `prepackaged` mode only wraps an app in dmg/zip: it skips the
// pack step, which is the only place it signs and notarises. So the builder gets a
// platformPackagerFactory whose MacPackager runs electron-builder's own sign() (the
// CSC_LINK keychain, the Developer ID identity, @electron/osx-sign with the hardened
// runtime and the config's entitlements, then notarisation) on the prepackaged app
// before it builds the dmg, the zip and latest-mac.yml. If sign() signs nothing, the
// run fails: an unsigned app is never wrapped for release.
//
// The config is builderConfig({version, sign: true}) from package-desktop.ts, so the
// signed release cannot drift from the build config.
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { CliOptions, Configuration } from 'electron-builder';
import {
	ROOT,
	builderConfig,
	fileSize,
	missingSigningVariables,
	setExitCode,
	signingEnv,
	type FileSize
} from './package-desktop.ts';

/** The signing job's own install: electron-builder and its tree, nothing else. */
export const SIGNING_DIR = join(ROOT, 'signing');

/** The slice of electron-builder's MacPackager the signing step drives. */
export type MacPackagerLike = {
	sign(appPath: string, options: null, arch: unknown): Promise<boolean>;
	packMacTargets(
		outDir: string,
		arch: unknown,
		targets: unknown,
		prepackaged: string,
		taskManager: unknown
	): Promise<unknown>;
};

/** A Platform as the factory receives it. */
type PlatformLike = { name: string };

/** build()'s options here: electron-builder's own, with the signing packager factory. */
export type SignBuildOptions = Omit<CliOptions, 'platformPackagerFactory'> & {
	platformPackagerFactory: (info: unknown, platform: PlatformLike) => MacPackagerLike;
};

/** The parts of electron-builder sign-mac uses. */
export type SigningBuilder = {
	build(options: SignBuildOptions): Promise<string[]>;
	MacPackager: new (info: unknown) => MacPackagerLike;
};

/**
 * The platformPackagerFactory: a MacPackager that signs and notarises the
 * prepackaged app with electron-builder's own sign() before packing the targets.
 */
export function signingPackagerFactory(MacPackager: SigningBuilder['MacPackager']) {
	return (info: unknown, platform: PlatformLike): MacPackagerLike => {
		if (platform.name !== 'mac') {
			throw new Error(`sign-mac signs macOS only, not ${platform.name}`);
		}
		const packager = new MacPackager(info);
		const packTargets = packager.packMacTargets.bind(packager);
		packager.packMacTargets = async (outDir, arch, targets, prepackaged, taskManager) => {
			if (!(await packager.sign(prepackaged, null, arch))) {
				throw new Error(
					'electron-builder signed nothing (no Developer ID identity from CSC_LINK); nothing was built'
				);
			}
			return packTargets(outDir, arch, targets, prepackaged, taskManager);
		};
		return packager;
	};
}

export type SignInput = { version: string; app: string };

/** Parses the CLI arguments; unknown options throw. */
export function parseSignArgs(argv: string[]): SignInput {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		allowPositionals: false,
		options: { version: { type: 'string' }, app: { type: 'string' } }
	});
	if (values.version === undefined)
		throw new Error('--version <MAJOR.MINOR.PATCH[-rc.N]> is required');
	if (values.app === undefined) throw new Error('--app <path to the prepackaged .app> is required');
	return { version: values.version, app: values.app };
}

export type SignDeps = {
	/** Loads electron-builder from `fromDir` (createRequire there by default). */
	loadBuilder(fromDir: string): SigningBuilder;
	/** Mutated: the builder reads CSC_IDENTITY_AUTO_DISCOVERY from it. */
	env: NodeJS.ProcessEnv;
	root: string;
	isDirectory(path: string): boolean;
	fileSize: FileSize;
};

/** The build() options for the signed release of `app`. */
export function signOptions(
	input: SignInput,
	root: string,
	MacPackager: SigningBuilder['MacPackager']
): SignBuildOptions {
	const config: Configuration = builderConfig({ version: input.version, sign: true });
	return {
		mac: [],
		config,
		prepackaged: input.app,
		publish: 'never',
		projectDir: root,
		platformPackagerFactory: signingPackagerFactory(MacPackager)
	};
}

/**
 * Signs, notarises and wraps the prepackaged app. Throws, before electron-builder
 * is even loaded, on missing signing variables or an --app that is not a .app dir.
 */
export async function signMac(input: SignInput, deps: SignDeps): Promise<string[]> {
	const missing = missingSigningVariables(deps.env, deps.fileSize);
	if (missing.length > 0) throw new Error(`signing needs ${missing.join(', ')}; nothing was built`);
	const app = resolve(deps.root, input.app);
	if (!app.endsWith('.app') || !deps.isDirectory(app)) {
		throw new Error(`--app must be an existing .app directory, got '${input.app}'`);
	}
	const { build, MacPackager } = deps.loadBuilder(SIGNING_DIR);
	Object.assign(deps.env, signingEnv(true));
	return build(signOptions({ ...input, app }, deps.root, MacPackager));
}

export type SignCliDeps = SignDeps & {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
};

/** The CLI: exit code 0 on a signed release, 1 on any refusal or builder failure. */
export async function runSignCli(argv: string[], deps: SignCliDeps): Promise<number> {
	try {
		const artifacts = await signMac(parseSignArgs(argv), deps);
		for (const file of artifacts) deps.stdout(`sign:mac: ${file}`);
		return 0;
	} catch (error) {
		deps.stderr(`sign:mac: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

/** electron-builder as installed under `fromDir` (signing/), never the project's. */
export function loadBuilderFrom(fromDir: string): SigningBuilder {
	const require = createRequire(join(fromDir, 'package.json'));
	return require('electron-builder') as SigningBuilder;
}

const isDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		// No such path (or unreadable): not a directory, so signMac refuses it.
		return false;
	}
};

// import.meta.main is missing on Node < 24.2; fall back to argv.
const isEntry =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) {
	const code = await runSignCli(process.argv.slice(2), {
		loadBuilder: loadBuilderFrom,
		env: process.env,
		root: ROOT,
		isDirectory,
		fileSize,
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line)
	});
	setExitCode(code);
}
