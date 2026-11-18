// verify-packaged.ts: the universal mac app and its signing checks (c-2), the
// per-user Windows install and its shortcut AUMID (c-3), and the packaged layout:
// app.asar's file set, the per-OS libsql binaries, the stamped version and the
// update files (c-1, c-4). Layout fixtures are real asars built with @electron/asar.
import { createPackageWithOptions } from '@electron/asar';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_ID } from '../src/desktop/app-id.ts';
import { GITHUB_RELEASES, PRODUCT_NAME } from './package-desktop.ts';
import {
	expectedArtefacts,
	formatCommand,
	UPDATE_FILE,
	type Command,
	type PackagedPlatform,
	type RunResult,
	type Runner
} from './packaged-app.ts';
import {
	aumidCommand,
	devFileReason,
	EXPECTED_LIBSQL,
	isFile,
	listAsar,
	listTree,
	macCommands,
	parseAumid,
	parseExecutionLevels,
	parseLipoArchs,
	parseUpdateYaml,
	runCli,
	startMenuShortcut,
	verifyAppFiles,
	verifyFeed,
	verifyLayout,
	verifyMac,
	verifyUpdateFile,
	verifyWin,
	type AppEntry,
	type CliDeps,
	type LayoutMode,
	type WinDeps
} from './verify-packaged.ts';

const OK: RunResult = { code: 0, stdout: '', stderr: '' };

function fakeRunner(respond: (command: Command) => RunResult): Runner & { calls: Command[] } {
	const calls: Command[] = [];
	const run = (async (command: Command) => {
		calls.push(command);
		return respond(command);
	}) as Runner & { calls: Command[] };
	run.calls = calls;
	return run;
}

const temps: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- mac

const APP = join('/out', 'mac-universal', `${PRODUCT_NAME}.app`);
const EXE = join(APP, 'Contents', 'MacOS', PRODUCT_NAME);
const FAT = `Architectures in the fat file: ${EXE} are: x86_64 arm64 \n`;
const THIN = `Non-fat file: ${EXE} is architecture: arm64\n`;
const libsqlBinary = (name: string) =>
	join(
		APP,
		'Contents',
		'Resources',
		'app.asar.unpacked',
		'node_modules',
		'@libsql',
		name,
		'index.node'
	);

describe('parseLipoArchs', () => {
	it('reads a fat file (path with spaces) and a non-fat one', () => {
		expect(parseLipoArchs(FAT)).toEqual(['x86_64', 'arm64']);
		expect(parseLipoArchs('Non-fat file: x is architecture: arm64')).toEqual(['arm64']);
		expect(parseLipoArchs('Architectures in the fat file: x are: x86_64 arm64')).toEqual([
			'x86_64',
			'arm64'
		]);
		expect(parseLipoArchs('fatal error: lipo: cannot open')).toEqual([]);
	});

	it('splits on any run of whitespace and takes a thin arch only at the line end', () => {
		expect(parseLipoArchs('Architectures in the fat file: x are: x86_64  arm64')).toEqual([
			'x86_64',
			'arm64'
		]);
		expect(parseLipoArchs('Non-fat file: x is architecture: arm64  \n')).toEqual(['arm64']);
		expect(parseLipoArchs('Non-fat file: x is architecture: arm64 (stub)')).toEqual([]);
	});
});

describe('macCommands', () => {
	const names = (commands: Command[]) => commands.map((c) => [c.file, ...c.args].join(' '));

	it('runs only lipo on an unsigned app', () => {
		const commands = macCommands({ app: APP, signed: false });
		expect(commands).toEqual([{ file: 'lipo', args: ['-info', EXE] }]);
		expect(names(commands).join('\n')).not.toMatch(/codesign|spctl|stapler/);
	});

	it('adds exactly codesign, spctl and stapler on the app when signed', () => {
		expect(macCommands({ app: APP, signed: true })).toEqual([
			{ file: 'lipo', args: ['-info', EXE] },
			{ file: 'codesign', args: ['--verify', '--deep', '--strict', APP] },
			{ file: 'spctl', args: ['--assess', '--type', 'execute', APP] },
			{ file: 'xcrun', args: ['stapler', 'validate', APP] }
		]);
	});
});

