// Checks a packaged build before anything runs or ships it (spec c-1 to c-4).
//
//   node scripts/verify-packaged.ts layout <outDir> --version <v> --mode ci|release
//   node scripts/verify-packaged.ts mac <app> [--signed]
//   node scripts/verify-packaged.ts win <outDir>          (after packaged-app.ts install)
//
// Every check runs and every violation is listed; any violation exits 1.
//
// layout (host OS, any build): the app.asar listing (via @electron/asar's header) and
//   app.asar.unpacked hold no native .node file packed, no development file (.env*,
//   .dross/, .git/, *.db, e2e/, src/lib/, specs, test fixtures) and nothing outside
//   package-desktop.ts's APP_FILES roots (a build that packed the whole repo is caught
//   here); exactly the OS's @libsql binaries ship, unpacked; the packaged package.json
//   and latest*.yml carry the stamped version, every latest*.yml files[].url is a file
//   in outDir with a sha512; every expected artefact exists; app-update.yml names the
//   feed the mode allows. Mode 'release' is a GitHub Releases build (release.yml, and
//   PR builds packaged without --feed-url); mode 'ci' is a build with the loopback
//   test feed baked in (package:desktop --feed-url), which must never reach a release.
// mac <app>: lipo shows arm64 and x86_64 for the executable and both darwin libsql
//   binaries are unpacked; --signed adds codesign --verify --deep --strict, spctl
//   --assess --type execute and xcrun stapler validate (release builds only).
// win <outDir>: the installer's manifest asks for asInvoker (no UAC), the product's
//   uninstall entry is under HKCU only with its install dir inside %LOCALAPPDATA%, and
//   the Start Menu shortcut's System.AppUserModel.ID is APP_ID.
//
// Commands come from pure builders and run through an injected Runner.
import { getRawHeader, extractFile } from '@electron/asar';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { APP_ID } from '../src/desktop/app-id.ts';
import { APP_FILES, ASAR_UNPACK, GITHUB_RELEASES, PRODUCT_NAME } from './package-desktop.ts';
import {
	expectedArtefacts,
	findUserInstall,
	formatCommand,
	installedExecutable,
	isPackagedPlatform,
	locate,
	parseRegQuery,
	spawnRunner,
	uninstallQuery,
	UPDATE_FILE,
	type Command,
	type PackagedPlatform,
	type Runner
} from './packaged-app.ts';

// ---------------------------------------------------------------- mac

/** The architectures `lipo -info` reports; [] when the output is not lipo's. */
export function parseLipoArchs(text: string): string[] {
	const fat = /Architectures in the fat file: .* are: (.+)$/m.exec(text);
	if (fat !== null) return fat[1].trim().split(/\s+/);
	const thin = /Non-fat file: .* is architecture: (\S+)\s*$/m.exec(text);
	return thin === null ? [] : [thin[1]];
}

export const MAC_ARCHS = ['arm64', 'x86_64'] as const;

export const DARWIN_LIBSQL = ['darwin-arm64', 'darwin-x64'] as const;

export function macExecutable(app: string): string {
	return join(app, 'Contents', 'MacOS', PRODUCT_NAME);
}

/** lipo first, then (signed only) the three signing checks, each on the app bundle. */
export function macCommands({ app, signed }: { app: string; signed: boolean }): Command[] {
	const commands: Command[] = [{ file: 'lipo', args: ['-info', macExecutable(app)] }];
	if (signed) {
		commands.push(
			{ file: 'codesign', args: ['--verify', '--deep', '--strict', app] },
			{ file: 'spctl', args: ['--assess', '--type', 'execute', app] },
			{ file: 'xcrun', args: ['stapler', 'validate', app] }
		);
	}
	return commands;
}

export type MacDeps = { run: Runner; exists: (path: string) => boolean };

function failure(command: Command, code: number, output: string): string {
	const detail = output.trim().split(/\r?\n/).slice(-3).join(' | ');
	return `${formatCommand(command)} exited ${code}${detail ? `: ${detail}` : ''}`;
}

