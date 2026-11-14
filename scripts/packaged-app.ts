// Finds, installs and launches-by-path the packaged desktop app (spec c-1, c-3, c-4).
//
//   node scripts/packaged-app.ts exe <outDir>      prints the app executable for
//                                                  PRICE_CHECK_PACKAGED_EXE (win32: the
//                                                  installed one, read from the registry)
//   node scripts/packaged-app.ts install <outDir>  win32: silent per-user install of the
//                                                  located installer, prints the exe
//
// Artefact names come from package-desktop.ts's ARTIFACT_NAME (t-2), so the release
// job, the packaged smoke and the builder cannot disagree on a file name. Commands
// run through an injected Runner (execFile, never a shell), so the spec drives every
// path with fakes.
//
// Windows: electron-builder's one-click per-user NSIS writes its uninstall entry to
// HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<guid> with DisplayName
// '<productName> <version>' and UninstallString '"<install dir>\Uninstall <productName>.exe"
// /currentuser'; InstallLocation itself sits under HKCU\Software\<guid>. The uninstall
// key is the one the product is found by, so the install dir is its InstallLocation
// value when it carries one, else the UninstallString's directory.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR_NAME } from '../src/desktop/app-paths.ts';
import { ARTIFACT_NAME, PRODUCT_NAME } from './package-desktop.ts';

export type PackagedPlatform = 'darwin' | 'win32' | 'linux';

export const PACKAGED_PLATFORMS: readonly PackagedPlatform[] = ['darwin', 'win32', 'linux'];

/** MAJOR.MINOR.PATCH with an optional -rc.N: the stamp package:desktop accepts. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.[1-9]\d*)?$/;

/** electron-builder's ${os} and ${arch} for the one target each OS builds. */
const TARGETS: Record<PackagedPlatform, { os: string; arch: string; exts: readonly string[] }> = {
	darwin: { os: 'mac', arch: 'universal', exts: ['dmg', 'zip'] },
	win32: { os: 'win', arch: 'x64', exts: ['exe'] },
	// electron-builder names an x64 AppImage x86_64 (getArtifactArchName).
	linux: { os: 'linux', arch: 'x86_64', exts: ['AppImage'] }
};

/** Update files electron-builder writes beside the artefacts, one per OS. */
export const UPDATE_FILE: Record<PackagedPlatform, string> = {
	darwin: 'latest-mac.yml',
	win32: 'latest.yml',
	linux: 'latest-linux.yml'
};

/** Artefacts with a separate .blockmap (differential updates); the AppImage embeds its own. */
const BLOCKMAPPED = new Set(['dmg', 'zip', 'exe']);

/** The single-arch mac output dirs a universal build must never leave behind. */
const SINGLE_ARCH_MAC_DIRS = ['mac', 'mac-arm64', 'mac-x64'] as const;

export function isPackagedPlatform(value: string): value is PackagedPlatform {
	return (PACKAGED_PLATFORMS as readonly string[]).includes(value);
}

function checkVersion(version: string): string {
	if (!VERSION.test(version)) {
		throw new Error(
			`version must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N, got '${version}'`
		);
	}
	return version;
}

function artefactName(platform: PackagedPlatform, version: string, ext: string): string {
	const { os, arch } = TARGETS[platform];
	const values: Record<string, string> = { version, os, arch, ext };
	return ARTIFACT_NAME.replace(/\$\{([^}]+)\}/g, (_, macro: string) => {
		const value = values[macro];
		if (value === undefined) throw new Error(`ARTIFACT_NAME uses an unknown macro \${${macro}}`);
		return value;
	});
}

/**
 * Every file one OS's build publishes for `version`: the installer(s), their
 * blockmaps and the latest*.yml. Throws on a bad version or a name with whitespace
 * (GitHub would rename it, and latest*.yml would then name a file the release lacks).
 */
export function expectedArtefacts(platform: PackagedPlatform, version: string): string[] {
	checkVersion(version);
	const names: string[] = [];
	for (const ext of TARGETS[platform].exts) {
		const name = artefactName(platform, version, ext);
		names.push(name);
		if (BLOCKMAPPED.has(ext)) names.push(`${name}.blockmap`);
	}
	names.push(UPDATE_FILE[platform]);
	for (const name of names) {
		if (/\s/.test(name)) throw new Error(`artefact name contains whitespace: '${name}'`);
	}
	return names;
}

export type Located =
	| { platform: 'darwin'; outDir: string; app: string }
	| { platform: 'win32'; outDir: string; installer: string }
	| { platform: 'linux'; outDir: string; appImage: string };