describe('verifyMac', () => {
	const allExist = () => true;
	const lipo = (stdout: string) =>
		fakeRunner((command) => (command.file === 'lipo' ? { code: 0, stdout, stderr: '' } : OK));

	it('passes a universal executable with both darwin libsql binaries unpacked', async () => {
		expect(await verifyMac(APP, { signed: false }, { run: lipo(FAT), exists: allExist })).toEqual(
			[]
		);
	});

	it('fails a non-fat arm64 executable', async () => {
		const violations = await verifyMac(
			APP,
			{ signed: false },
			{ run: lipo(THIN), exists: allExist }
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/not universal.*missing x86_64/);
	});

	it('fails when lipo itself fails', async () => {
		const run = fakeRunner(() => ({ code: 1, stdout: '', stderr: "can't open input file" }));
		const violations = await verifyMac(APP, { signed: false }, { run, exists: allExist });
		expect(violations).toEqual([expect.stringMatching(/^lipo -info .* exited 1: can't open/)]);
	});

	it("reports a failing command's last three output lines, or none", async () => {
		const lipoCommand = formatCommand({ file: 'lipo', args: ['-info', EXE] });
		const failing = (stderr: string) => fakeRunner(() => ({ code: 1, stdout: '', stderr }));
		const noisy = failing('\nline1\nline2\r\nline3\nline4\n');
		expect(await verifyMac(APP, { signed: false }, { run: noisy, exists: allExist })).toEqual([
			`${lipoCommand} exited 1: line2 | line3 | line4`
		]);
		const silent = failing('');
		expect(await verifyMac(APP, { signed: false }, { run: silent, exists: allExist })).toEqual([
			`${lipoCommand} exited 1`
		]);
	});

	it('names the architectures lipo shows and the ones missing', async () => {
		const run = lipo(`Architectures in the fat file: ${EXE} are: i386 ppc\n`);
		expect(await verifyMac(APP, { signed: false }, { run, exists: allExist })).toEqual([
			`${EXE} is not universal: lipo shows [i386, ppc], missing arm64, x86_64`
		]);
	});

	it.each(['darwin-x64', 'darwin-arm64'])(
		'fails when the unpacked %s index.node is missing',
		async (name) => {
			const exists = (path: string) => path !== libsqlBinary(name);
			const violations = await verifyMac(APP, { signed: false }, { run: lipo(FAT), exists });
			expect(violations).toEqual([`missing unpacked libsql binary ${libsqlBinary(name)}`]);
		}
	);

	it('runs no signing check unless signed', async () => {
		const run = lipo(FAT);
		await verifyMac(APP, { signed: false }, { run, exists: allExist });
		expect(run.calls.map((c) => c.file)).toEqual(['lipo']);
	});
});

describe('runCli mac', () => {
	let lines: string[];
	beforeEach(() => {
		lines = [];
	});
	const deps = (run: Runner): CliDeps => ({
		platform: 'darwin',
		env: {},
		run,
		exists: () => true,
		readInstaller: () => '',
		stdout: (line) => lines.push(`out ${line}`),
		stderr: (line) => lines.push(`err ${line}`)
	});

	it('exits 0 when lipo and every signing check pass', async () => {
		const run = fakeRunner((command) =>
			command.file === 'lipo' ? { code: 0, stdout: FAT, stderr: '' } : OK
		);
		expect(await runCli(['mac', APP, '--signed'], deps(run))).toBe(0);
		expect(run.calls.map((c) => c.file)).toEqual(['lipo', 'codesign', 'spctl', 'xcrun']);
	});

	it.each(['codesign', 'spctl', 'xcrun'])('exits 1 when %s exits 1', async (failing) => {
		const run = fakeRunner((command) => {
			if (command.file === 'lipo') return { code: 0, stdout: FAT, stderr: '' };
			return command.file === failing ? { code: 1, stdout: '', stderr: 'rejected' } : OK;
		});
		expect(await runCli(['mac', APP, '--signed'], deps(run))).toBe(1);
		expect(lines.filter((l) => l.startsWith('err')).join('\n')).toMatch(
			new RegExp(`${failing} .*exited 1: rejected`)
		);
	});

	it('lists every violation, not just the first', async () => {
		const run = fakeRunner((command) =>
			command.file === 'lipo'
				? { code: 0, stdout: THIN, stderr: '' }
				: { code: 1, stdout: '', stderr: 'no' }
		);
		expect(await runCli(['mac', APP, '--signed'], deps(run))).toBe(1);
		expect(lines).toContain('err verify-packaged: mac: 4 violation(s)');
	});

	it('names the subcommand even when an option comes first', async () => {
		const run = fakeRunner((command) =>
			command.file === 'lipo' ? { code: 0, stdout: FAT, stderr: '' } : OK
		);
		expect(await runCli(['--signed', 'mac', APP], deps(run))).toBe(0);
		expect(lines).toEqual(['out verify-packaged: mac ok']);
	});

	it('runs only lipo without --signed', async () => {
		const run = fakeRunner((command) =>
			command.file === 'lipo' ? { code: 0, stdout: FAT, stderr: '' } : OK
		);
		expect(await runCli(['mac', APP], deps(run))).toBe(0);
		expect(run.calls.map((c) => c.file)).toEqual(['lipo']);
	});

	it.each([[['mac']], [['mac', APP, 'extra']], [['ship', APP]]])(
		'prints the usage for %j and runs nothing',
		async (argv) => {
			const run = fakeRunner(() => OK);
			expect(await runCli(argv, deps(run))).toBe(1);
			expect(lines).toEqual([
				expect.stringMatching(/^err verify-packaged: usage: verify-packaged\.ts layout <outDir>/)
			]);
			expect(run.calls).toEqual([]);
		}
	);
});

// ---------------------------------------------------------------- win

const LOCAL = 'C:\\Users\\runner\\AppData\\Local';
const ROAMING = 'C:\\Users\\runner\\AppData\\Roaming';
const INSTALL_DIR = `${LOCAL}\\Programs\\price-check-app`;
const WIN_EXE = `${INSTALL_DIR}\\${PRODUCT_NAME}.exe`;
const HKCU_UNINSTALL = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const HKLM_UNINSTALL =
	'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const MANIFEST =
	'MZ\u0000\u0090<assembly><trustInfo><security><requestedPrivileges>' +
	'<requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>';

function productKey(hive: string, installDir = INSTALL_DIR): string {
	return [
		'',
		`${hive}\\0b8f0a4e-guid`,
		`    DisplayName    REG_SZ    ${PRODUCT_NAME} 0.1.5`,
		`    UninstallString    REG_SZ    "${installDir}\\Uninstall ${PRODUCT_NAME}.exe" /currentuser`,
		''
	].join('\r\n');
}

type WinFake = {
	hkcu?: string;
	hklm64?: string;
	hklm32?: string;
	/** A reg failure (exit code) for the HKLM queries, e.g. -1 when reg cannot be spawned. */
	hklmCode?: number;
	hkcuCode?: number;
	aumid?: string;
	/** The AUMID read's exit code (default 0). */
	aumidCode?: number;
	manifest?: string;
	exists?: (path: string) => boolean;
	env?: NodeJS.ProcessEnv;
};

function winDeps(fake: WinFake = {}): WinDeps & { run: Runner & { calls: Command[] } } {
	const run = fakeRunner((command) => {
		if (command.file === 'reg') {
			const hive = command.args[1];
			const text = hive.startsWith('HKCU')
				? fake.hkcu
				: command.args.includes('/reg:32')
					? fake.hklm32
					: fake.hklm64;
			const failing = hive.startsWith('HKCU') ? fake.hkcuCode : fake.hklmCode;
			if (failing !== undefined) return { code: failing, stdout: '', stderr: 'spawn reg ENOENT' };
			// HKLM's Uninstall key always exists; HKCU's is absent (exit 1) until a per-user install.
			if (text !== undefined) return { code: 0, stdout: text, stderr: '' };
			return hive.startsWith('HKCU')
				? { code: 1, stdout: '', stderr: 'ERROR: unable to find the specified registry key' }
				: { code: 0, stdout: '', stderr: '' };
		}
		if (command.file === 'powershell') {
			const code = fake.aumidCode ?? 0;
			return { code, stdout: fake.aumid ?? `${APP_ID}\r\n`, stderr: code === 0 ? '' : 'COM error' };
		}
		return { code: 127, stdout: '', stderr: 'unexpected command' };
	});
	return {
		run,
		exists: fake.exists ?? (() => true),
		readInstaller: () => fake.manifest ?? MANIFEST,
		env: fake.env ?? { LOCALAPPDATA: LOCAL, APPDATA: ROAMING }
	};
}

const HAPPY: WinFake = {
	hkcu: productKey(HKCU_UNINSTALL),
	hklm64: ['', `${HKLM_UNINSTALL}\\Other`, '    DisplayName    REG_SZ    Other 1.0', ''].join(
		'\r\n'
	)
};

describe('parseAumid', () => {
	it('returns the exact value without CRLF or a BOM', () => {
		expect(parseAumid(`${APP_ID}\r\n`)).toBe(APP_ID);
		expect(parseAumid(`\uFEFF${APP_ID}\r\n`)).toBe(APP_ID);
		expect(parseAumid(`  ${APP_ID}  `)).toBe(APP_ID);
		expect(parseAumid(`${APP_ID}x\r\n`)).toBe(`${APP_ID}x`);
	});

	it('returns null for nothing', () => {
		expect(parseAumid('')).toBeNull();
		expect(parseAumid('\uFEFF\r\n')).toBeNull();
	});
});

describe('parseExecutionLevels', () => {
	it('finds every requestedExecutionLevel in the binary', () => {
		expect(parseExecutionLevels(MANIFEST)).toEqual(['asInvoker']);
		expect(
			parseExecutionLevels(
				"<requestedExecutionLevel level='requireAdministrator' uiAccess='false'/>"
			)
		).toEqual(['requireAdministrator']);
		expect(parseExecutionLevels('MZ no manifest')).toEqual([]);
	});

	it('allows any whitespace around the level attribute', () => {
		expect(
			parseExecutionLevels("<requestedExecutionLevel\r\n\t\tlevel = 'highestAvailable' />")
		).toEqual(['highestAvailable']);
	});
});

describe('aumidCommand', () => {
	it('reads System.AppUserModel.ID of the shortcut, single quotes escaped', () => {
		const lnk = startMenuShortcut("C:\\Users\\o'neil\\AppData\\Roaming");
		expect(lnk).toBe(
			`C:\\Users\\o'neil\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\${PRODUCT_NAME}.lnk`
		);
		const { file, args } = aumidCommand(lnk);
		expect(file).toBe('powershell');
		expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
		expect(args[3]).toContain("$lnk = 'C:\\Users\\o''neil\\AppData\\Roaming\\Microsoft");
		expect(args[3]).toContain("ExtendedProperty('System.AppUserModel.ID')");
	});

	it('runs the whole four-statement script', () => {
		expect(aumidCommand('C:\\x\\a.lnk').args[3]).toBe(
			"$lnk = 'C:\\x\\a.lnk'; " +
				'$shell = New-Object -ComObject Shell.Application; ' +
				'$item = $shell.Namespace((Split-Path -Parent $lnk)).ParseName((Split-Path -Leaf $lnk)); ' +
				"[Console]::Out.Write([string]$item.ExtendedProperty('System.AppUserModel.ID'))"
		);
	});
});

describe('verifyWin', () => {
	const installer = 'C:\\out\\price-check-0.1.5-win-x64.exe';

	it('passes a per-user install whose shortcut AUMID is APP_ID', async () => {
		const deps = winDeps(HAPPY);
		expect(await verifyWin(installer, deps)).toEqual([]);
		const powershell = deps.run.calls.find((c) => c.file === 'powershell');
		expect(powershell).toEqual(aumidCommand(startMenuShortcut(ROAMING)));
		expect(deps.run.calls.filter((c) => c.file === 'reg').map((c) => c.args.join(' '))).toEqual([
			'query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s /reg:64',
			'query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s /reg:32',
			'query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s'
		]);
	});

	it('passes an AUMID printed with a BOM and CRLF', async () => {
		expect(await verifyWin(installer, winDeps({ ...HAPPY, aumid: `\uFEFF${APP_ID}\r\n` }))).toEqual(
			[]
		);
	});

	it.each([
		['missing', '\r\n', /has no System\.AppUserModel\.ID/],
		['the exe path', `${WIN_EXE}\r\n`, /is the exe path/],
		['the exe path in other case', `${WIN_EXE.toLowerCase()}\r\n`, /is the exe path/],
		[
			'another id',
			'io.github.someone.else\r\n',
			/'io\.github\.someone\.else', not io\.github\.rivil\.price-check/
		]
	])('fails a shortcut whose AUMID is %s', async (_, aumid, message) => {
		const violations = await verifyWin(installer, winDeps({ ...HAPPY, aumid }));
		expect(violations).toEqual([expect.stringMatching(message)]);
	});

	it('fails when the Start Menu shortcut is missing', async () => {
		const lnk = startMenuShortcut(ROAMING);
		const violations = await verifyWin(installer, winDeps({ ...HAPPY, exists: (p) => p !== lnk }));
		expect(violations).toEqual([`no Start Menu shortcut at ${lnk}`]);
	});

	it.each([
		'C:\\Program Files\\price-check-app',
		'C:\\Users\\runner\\AppData\\LocalLow\\Programs\\price-check-app',
		'C:\\Users\\runner\\AppData\\Roaming\\price-check-app'
	])('fails an InstallLocation outside %%LOCALAPPDATA%%: %s', async (dir) => {
		const violations = await verifyWin(
			installer,
			winDeps({ ...HAPPY, hkcu: productKey(HKCU_UNINSTALL, dir) })
		);
		expect(violations).toEqual([expect.stringMatching(/installed outside %LOCALAPPDATA%/)]);
	});

	it.each(['hklm64', 'hklm32'] as const)(
		'fails when the uninstall key is under HKLM (%s)',
		async (view) => {
			const violations = await verifyWin(
				installer,
				winDeps({ ...HAPPY, [view]: productKey(HKLM_UNINSTALL) })
			);
			expect(violations).toEqual([
				expect.stringMatching(/^installed per machine: HKEY_LOCAL_MACHINE/)
			]);
		}
	);

	it('fails when only HKLM holds the product (no per-user entry)', async () => {
		const violations = await verifyWin(installer, winDeps({ hklm64: productKey(HKLM_UNINSTALL) }));
		expect(violations).toContain(`no per-user (HKCU) uninstall entry for ${PRODUCT_NAME}`);
		expect(violations.some((v) => v.startsWith('installed per machine'))).toBe(true);
	});

	it.each(['requireAdministrator', 'highestAvailable'])(
		'fails an installer manifest requesting %s',
		async (level) => {
			const manifest = MANIFEST.replace('asInvoker', level);
			const violations = await verifyWin(installer, winDeps({ ...HAPPY, manifest }));
			expect(violations).toEqual([
				expect.stringMatching(new RegExp(`requests execution level ${level}`))
			]);
		}
	);

	it('fails, never passes, when a registry query cannot run', async () => {
		const machine = await verifyWin(installer, winDeps({ ...HAPPY, hklmCode: -1 }));
		expect(machine).toEqual([
			expect.stringMatching(/^reg query HKLM.* \/reg:64 exited -1: spawn reg ENOENT$/),
			expect.stringMatching(/^reg query HKLM.* \/reg:32 exited -1: spawn reg ENOENT$/)
		]);
		const user = await verifyWin(installer, winDeps({ ...HAPPY, hkcuCode: -1 }));
		expect(user).toContain(
			'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s exited -1: spawn reg ENOENT'
		);
		expect(user).toContain(`no per-user (HKCU) uninstall entry for ${PRODUCT_NAME}`);
	});

	it('fails an installer with no manifest', async () => {
		const violations = await verifyWin(installer, winDeps({ ...HAPPY, manifest: 'MZ' }));
		expect(violations).toEqual([`${installer} declares no requestedExecutionLevel`]);
	});

	it('fails when the installed exe is missing or the env lacks the app-data dirs', async () => {
		expect(await verifyWin(installer, winDeps({ ...HAPPY, exists: (p) => p !== WIN_EXE }))).toEqual(
			[`no installed executable at ${WIN_EXE}`]
		);
		const violations = await verifyWin(installer, winDeps({ ...HAPPY, env: {} }));
		expect(violations).toEqual(['LOCALAPPDATA is not set', 'APPDATA is not set']);
		const blank = winDeps({ ...HAPPY, env: { LOCALAPPDATA: '  ', APPDATA: ' \t ' } });
		expect(await verifyWin(installer, blank)).toEqual([
			'LOCALAPPDATA is not set',
			'APPDATA is not set'
		]);
	});

	it('fails an install dir that is %LOCALAPPDATA% itself, passes one in other case', async () => {
		expect(
			await verifyWin(installer, winDeps({ ...HAPPY, hkcu: productKey(HKCU_UNINSTALL, LOCAL) }))
		).toEqual([`installed outside %LOCALAPPDATA% (${LOCAL}): ${LOCAL}`]);
		const upper = productKey(HKCU_UNINSTALL, INSTALL_DIR.toUpperCase());
		expect(await verifyWin(installer, winDeps({ ...HAPPY, hkcu: upper }))).toEqual([]);
	});

	it('fails an HKCU query whose product key is not under HKEY_CURRENT_USER', async () => {
		const hkcu = productKey(HKLM_UNINSTALL);
		expect(await verifyWin(installer, winDeps({ ...HAPPY, hkcu }))).toEqual([
			`uninstall entry is not per user: ${HKLM_UNINSTALL}\\0b8f0a4e-guid`
		]);
	});

	it('reports a failed AUMID read as that command failing', async () => {
		const lnk = startMenuShortcut(ROAMING);
		expect(await verifyWin(installer, winDeps({ ...HAPPY, aumidCode: 1 }))).toEqual([
			`${formatCommand(aumidCommand(lnk))} exited 1: COM error`
		]);
	});

	it('runCli win locates the installer in the output dir', async () => {
		const out = tempDir('verify-win-');
		writeFileSync(join(out, 'price-check-0.1.5-win-x64.exe'), '');
		const lines: string[] = [];
		const fake = winDeps(HAPPY);
		let read = '';
		const deps: CliDeps = {
			...fake,
			platform: 'win32',
			readInstaller: (path) => {
				read = path;
				return MANIFEST;
			},
			stdout: (line) => lines.push(line),
			stderr: (line) => lines.push(line)
		};
		expect(await runCli(['win', out], deps)).toBe(0);
		expect(read).toBe(join(out, 'price-check-0.1.5-win-x64.exe'));
		expect(lines).toEqual(['verify-packaged: win ok']);
		const bad = { ...deps, ...winDeps({ ...HAPPY, aumid: '' }), readInstaller: () => MANIFEST };
		expect(await runCli(['win', out], bad)).toBe(1);
	});
});

// ---------------------------------------------------------------- layout

const VERSION = '0.1.5-rc.1';
const GITHUB_FEED =
	'owner: Rivil\nrepo: price-check\nprovider: github\nupdaterCacheDirName: price-check-app-updater\n';
const LOOPBACK_FEED =
	'provider: generic\nurl: http://127.0.0.1:47811/\nupdaterCacheDirName: price-check-app-updater\n';

type LayoutFixture = {
	platform: PackagedPlatform;
	/** Stamp in the packaged package.json. */
	packagedVersion?: string;
	/** Version written into latest*.yml. */
	ymlVersion?: string;
	/** @libsql native packages in node_modules (default: the platform's expected set). */
	natives?: readonly string[];
	/** Extra files packed into the app (path -> content). */
	extra?: Record<string, string>;
	/** asar's unpack glob; the default unpacks .node files and libsql's index.js. */
	unpack?: string;
	appUpdate?: string;
	/** Rewrites the generated latest*.yml. */
	latest?: (yml: string) => string;
	/** Artefacts not to create. */
	omit?: string[];
};

function resourcesFor(out: string, platform: PackagedPlatform): string {
	if (platform === 'darwin')
		return join(out, 'mac-universal', `${PRODUCT_NAME}.app`, 'Contents', 'Resources');
	return join(out, platform === 'win32' ? 'win-unpacked' : 'linux-unpacked', 'resources');
}

function writeTree(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, ...path.split('/'));
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
}

/** A packaged output dir for one OS: artefacts, latest*.yml, and a real app.asar. */
async function buildOutDir(fixture: LayoutFixture): Promise<string> {
	const { platform } = fixture;
	const root = tempDir('verify-layout-');
	const src = join(root, 'app');
	const out = join(root, 'out');
	const natives = fixture.natives ?? EXPECTED_LIBSQL[platform];
	writeTree(src, {
		'package.json': JSON.stringify({
			name: 'price-check-app',
			version: fixture.packagedVersion ?? VERSION
		}),
		'dist-desktop/main.js': 'main',
		'build/handler.js': 'handler',
		'drizzle/0000_init.sql': 'create table x (id int);',
		'src/desktop/assets/tray-icon.png': 'png',
		'node_modules/libsql/index.js': 'libsql',
		'node_modules/@libsql/client/client.js': 'client',
		...Object.fromEntries(natives.map((name) => [`node_modules/@libsql/${name}/index.node`, name])),
		...fixture.extra
	});
	const resources = resourcesFor(out, platform);
	mkdirSync(resources, { recursive: true });
	await createPackageWithOptions(src, join(resources, 'app.asar'), {
		dot: true,
		unpack: fixture.unpack ?? '{*.node,index.js}'
	});
	writeFileSync(join(resources, 'app-update.yml'), fixture.appUpdate ?? GITHUB_FEED);

	const names = expectedArtefacts(platform, VERSION);
	const installers = names.filter((n) => !n.endsWith('.yml') && !n.endsWith('.blockmap'));
	for (const name of names) {
		if (name.endsWith('.yml') || fixture.omit?.includes(name)) continue;
		writeFileSync(join(out, name), name);
	}
	const yml = [
		`version: ${fixture.ymlVersion ?? VERSION}`,
		'files:',
		...installers.flatMap((name) => [`  - url: ${name}`, '    sha512: c2hhNTEy==', '    size: 10']),
		`path: ${installers[0]}`,
		'sha512: c2hhNTEy==',
		"releaseDate: '2026-11-14T18:36:45.051Z'",
		''
	].join('\n');
	writeFileSync(join(out, UPDATE_FILE[platform]), fixture.latest ? fixture.latest(yml) : yml);
	return out;
}

const layout = (out: string, platform: PackagedPlatform, mode: LayoutMode = 'release') =>
	verifyLayout({ outDir: out, version: VERSION, mode, platform });

describe('verifyLayout', () => {
	it.each(['darwin', 'win32', 'linux'] as const)('passes a clean %s build', async (platform) => {
		expect(layout(await buildOutDir({ platform }), platform)).toEqual([]);
	});

	it('fails a libsql binary packed inside app.asar rather than unpacked', async () => {
		const out = await buildOutDir({ platform: 'darwin', unpack: 'index.js' });
		const violations = layout(out, 'darwin');
		expect(violations).toContain(
			'native module packed inside app.asar (cannot load): node_modules/@libsql/darwin-x64/index.node'
		);
		expect(violations).toContain(
			'native module packed inside app.asar (cannot load): node_modules/@libsql/darwin-arm64/index.node'
		);
		expect(violations).toContain("@libsql/darwin-x64's .node binary is not in app.asar.unpacked");
	});

	it.each([
		['local.db', /a database file: local\.db/],
		['.env', /an \.env file: \.env$/],
		['.env.local', /an \.env file: \.env\.local/],
		['.dross/state.json', /dross state \(\.dross\/\): \.dross/],
		['.git/HEAD', /git metadata \(\.git\/\): \.git/],
		['e2e/restart.e2e.ts', /the e2e suite \(e2e\/\): e2e/],
		['src/lib/server/db.ts', /server source \(src\/lib\/\): src\/lib/],
		['dist-desktop/main.spec.js', /a spec file: dist-desktop\/main\.spec\.js/],
		['build/server/x.test.js', /a spec file: build\/server\/x\.test\.js/],
		['src/desktop/testing/fake-electron.js', /a test fixture: src\/desktop\/testing/],
		['build/fixtures/page.html', /a test fixture: build\/fixtures/],
		['node_modules/some-pkg/.env', /an \.env file: node_modules\/some-pkg\/\.env/],
		['scripts/package-desktop.ts', /outside the app's files: scripts/],
		['README.md', /outside the app's files: README\.md/]
	])('fails an app.asar holding %s', async (path, message) => {
		const out = await buildOutDir({ platform: 'linux', extra: { [path]: 'x' } });
		const violations = layout(out, 'linux');
		expect(violations.length).toBeGreaterThan(0);
		expect(violations.some((v) => message.test(v))).toBe(true);
	});

	it('fails a build that packed the whole repo, listing every leak', async () => {
		const out = await buildOutDir({
			platform: 'darwin',
			extra: {
				'.env': 'SECRET=x',
				'.dross/state.json': '{}',
				'.git/config': '[core]',
				'e2e/seed.ts': 'seed',
				'src/lib/server/db.ts': 'db',
				'scripts/release-tag.spec.ts': 'spec',
				'local.db': 'sqlite'
			}
		});
		const violations = layout(out, 'darwin');
		for (const leak of [
			'.env',
			'.dross/state.json',
			'.git/config',
			'e2e/seed.ts',
			'src/lib/server/db.ts',
			'scripts/release-tag.spec.ts',
			'local.db'
		]) {
			expect(violations.some((v) => v.endsWith(`: ${leak}`))).toBe(true);
		}
	});

	it.each([
		[
			'darwin',
			['darwin-arm64'],
			/@libsql\/darwin-x64's \.node binary is not in app\.asar\.unpacked/
		],
		[
			'darwin',
			['darwin-x64'],
			/@libsql\/darwin-arm64's \.node binary is not in app\.asar\.unpacked/
		],
		[
			'linux',
			['linux-x64-gnu', 'linux-arm64-gnu'],
			/ships @libsql\/linux-arm64-gnu, not a linux binary/
		],
		[
			'linux',
			['linux-x64-gnu', 'linux-x64-musl'],
			/ships @libsql\/linux-x64-musl, not a linux binary/
		],
		['linux', ['linux-x64-musl'], /linux-x64-gnu's \.node binary is not/],
		['win32', ['win32-x64-msvc', 'darwin-x64'], /ships @libsql\/darwin-x64, not a win32 binary/],
		[
			'win32',
			['win32-x64-msvc', 'win32-arm64-msvc'],
			/ships @libsql\/win32-arm64-msvc, not a win32 binary/
		],
		['win32', ['linux-x64-gnu'], /win32-x64-msvc's \.node binary is not/]
	] as const)('fails %s shipping libsql %j', async (platform, natives, message) => {
		const violations = layout(await buildOutDir({ platform, natives }), platform);
		expect(violations.some((v) => message.test(v))).toBe(true);
	});

	it('fails a packaged package.json version other than the stamp', async () => {
		const out = await buildOutDir({ platform: 'darwin', packagedVersion: '0.1.5' });
		expect(layout(out, 'darwin')).toEqual([
			`packaged package.json version is '0.1.5', stamped ${VERSION}`
		]);
	});

	it('fails a latest*.yml version other than the stamp', async () => {
		const out = await buildOutDir({ platform: 'win32', ymlVersion: '0.1.5' });
		expect(layout(out, 'win32')).toEqual([`latest.yml version is '0.1.5', stamped ${VERSION}`]);
	});

	it('fails a files[].url naming a file absent from the output dir', async () => {
		const out = await buildOutDir({
			platform: 'linux',
			latest: (yml) => yml.replace('  - url: price-check', '  - url: gone-price-check')
		});
		expect(layout(out, 'linux')).toEqual([
			`latest-linux.yml names gone-price-check-${VERSION}-linux-x86_64.AppImage, which is not in the output dir`
		]);
	});

	it('fails a files[].url with whitespace and an entry without sha512', async () => {
		const out = await buildOutDir({
			platform: 'darwin',
			latest: (yml) =>
				yml
					.replace(`  - url: price-check-${VERSION}-mac-universal.dmg`, '  - url: Price Check.dmg')
					.replace('    sha512: c2hhNTEy==\n    size: 10\npath', '    size: 10\npath')
		});
		const violations = layout(out, 'darwin');
		expect(violations).toContain("latest-mac.yml url contains whitespace: 'Price Check.dmg'");
		expect(violations).toContain(
			`latest-mac.yml entry price-check-${VERSION}-mac-universal.zip has no sha512`
		);
		expect(violations).toHaveLength(2);
	});

	it('fails a missing artefact', async () => {
		const out = await buildOutDir({
			platform: 'darwin',
			omit: [`price-check-${VERSION}-mac-universal.zip.blockmap`]
		});
		expect(layout(out, 'darwin')).toEqual([
			`missing artefact price-check-${VERSION}-mac-universal.zip.blockmap in ${out}`
		]);
	});

	it('fails a release built with the CI feed, and a CI build with the GitHub feed', async () => {
		const generic = await buildOutDir({ platform: 'linux', appUpdate: LOOPBACK_FEED });
		expect(layout(generic, 'linux', 'release')).toEqual([
			"app-update.yml provider is 'generic', a release needs github"
		]);
		expect(layout(generic, 'linux', 'ci')).toEqual([]);
		const github = await buildOutDir({ platform: 'linux' });
		expect(layout(github, 'linux', 'ci')).toEqual([
			"app-update.yml provider is 'github', a ci build needs the generic loopback feed"
		]);
	});

	it('fails a ci feed off loopback and a release feed for another repo', async () => {
		const remote = await buildOutDir({
			platform: 'win32',
			appUpdate: 'provider: generic\nurl: https://updates.example.invalid/\n'
		});
		expect(layout(remote, 'win32', 'ci')).toEqual([
			"app-update.yml feed 'https://updates.example.invalid/' is not an http loopback URL"
		]);
		const fork = await buildOutDir({
			platform: 'win32',
			appUpdate: 'owner: someone\nrepo: price-check\nprovider: github\n'
		});
		expect(layout(fork, 'win32', 'release')).toEqual([
			'app-update.yml points at someone/price-check, not Rivil/price-check'
		]);
	});

	it('fails a darwin output dir that also holds a single-arch build', async () => {
		const out = await buildOutDir({ platform: 'darwin' });
		mkdirSync(join(out, 'mac-arm64'));
		expect(layout(out, 'darwin')).toEqual([
			expect.stringMatching(/single-arch mac build \(mac-arm64\)/)
		]);
	});

	it('fails a files[].url naming a directory in the output dir', async () => {
		const out = await buildOutDir({
			platform: 'linux',
			latest: (yml) => yml.replace(/ {2}- url: \S+/, '  - url: linux-unpacked')
		});
		expect(layout(out, 'linux')).toEqual([
			'latest-linux.yml names linux-unpacked, which is not in the output dir'
		]);
	});

	it('names each of app.asar, latest*.yml and app-update.yml that is missing', async () => {
		const out = await buildOutDir({ platform: 'linux' });
		const resources = resourcesFor(out, 'linux');
		for (const path of [
			join(resources, 'app.asar'),
			join(out, 'latest-linux.yml'),
			join(resources, 'app-update.yml')
		]) {
			rmSync(path);
		}
		const violations = layout(out, 'linux');
		expect(violations).toContain(`no app.asar at ${join(resources, 'app.asar')}`);
		expect(violations).toContain(`no latest-linux.yml in ${out}`);
		expect(violations).toContain(`no app-update.yml at ${join(resources, 'app-update.yml')}`);
	});
});

describe('listAsar and listTree', () => {
	it.skipIf(process.platform === 'win32')('lists dirs, files and links in app.asar', async () => {
		const root = tempDir('verify-asar-');
		writeTree(join(root, 'app'), { 'lib/addon.js': 'x' });
		symlinkSync('addon.js', join(root, 'app', 'lib', 'addon.node'));
		await createPackageWithOptions(join(root, 'app'), join(root, 'app.asar'), {});
		const entries = listAsar(join(root, 'app.asar'));
		expect(entries.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: 'lib', unpacked: false, kind: 'dir' },
			{ path: 'lib/addon.js', unpacked: false, kind: 'file' },
			{ path: 'lib/addon.node', unpacked: false, kind: 'link' }
		]);
	});

	it('lists every file under a dir, and nothing for a missing dir', () => {
		const root = tempDir('verify-tree-');
		writeTree(root, { 'a.txt': 'a', 'b/c.node': 'c' });
		expect(listTree(root).sort()).toEqual(['a.txt', 'b/c.node']);
		expect(listTree(join(root, 'absent'))).toEqual([]);
	});
});

describe('isFile', () => {
	it('is true only for a regular file, false when nothing is there', () => {
		const root = tempDir('verify-isfile-');
		writeTree(root, { 'a.txt': 'a' });
		expect(isFile(join(root, 'a.txt'))).toBe(true);
		expect(isFile(root)).toBe(false);
		expect(isFile(join(root, 'absent'))).toBe(false);
		expect(isFile(join(root, 'a.txt', 'child'))).toBe(false);
	});

	it('throws any other stat error', () => {
		expect(() => isFile('bad\u0000path')).toThrow(
			expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' })
		);
	});
});

describe('verifyAppFiles', () => {
	const entries = (paths: string[]): AppEntry[] =>
		paths.map((path) => ({ path, unpacked: false, kind: 'file' as const }));
	const unpacked = [
		'node_modules/libsql/index.js',
		'node_modules/@libsql/linux-x64-gnu/index.node'
	];

	it('checks the unpacked dir for dev files and stray roots too', () => {
		expect(verifyAppFiles(entries(['package.json']), unpacked, 'linux')).toEqual([]);
		expect(verifyAppFiles(entries([]), [...unpacked, '.env'], 'linux')).toEqual([
			'app.asar.unpacked ships an .env file: .env'
		]);
		expect(verifyAppFiles(entries([]), [...unpacked, 'build/handler.js'], 'linux')).toEqual([
			'app.asar.unpacked ships a path outside asarUnpack: build/handler.js'
		]);
	});

	it('fails when libsql itself is not unpacked', () => {
		expect(verifyAppFiles(entries([]), unpacked.slice(1), 'linux')).toEqual([
			'libsql (node_modules/libsql/index.js) is not in app.asar.unpacked'
		]);
	});

	it('flags only packed files ending .node, not dirs or links', () => {
		const odd: AppEntry[] = [
			{ path: 'node_modules/pkg/addon.node', unpacked: false, kind: 'dir' },
			{ path: 'node_modules/pkg/link.node', unpacked: false, kind: 'link' }
		];
		expect(verifyAppFiles(odd, unpacked, 'linux')).toEqual([]);
	});

	it("fails a libsql package's .node binary missing from the unpacked dir", () => {
		const jsOnly = ['node_modules/libsql/index.js', 'node_modules/@libsql/linux-x64-gnu/index.js'];
		expect(verifyAppFiles(entries([]), jsOnly, 'linux')).toEqual([
			"@libsql/linux-x64-gnu's .node binary is not in app.asar.unpacked"
		]);
	});

	it('counts foreign @libsql natives packed in app.asar too, sorted by name', () => {
		const packed = entries([
			'node_modules/@libsql/win32-x64-msvc/package.json',
			'node_modules/@libsql/darwin-x64/package.json'
		]);
		expect(verifyAppFiles(packed, unpacked, 'linux')).toEqual([
			'ships @libsql/darwin-x64, not a linux binary',
			'ships @libsql/win32-x64-msvc, not a linux binary'
		]);
	});

	it('counts only top-level @libsql packages whose name starts with an OS', () => {
		const others = entries([
			'node_modules/@libsql/isomorphic-linux-ws/index.js',
			'build/node_modules/@libsql/darwin-x64/index.js'
		]);
		expect(verifyAppFiles(others, unpacked, 'linux')).toEqual([]);
	});

	it("takes no root from APP_FILES' negated patterns", () => {
		expect(verifyAppFiles(entries(['!**']), unpacked, 'linux')).toEqual([
			"app.asar ships a path outside the app's files: !**"
		]);
	});
});

describe('devFileReason', () => {
	it('lets node_modules keep test dirs but never .env, .dross, .git or databases', () => {
		expect(devFileReason('node_modules/pkg/test/x.spec.js')).toBeNull();
		expect(devFileReason('node_modules/pkg/.github/workflows/ci.yml')).toBeNull();
		expect(devFileReason('node_modules/pkg/.env.example')).toMatch(/\.env/);
		expect(devFileReason('node_modules/pkg/.dross/x')).toMatch(/dross/);
		expect(devFileReason('node_modules/pkg/.git/HEAD')).toMatch(/git/);
		expect(devFileReason('node_modules/pkg/data.sqlite')).toMatch(/database/);
		expect(devFileReason('build/client/app.js')).toBeNull();
		expect(devFileReason('src/desktop/assets/tray-icon.png')).toBeNull();
	});

	it('names src/lib itself and everything under it', () => {
		expect(devFileReason('src/lib')).toBe('server source (src/lib/)');
		expect(devFileReason('src/lib/server/db.ts')).toBe('server source (src/lib/)');
	});

	it.each(['__fixtures__', '__tests__', '__snapshots__'])(
		'names a %s dir a test fixture',
		(dir) => {
			expect(devFileReason(`build/${dir}/x.js`)).toBe('a test fixture');
		}
	);

	it('matches spec and database names only at the end', () => {
		expect(devFileReason('dist-desktop/x.spec.mjs')).toBe('a spec file');
		expect(devFileReason('build/client/data.test.json')).toBeNull();
		expect(devFileReason('build/client/schema.dbml')).toBeNull();
	});
});

describe('parseUpdateYaml', () => {
	it('reads electron-builder latest*.yml scalars and files', () => {
		const doc = parseUpdateYaml(
			[
				'version: 0.1.4',
				'files:',
				'  - url: a.zip',
				'    sha512: abc==',
				'    size: 1',
				'  - url: "b.dmg"',
				'    sha512: def==',
				'path: a.zip',
				"releaseDate: '2026-11-14T18:36:45.051Z'",
				''
			].join('\r\n')
		);
		expect(doc.scalars).toEqual({
			version: '0.1.4',
			path: 'a.zip',
			releaseDate: '2026-11-14T18:36:45.051Z'
		});
		expect(doc.files).toEqual([
			{ url: 'a.zip', sha512: 'abc==', size: '1' },
			{ url: 'b.dmg', sha512: 'def==' }
		]);
	});

	it('unquotes only a value both opened and closed by the same quote', () => {
		const doc = parseUpdateYaml(
			[
				"a: abc'",
				"b: 'abc",
				"c: '",
				"d: ''",
				"e: 'it''s'",
				'f: abc"',
				'g: "abc',
				'h: "',
				'i: ""',
				'j: padded   '
			].join('\n')
		);
		expect(doc.scalars).toEqual({
			a: "abc'",
			b: "'abc",
			c: "'",
			d: '',
			e: "it's",
			f: 'abc"',
			g: '"abc',
			h: '"',
			i: '',
			j: 'padded'
		});
	});

	it('strips only a leading BOM and skips blank and comment lines', () => {
		expect(parseUpdateYaml('﻿version: 1\n\n# note: x\n   \nb: 2').scalars).toEqual({
			version: '1',
			b: '2'
		});
		expect(parseUpdateYaml('b: 1﻿2').scalars).toEqual({ b: '1﻿2' });
	});

	it('reads files[] only under files:, one map per dash', () => {
		const doc = parseUpdateYaml(
			[
				'  - url: stray',
				'files:',
				'  url: first',
				'  -   url: second',
				'    sha512:abc',
				'    note: just text',
				'  - url:',
				'    sha512: s3',
				'bad key: x',
				'next:x',
				'  - url: fourth',
				'other:',
				'  nested: x'
			].join('\n')
		);
		expect(doc.files).toEqual([
			{ url: 'first' },
			{ url: 'second', note: 'just text' },
			{ url: '', sha512: 's3' },
			{ url: 'fourth' }
		]);
		expect(doc.scalars).toEqual({});
	});
});

describe('verifyFeed', () => {
	const feed = (scalars: Record<string, string>) => ({ scalars, files: [] });

	it('passes either loopback host over http for ci', () => {
		expect(verifyFeed(feed({ provider: 'generic', url: 'http://127.0.0.1:47811/' }), 'ci')).toEqual(
			[]
		);
		expect(verifyFeed(feed({ provider: 'generic', url: 'http://[::1]:47811/' }), 'ci')).toEqual([]);
	});

	it.each(['https://127.0.0.1:47811/', 'http://192.168.1.5:47811/', 'not a url'])(
		'fails a ci feed at %s',
		(url) => {
			expect(verifyFeed(feed({ provider: 'generic', url }), 'ci')).toEqual([
				`app-update.yml feed '${url}' is not an http loopback URL`
			]);
		}
	);

	it('fails a ci feed with no url', () => {
		expect(verifyFeed(feed({ provider: 'generic' }), 'ci')).toEqual([
			"app-update.yml feed 'undefined' is not an http loopback URL"
		]);
	});

	it("fails a release feed for the right owner's other repo", () => {
		const scalars = { provider: 'github', owner: GITHUB_RELEASES.owner, repo: 'other' };
		expect(verifyFeed(feed(scalars), 'release')).toEqual([
			`app-update.yml points at ${GITHUB_RELEASES.owner}/other, not ${GITHUB_RELEASES.owner}/${GITHUB_RELEASES.repo}`
		]);
	});
});

describe('verifyUpdateFile', () => {
	const files = new Set(['a.exe']);

	it('fails a file listing nothing', () => {
		expect(
			verifyUpdateFile('latest.yml', { scalars: { version: VERSION }, files: [] }, VERSION, files)
		).toEqual(['latest.yml lists no files']);
	});

	it('fails an entry with neither url nor sha512', () => {
		const doc = { scalars: { version: VERSION }, files: [{ size: '1' }] };
		expect(verifyUpdateFile('latest.yml', doc, VERSION, files)).toEqual([
			'latest.yml has a files[] entry without a url',
			'latest.yml entry ? has no sha512'
		]);
	});
});

describe('runCli layout', () => {
	const deps = (lines: string[], platform: NodeJS.Platform): CliDeps => ({
		platform,
		env: {},
		run: fakeRunner(() => OK),
		exists: () => true,
		readInstaller: () => '',
		stdout: (line) => lines.push(line),
		stderr: (line) => lines.push(line)
	});

	it('checks the host OS build with the stamp and mode', async () => {
		const out = await buildOutDir({ platform: 'linux' });
		const lines: string[] = [];
		expect(
			await runCli(['layout', out, '--version', VERSION, '--mode', 'release'], deps(lines, 'linux'))
		).toBe(0);
		expect(lines).toEqual(['verify-packaged: layout ok']);
		expect(
			await runCli(['layout', out, '--version', '0.1.5', '--mode', 'release'], deps(lines, 'linux'))
		).toBe(1);
		expect(
			await runCli(['layout', out, '--version', VERSION, '--mode', 'ci'], deps(lines, 'linux'))
		).toBe(1);
	});

	it('refuses a missing --version or --mode, unknown commands and options', async () => {
		const lines: string[] = [];
		const d = deps(lines, 'linux');
		expect(await runCli(['layout', '/x', '--mode', 'release'], d)).toBe(1);
		expect(await runCli(['layout', '/x', '--version', VERSION], d)).toBe(1);
		expect(await runCli(['layout', '/x', '--version', VERSION, '--mode', 'prod'], d)).toBe(1);
		expect(await runCli(['ship', '/x'], d)).toBe(1);
		expect(await runCli(['mac', APP, '--force'], d)).toBe(1);
		expect(lines).toHaveLength(5);
		expect(lines.slice(0, 4)).toEqual([
			'verify-packaged: layout needs --version <v>',
			'verify-packaged: layout needs --mode ci or --mode release',
			'verify-packaged: layout needs --mode ci or --mode release',
			expect.stringMatching(/^verify-packaged: usage: verify-packaged\.ts layout <outDir>/)
		]);
	});

	it('passes a ci build with the loopback feed under --mode ci', async () => {
		const out = await buildOutDir({ platform: 'linux', appUpdate: LOOPBACK_FEED });
		const lines: string[] = [];
		expect(
			await runCli(['layout', out, '--version', VERSION, '--mode', 'ci'], deps(lines, 'linux'))
		).toBe(0);
		expect(lines).toEqual(['verify-packaged: layout ok']);
	});
});