/** Every violation of the universal-app and (with signed) signing checks. */
export async function verifyMac(
	app: string,
	{ signed }: { signed: boolean },
	deps: MacDeps
): Promise<string[]> {
	const violations: string[] = [];
	const [lipo, ...signing] = macCommands({ app, signed });
	const lipoResult = await deps.run(lipo);
	if (lipoResult.code !== 0) {
		violations.push(failure(lipo, lipoResult.code, lipoResult.stderr));
	} else {
		const archs = parseLipoArchs(lipoResult.stdout);
		const missing = MAC_ARCHS.filter((arch) => !archs.includes(arch));
		if (missing.length > 0) {
			violations.push(
				`${macExecutable(app)} is not universal: lipo shows [${archs.join(', ')}], missing ${missing.join(', ')}`
			);
		}
	}
	for (const name of DARWIN_LIBSQL) {
		const binary = join(
			resourcesOf(app),
			'app.asar.unpacked',
			'node_modules',
			'@libsql',
			name,
			'index.node'
		);
		if (!deps.exists(binary)) violations.push(`missing unpacked libsql binary ${binary}`);
	}
	for (const command of signing) {
		const result = await deps.run(command);
		if (result.code !== 0) {
			violations.push(failure(command, result.code, result.stderr || result.stdout));
		}
	}
	return violations;
}

function resourcesOf(app: string): string {
	return join(app, 'Contents', 'Resources');
}

// ---------------------------------------------------------------- win