function topLevelFiles(outDir: string, suffix: string): string[] {
	return readdirSync(outDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
		.map((entry) => entry.name)
		.sort();
}

function exactlyOne(outDir: string, suffix: string, what: string): string {
	const found = topLevelFiles(outDir, suffix);
	if (found.length !== 1) {
		throw new Error(
			`expected exactly one ${what} in ${outDir}, found ${found.length}${found.length > 0 ? `: ${found.join(', ')}` : ''}`
		);
	}
	return join(outDir, found[0]);
}

/** The packaged app in `outDir` for `platform`. Throws on anything ambiguous or missing. */
export function locate(outDir: string, platform: PackagedPlatform): Located {
	if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
		throw new Error(`no output dir at ${outDir}`);
	}
	if (platform === 'darwin') {
		const singleArch = SINGLE_ARCH_MAC_DIRS.filter((dir) => existsSync(join(outDir, dir)));
		if (singleArch.length > 0) {
			throw new Error(
				`${outDir} holds a single-arch mac build (${singleArch.join(', ')}): only mac-universal ships`
			);
		}
		const app = join(outDir, 'mac-universal', `${PRODUCT_NAME}.app`);
		if (!existsSync(app)) throw new Error(`no universal app at ${app}`);
		return { platform, outDir, app };
	}
	if (platform === 'linux') {
		return { platform, outDir, appImage: exactlyOne(outDir, '.AppImage', 'AppImage') };
	}
	return { platform, outDir, installer: exactlyOne(outDir, '.exe', 'installer .exe') };
}

/** The installed Windows app's executable in its install dir. */
export function installedExecutable(installLocation: string): string {
	return win32.join(installLocation, `${PRODUCT_NAME}.exe`);
}

/**
 * The executable to launch: the universal app's binary (darwin), the AppImage
 * itself (linux), or the installed exe (win32, which needs the install dir).
 */
export function executablePath(located: Located, installLocation?: string): string {
	switch (located.platform) {
		case 'darwin':
			return join(located.app, 'Contents', 'MacOS', PRODUCT_NAME);
		case 'linux':
			return located.appImage;
		case 'win32':
			if (installLocation === undefined) {
				throw new Error('the Windows app runs from its install dir: install it first');
			}
			return installedExecutable(installLocation);
	}
}

/**
 * The userData dir a packaged app uses: Electron's appData for the OS plus
 * APP_DIR_NAME (src/desktop/app-paths.ts), which a packaged app never overrides.
 */
export function packagedUserDataDir(
	platform: PackagedPlatform,
	env: NodeJS.ProcessEnv,
	home: string
): string {
	switch (platform) {
		case 'darwin':
			return posix.join(home, 'Library', 'Application Support', APP_DIR_NAME);
		case 'win32': {
			const appData = env.APPDATA?.trim();
			if (!appData) throw new Error('APPDATA is not set');
			return win32.join(appData, APP_DIR_NAME);
		}
		case 'linux': {
			const config = env.XDG_CONFIG_HOME?.trim();
			return posix.join(config ? config : posix.join(home, '.config'), APP_DIR_NAME);
		}
	}
}

export type Command = { file: string; args: string[] };
export type RunResult = { code: number; stdout: string; stderr: string };
/** Runs one command without a shell and resolves with its exit code; never rejects. */
export type Runner = (command: Command) => Promise<RunResult>;

export function formatCommand({ file, args }: Command): string {
	return [file, ...args]
		.map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part))
		.join(' ');
}

export const spawnRunner: Runner = (command) =>
	new Promise((done) => {
		execFile(
			command.file,
			command.args,
			{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 15 * 60_000 },
			(error, stdout, stderr) => {
				if (error === null) return done({ code: 0, stdout, stderr });
				const code = typeof error.code === 'number' ? error.code : -1;
				done({ code, stdout, stderr: stderr || error.message });
			}
		);
	});

export type UninstallScope = 'HKCU' | 'HKLM';

const UNINSTALL_SUBKEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

/** `reg query` over one Uninstall hive; HKLM takes a registry view (64- or 32-bit). */
export function uninstallQuery(scope: UninstallScope, view?: 32 | 64): Command {
	return {
		file: 'reg',
		args: ['query', `${scope}\\${UNINSTALL_SUBKEY}`, '/s', ...(view ? [`/reg:${view}`] : [])]
	};
}

export type RegKey = { key: string; values: Record<string, string> };