/** A PowerShell -Command printing a shortcut's System.AppUserModel.ID (empty when unset). */
export function aumidCommand(lnk: string): Command {
	const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
	const script = [
		`$lnk = ${quote(lnk)}`,
		'$shell = New-Object -ComObject Shell.Application',
		'$item = $shell.Namespace((Split-Path -Parent $lnk)).ParseName((Split-Path -Leaf $lnk))',
		"[Console]::Out.Write([string]$item.ExtendedProperty('System.AppUserModel.ID'))"
	].join('; ');
	return { file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
}

/** The AUMID as printed, with a BOM and surrounding whitespace (CRLF) removed; null when empty. */
export function parseAumid(text: string): string | null {
	const value = text.replace(/^\uFEFF/, '').trim();
	return value === '' ? null : value;
}

/** Every requestedExecutionLevel an executable's embedded manifest declares. */
export function parseExecutionLevels(binary: string): string[] {
	return [...binary.matchAll(/requestedExecutionLevel\s+level\s*=\s*["']([A-Za-z]+)["']/g)].map(
		(match) => match[1]
	);
}

/** The per-user Start Menu shortcut electron-builder's one-click NSIS creates. */
export function startMenuShortcut(appData: string): string {
	return win32.join(
		appData,
		'Microsoft',
		'Windows',
		'Start Menu',
		'Programs',
		`${PRODUCT_NAME}.lnk`
	);
}

/** Whether `path` is `root` or inside it, compared as Windows paths (case-insensitive). */
function isInside(root: string, path: string): boolean {
	const relative = win32.relative(root.toLowerCase(), path.toLowerCase());
	return relative !== '' && !relative.startsWith('..') && !win32.isAbsolute(relative);
}

export type WinDeps = {
	run: Runner;
	exists: (path: string) => boolean;
	/** The installer's bytes, as latin1 text (the manifest is plain XML inside the PE). */
	readInstaller: (path: string) => string;
	env: NodeJS.ProcessEnv;
};

/** Every violation of the per-user, no-UAC install and the shortcut's AUMID (c-3). */
export async function verifyWin(installer: string, deps: WinDeps): Promise<string[]> {
	const violations: string[] = [];
	const levels = parseExecutionLevels(deps.readInstaller(installer));
	if (levels.length === 0) violations.push(`${installer} declares no requestedExecutionLevel`);
	for (const level of levels.filter((l) => l !== 'asInvoker')) {
		violations.push(
			`${installer} requests execution level ${level}: a UAC prompt (want asInvoker)`
		);
	}

	for (const view of [64, 32] as const) {
		const query = uninstallQuery('HKLM', view);
		const result = await deps.run(query);
		// HKLM's Uninstall key always exists, so any non-zero exit means the check never ran.
		if (result.code !== 0) {
			violations.push(failure(query, result.code, result.stderr));
			continue;
		}
		const machineKey = parseRegQuery(result.stdout);
		if (machineKey !== null) violations.push(`installed per machine: ${machineKey.key}`);
	}

	const localAppData = deps.env.LOCALAPPDATA?.trim();
	const appData = deps.env.APPDATA?.trim();
	if (!localAppData) violations.push('LOCALAPPDATA is not set');
	if (!appData) violations.push('APPDATA is not set');

	let installed: Awaited<ReturnType<typeof findUserInstall>> = null;
	try {
		installed = await findUserInstall(deps.run);
	} catch (error) {
		violations.push(error instanceof Error ? error.message : String(error));
	}
	let exe: string | null = null;
	if (installed === null) {
		violations.push(`no per-user (HKCU) uninstall entry for ${PRODUCT_NAME}`);
	} else {
		if (!installed.key.key.startsWith('HKEY_CURRENT_USER\\')) {
			violations.push(`uninstall entry is not per user: ${installed.key.key}`);
		}
		if (localAppData && !isInside(localAppData, installed.installLocation)) {
			violations.push(
				`installed outside %LOCALAPPDATA% (${localAppData}): ${installed.installLocation}`
			);
		}
		exe = installedExecutable(installed.installLocation);
		if (!deps.exists(exe)) violations.push(`no installed executable at ${exe}`);
	}

	if (appData) {
		const lnk = startMenuShortcut(appData);
		if (!deps.exists(lnk)) {
			violations.push(`no Start Menu shortcut at ${lnk}`);
		} else {
			const command = aumidCommand(lnk);
			const result = await deps.run(command);
			const aumid = result.code === 0 ? parseAumid(result.stdout) : null;
			if (result.code !== 0) violations.push(failure(command, result.code, result.stderr));
			else if (aumid === null) violations.push(`${lnk} has no System.AppUserModel.ID`);
			else if (exe !== null && aumid.toLowerCase() === exe.toLowerCase()) {
				violations.push(`${lnk} AppUserModelID is the exe path ${aumid}, not ${APP_ID}`);
			} else if (aumid !== APP_ID) {
				violations.push(`${lnk} AppUserModelID is '${aumid}', not ${APP_ID}`);
			}
		}
	}
	return violations;
}

// ---------------------------------------------------------------- layout

/** The @libsql native packages each OS ships (decision artefacts). */
export const EXPECTED_LIBSQL: Record<PackagedPlatform, readonly string[]> = {
	darwin: DARWIN_LIBSQL,
	win32: ['win32-x64-msvc'],
	linux: ['linux-x64-gnu']
};

/** @libsql/<name> packages holding a native binary (the others are JS). */
const NATIVE_LIBSQL = /^(darwin|linux|win32)-/;

export type AppEntry = { path: string; unpacked: boolean; kind: 'file' | 'dir' | 'link' };

type HeaderNode = { files?: Record<string, HeaderNode>; unpacked?: boolean; link?: string };

/** Every entry in an app.asar header, '/'-separated, without a leading slash. */
export function listAsar(asarPath: string): AppEntry[] {
	const entries: AppEntry[] = [];
	const walk = (node: HeaderNode, prefix: string) => {
		for (const [name, child] of Object.entries(node.files ?? {})) {
			const path = prefix === '' ? name : `${prefix}/${name}`;
			const kind = child.files !== undefined ? 'dir' : child.link !== undefined ? 'link' : 'file';
			entries.push({ path, unpacked: child.unpacked === true, kind });
			if (kind === 'dir') walk(child, path);
		}
	};
	walk(getRawHeader(asarPath).header as HeaderNode, '');
	return entries;
}

/** Every file under a directory, '/'-separated and relative to it; [] when it is absent. */
export function listTree(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(join(dir, entry.name), path);
			else files.push(path);
		}
	};
	walk(root, '');
	return files;
}

/** The app's own roots: APP_FILES' positive patterns without their globs, plus package.json. */
const APP_ROOTS = [
	...APP_FILES.filter((pattern) => !pattern.startsWith('!')).map((pattern) =>
		pattern.replace(/\/\*\*(\/\*)?$/, '')
	),
	'package.json'
];

/** What may sit in app.asar.unpacked: ASAR_UNPACK's roots. */
const UNPACK_ROOTS = ASAR_UNPACK.map((pattern) => pattern.replace(/\/\*\*(\/\*)?$/, ''));

function underRoots(path: string, roots: readonly string[]): boolean {
	return roots.some(
		(root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`)
	);
}

const SPEC_FILE = /\.(spec|test|e2e|packaged)\.[cm]?[jt]sx?$/;
const DATABASE = /\.(db|db-journal|db-wal|db-shm|sqlite3?)$/;
const FIXTURE_DIRS = new Set(['fixtures', '__fixtures__', '__tests__', 'testing', '__snapshots__']);

/** Why a path must not ship, or null. Repo-only rules skip node_modules. */
export function devFileReason(path: string): string | null {
	const segments = path.split('/');
	const name = segments[segments.length - 1];
	if (segments.some((s) => s.startsWith('.env'))) return 'an .env file';
	if (segments.includes('.dross')) return 'dross state (.dross/)';
	if (segments.includes('.git')) return 'git metadata (.git/)';
	if (DATABASE.test(name)) return 'a database file';
	if (segments[0] === 'node_modules') return null;
	if (segments[0] === 'e2e') return 'the e2e suite (e2e/)';
	if (path === 'src/lib' || path.startsWith('src/lib/')) return 'server source (src/lib/)';
	if (SPEC_FILE.test(name)) return 'a spec file';
	if (segments.some((s) => FIXTURE_DIRS.has(s))) return 'a test fixture';
	return null;
}

/** Violations in the app's file set: packed natives, dev files, stray roots, the libsql set. */
export function verifyAppFiles(
	entries: readonly AppEntry[],
	unpackedFiles: readonly string[],
	platform: PackagedPlatform
): string[] {
	const violations: string[] = [];
	for (const entry of entries) {
		const reason = devFileReason(entry.path);
		if (reason !== null) violations.push(`app.asar ships ${reason}: ${entry.path}`);
		else if (!underRoots(entry.path, [...APP_ROOTS, 'node_modules'])) {
			violations.push(`app.asar ships a path outside the app's files: ${entry.path}`);
		}
		if (entry.kind === 'file' && entry.path.endsWith('.node') && !entry.unpacked) {
			violations.push(`native module packed inside app.asar (cannot load): ${entry.path}`);
		}
	}
	for (const path of unpackedFiles) {
		const reason = devFileReason(path);
		if (reason !== null) violations.push(`app.asar.unpacked ships ${reason}: ${path}`);
		else if (!underRoots(path, UNPACK_ROOTS)) {
			violations.push(`app.asar.unpacked ships a path outside asarUnpack: ${path}`);
		}
	}

	const shipped = new Set<string>();
	for (const path of [...entries.map((entry) => entry.path), ...unpackedFiles]) {
		const name = /^node_modules\/@libsql\/([^/]+)/.exec(path)?.[1];
		if (name !== undefined && NATIVE_LIBSQL.test(name)) shipped.add(name);
	}
	const expected = EXPECTED_LIBSQL[platform];
	for (const name of [...shipped].sort()) {
		if (!expected.includes(name))
			violations.push(`ships @libsql/${name}, not a ${platform} binary`);
	}
	for (const name of expected) {
		const binary = unpackedFiles.some(
			(path) => path.startsWith(`node_modules/@libsql/${name}/`) && path.endsWith('.node')
		);
		if (!binary) violations.push(`@libsql/${name}'s .node binary is not in app.asar.unpacked`);
	}
	if (!unpackedFiles.includes('node_modules/libsql/index.js')) {
		violations.push('libsql (node_modules/libsql/index.js) is not in app.asar.unpacked');
	}
	return violations;
}

export type YamlDoc = {
	scalars: Record<string, string>;
	files: Record<string, string>[];
};

function unquote(value: string): string {
	const text = value.trim();
	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
		return text.slice(1, -1).replace(/''/g, "'");
	}
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
		return JSON.parse(text) as string;
	}
	return text;
}

/**
 * The flat YAML electron-builder writes (latest*.yml, app-update.yml): top-level
 * scalars plus the `files:` list of maps. Other nested blocks are skipped.
 */
export function parseUpdateYaml(text: string): YamlDoc {
	const doc: YamlDoc = { scalars: {}, files: [] };
	let inFiles = false;
	for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
		const top = /^([A-Za-z0-9_]+):(?:\s+(.*))?$/.exec(raw);
		if (top !== null) {
			inFiles = top[1] === 'files';
			if (top[2] !== undefined) doc.scalars[top[1]] = unquote(top[2]);
			continue;
		}
		if (!inFiles) continue;
		const item = /^\s+(-\s+)?([A-Za-z0-9_]+):(?:\s+(.*))?$/.exec(raw);
		if (item === null) continue;
		if (item[1] !== undefined || doc.files.length === 0) doc.files.push({});
		doc.files[doc.files.length - 1][item[2]] = unquote(item[3] ?? '');
	}
	return doc;
}

export type LayoutMode = 'ci' | 'release';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/** Violations of the feed app-update.yml bakes in, for the mode. */
export function verifyFeed(appUpdate: YamlDoc, mode: LayoutMode): string[] {
	const { provider, owner, repo, url } = appUpdate.scalars;
	if (mode === 'release') {
		if (provider !== 'github') {
			return [`app-update.yml provider is '${provider}', a release needs github`];
		}
		if (owner !== GITHUB_RELEASES.owner || repo !== GITHUB_RELEASES.repo) {
			return [
				`app-update.yml points at ${owner}/${repo}, not ${GITHUB_RELEASES.owner}/${GITHUB_RELEASES.repo}`
			];
		}
		return [];
	}
	if (provider !== 'generic') {
		return [`app-update.yml provider is '${provider}', a ci build needs the generic loopback feed`];
	}
	const host = URL.canParse(url ?? '') ? new URL(url ?? '') : null;
	return host !== null && host.protocol === 'http:' && LOOPBACK_HOSTS.has(host.hostname)
		? []
		: [`app-update.yml feed '${url}' is not an http loopback URL`];
}