/** DisplayName: PRODUCT_NAME, or electron-builder's default '<productName> <version>'. */
function isProductName(displayName: string | undefined): boolean {
	if (displayName === undefined) return false;
	if (displayName === PRODUCT_NAME) return true;
	const rest = displayName.startsWith(`${PRODUCT_NAME} `)
		? displayName.slice(PRODUCT_NAME.length + 1)
		: null;
	return rest !== null && VERSION.test(rest);
}

const REG_VALUE = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/;

/**
 * `reg query <Uninstall> /s` output: the first key whose DisplayName is this
 * product's, or null when none is.
 */
export function parseRegQuery(text: string): RegKey | null {
	let current: RegKey | null = null;
	const keys: RegKey[] = [];
	for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = raw.replace(/\s+$/, '');
		if (/^HKEY_[A-Z_]+\\/.test(line)) {
			current = { key: line, values: {} };
			keys.push(current);
			continue;
		}
		const value = REG_VALUE.exec(line);
		if (value !== null && current !== null) current.values[value[1]] = value[3] ?? '';
	}
	return keys.find((key) => isProductName(key.values.DisplayName)) ?? null;
}

/** The install dir an uninstall key names: InstallLocation, else the UninstallString's dir. */
export function installLocationOf(key: RegKey): string | null {
	const location = key.values.InstallLocation?.trim();
	if (location) return location;
	const uninstaller = /^"([^"]+)"/.exec(key.values.UninstallString?.trim() ?? '')?.[1];
	return uninstaller === undefined ? null : win32.dirname(uninstaller);
}

export type Installed = { key: RegKey; installLocation: string };

/** The per-user (HKCU) install of this product, or null when there is none. */
export async function findUserInstall(run: Runner): Promise<Installed | null> {
	const query = await run(uninstallQuery('HKCU'));
	// reg exits 1 when the Uninstall key itself is absent: nothing is installed per user.
	// Any other failure (-1: reg could not be spawned, a timeout) means the check never ran.
	if (query.code === 1) return null;
	if (query.code !== 0) {
		const detail = query.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? '';
		throw new Error(
			`${formatCommand(uninstallQuery('HKCU'))} exited ${query.code}${detail ? `: ${detail}` : ''}`
		);
	}
	const key = parseRegQuery(query.stdout);
	if (key === null) return null;
	const installLocation = installLocationOf(key);
	if (installLocation === null) {
		throw new Error(`${key.key} names no InstallLocation or quoted UninstallString`);
	}
	return { key, installLocation };
}

/**
 * Runs '<installer> /S' (NSIS silent install) and returns the per-user install it
 * made. Rejects on a non-zero exit or when no HKCU uninstall entry for the product
 * appears.
 */
export async function installWindows(installer: string, run: Runner): Promise<Installed> {
	const result = await run({ file: installer, args: ['/S'] });
	if (result.code !== 0) {
		throw new Error(`${formatCommand({ file: installer, args: ['/S'] })} exited ${result.code}`);
	}
	const installed = await findUserInstall(run);
	if (installed === null) {
		throw new Error(`no per-user (HKCU) uninstall entry for ${PRODUCT_NAME} after the install`);
	}
	return installed;
}

export type CliDeps = {
	platform: NodeJS.Platform;
	run: Runner;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
};

const USAGE = 'usage: packaged-app.ts exe <outDir> | install <outDir>';

function hostPlatform(platform: NodeJS.Platform): PackagedPlatform {
	if (!isPackagedPlatform(platform)) throw new Error(`no packaged app for ${platform}`);
	return platform;
}

/** The CLI: prints one path on success (exit 0); exit 1 with the reason otherwise. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	try {
		const [command, outDir, ...rest] = argv;
		if (outDir === undefined || rest.length > 0) throw new Error(USAGE);
		const platform = hostPlatform(deps.platform);
		const located = locate(resolve(outDir), platform);
		if (command === 'exe') {
			if (located.platform === 'win32') {
				const installed = await findUserInstall(deps.run);
				if (installed === null) {
					throw new Error(`${PRODUCT_NAME} is not installed for this user: run install first`);
				}
				deps.stdout(executablePath(located, installed.installLocation));
			} else {
				deps.stdout(executablePath(located));
			}
			return 0;
		}
		if (command === 'install') {
			if (located.platform !== 'win32') throw new Error('install is Windows-only');
			const installed = await installWindows(located.installer, deps.run);
			deps.stdout(executablePath(located, installed.installLocation));
			return 0;
		}
		throw new Error(USAGE);
	} catch (error) {
		deps.stderr(`packaged-app: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

// import.meta.main is missing on Node < 24.2; fall back to argv.
const isEntry =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) {
	process.exitCode = await runCli(process.argv.slice(2), {
		platform: process.platform,
		run: spawnRunner,
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line)
	});
}