/** Violations of one latest*.yml: version, and every files[] entry present with a sha512. */
export function verifyUpdateFile(
	name: string,
	doc: YamlDoc,
	version: string,
	outDirFiles: ReadonlySet<string>
): string[] {
	const violations: string[] = [];
	if (doc.scalars.version !== version) {
		violations.push(`${name} version is '${doc.scalars.version}', stamped ${version}`);
	}
	if (doc.files.length === 0) violations.push(`${name} lists no files`);
	for (const file of doc.files) {
		const url = file.url ?? '';
		if (url === '') violations.push(`${name} has a files[] entry without a url`);
		else if (/\s/.test(url)) violations.push(`${name} url contains whitespace: '${url}'`);
		else if (!outDirFiles.has(url))
			violations.push(`${name} names ${url}, which is not in the output dir`);
		if (!file.sha512) violations.push(`${name} entry ${url || '?'} has no sha512`);
	}
	return violations;
}

function resourcesDir(outDir: string, platform: PackagedPlatform): string {
	if (platform === 'darwin')
		return resourcesOf(join(outDir, 'mac-universal', `${PRODUCT_NAME}.app`));
	return join(outDir, platform === 'win32' ? 'win-unpacked' : 'linux-unpacked', 'resources');
}

export type LayoutInput = {
	outDir: string;
	version: string;
	mode: LayoutMode;
	platform: PackagedPlatform;
};

/** Every layout violation of one OS's packaged output dir (reads the real file system). */
export function verifyLayout({ outDir, version, mode, platform }: LayoutInput): string[] {
	const violations: string[] = [];
	const attempt = (check: () => string[] | void) => {
		try {
			violations.push(...(check() ?? []));
		} catch (error) {
			violations.push(error instanceof Error ? error.message : String(error));
		}
	};

	attempt(() => void locate(outDir, platform));
	const outDirFiles = new Set(
		existsSync(outDir)
			? readdirSync(outDir, { withFileTypes: true })
					.filter((e) => e.isFile())
					.map((e) => e.name)
			: []
	);
	attempt(() =>
		expectedArtefacts(platform, version)
			.filter((name) => !outDirFiles.has(name))
			.map((name) => `missing artefact ${name} in ${outDir}`)
	);

	const resources = resourcesDir(outDir, platform);
	const asarPath = join(resources, 'app.asar');
	attempt(() => {
		if (!existsSync(asarPath)) return [`no app.asar at ${asarPath}`];
		const unpackedDir = join(resources, 'app.asar.unpacked');
		const checks = verifyAppFiles(listAsar(asarPath), listTree(unpackedDir), platform);
		const manifest = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8')) as {
			version?: unknown;
		};
		if (manifest.version !== version) {
			checks.push(
				`packaged package.json version is '${String(manifest.version)}', stamped ${version}`
			);
		}
		return checks;
	});

	attempt(() => {
		const name = UPDATE_FILE[platform];
		const path = join(outDir, name);
		if (!existsSync(path)) return [`no ${name} in ${outDir}`];
		return verifyUpdateFile(
			name,
			parseUpdateYaml(readFileSync(path, 'utf8')),
			version,
			outDirFiles
		);
	});

	attempt(() => {
		const path = join(resources, 'app-update.yml');
		if (!existsSync(path)) return [`no app-update.yml at ${path}`];
		return verifyFeed(parseUpdateYaml(readFileSync(path, 'utf8')), mode);
	});
	return violations;
}

// ---------------------------------------------------------------- CLI

export type CliDeps = {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	run: Runner;
	exists: (path: string) => boolean;
	readInstaller: (path: string) => string;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
};

const USAGE =
	'usage: verify-packaged.ts layout <outDir> --version <v> --mode ci|release | mac <app> [--signed] | win <outDir>';

function hostPlatform(platform: NodeJS.Platform): PackagedPlatform {
	if (!isPackagedPlatform(platform)) throw new Error(`no packaged app for ${platform}`);
	return platform;
}

async function violationsFor(
	argv: string[],
	deps: CliDeps
): Promise<{ command: string; violations: string[] }> {
	const { values, positionals } = parseArgs({
		args: argv,
		strict: true,
		allowPositionals: true,
		options: {
			version: { type: 'string' },
			mode: { type: 'string' },
			signed: { type: 'boolean', default: false }
		}
	});
	const [command, target, ...rest] = positionals;
	if (target === undefined || rest.length > 0) throw new Error(USAGE);
	if (command === 'layout') {
		if (values.version === undefined) throw new Error('layout needs --version <v>');
		if (values.mode !== 'ci' && values.mode !== 'release') {
			throw new Error('layout needs --mode ci or --mode release');
		}
		const violations = verifyLayout({
			outDir: resolve(target),
			version: values.version,
			mode: values.mode,
			platform: hostPlatform(deps.platform)
		});
		return { command, violations };
	}
	if (command === 'mac') {
		return {
			command,
			violations: await verifyMac(resolve(target), { signed: values.signed }, deps)
		};
	}
	if (command === 'win') {
		const located = locate(resolve(target), 'win32');
		if (located.platform !== 'win32') throw new Error('win needs a Windows output dir');
		return { command, violations: await verifyWin(located.installer, deps) };
	}
	throw new Error(USAGE);
}

/** The CLI: exit 0 when nothing is violated, 1 listing every violation (or a usage error). */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	try {
		const { command, violations } = await violationsFor(argv, deps);
		if (violations.length === 0) {
			deps.stdout(`verify-packaged: ${command} ok`);
			return 0;
		}
		for (const violation of violations) deps.stderr(`verify-packaged: ${violation}`);
		deps.stderr(`verify-packaged: ${command}: ${violations.length} violation(s)`);
		return 1;
	} catch (error) {
		deps.stderr(`verify-packaged: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

/** A regular file at `path`; false only when nothing is there, any other stat error throws. */
const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return false;
		throw error;
	}
};

// import.meta.main is missing on Node < 24.2; fall back to argv.
const isEntry =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) {
	process.exitCode = await runCli(process.argv.slice(2), {
		platform: process.platform,
		env: process.env,
		run: spawnRunner,
		exists: isFile,
		readInstaller: (path) => readFileSync(path).toString('latin1'),
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line)
	});
}
