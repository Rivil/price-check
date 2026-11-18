// packaged-app.ts: artefact names, locating the packaged app, the userData dir a
// packaged run uses, and the Windows silent install (spec c-1, c-3, c-4).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_DIR_NAME } from '../src/desktop/app-paths.ts';
import {
	executablePath,
	expectedArtefacts,
	findUserInstall,
	installLocationOf,
	installWindows,
	locate,
	packagedUserDataDir,
	parseRegQuery,
	runCli,
	spawnRunner,
	type Command,
	type RunResult,
	type Runner
} from './packaged-app.ts';
import { PRODUCT_NAME } from './package-desktop.ts';

type PackagedApp = typeof import('./packaged-app.ts');

const HKCU_UNINSTALL = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const INSTALL_DIR = 'C:\\Users\\runner\\AppData\\Local\\Programs\\price-check-app';

/** `reg query ... /s` as reg.exe prints it (CRLF, four-space columns). */
function regOutput(keys: { key: string; values: Record<string, string> }[]): string {
	return keys
		.map(({ key, values }) =>
			[
				'',
				key,
				...Object.entries(values).map(([name, data]) => `    ${name}    REG_SZ    ${data}`)
			].join('\r\n')
		)
		.join('\r\n')
		.concat('\r\n');
}

const OTHER_APP = {
	key: `${HKCU_UNINSTALL}\\SomeOtherApp`,
	values: {
		DisplayName: 'Price Checker 2.0.0',
		UninstallString: '"C:\\Other\\uninstall.exe"'
	}
};
const PRODUCT = {
	key: `${HKCU_UNINSTALL}\\0b8f0a4e-guid`,
	values: {
		DisplayName: `${PRODUCT_NAME} 0.1.5`,
		UninstallString: `"${INSTALL_DIR}\\Uninstall ${PRODUCT_NAME}.exe" /currentuser`,
		DisplayVersion: '0.1.5'
	}
};

/** The message `fn` throws, so a test can pin it exactly rather than by pattern. */
function thrownMessage(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error('expected a throw');
}

/** Loads a fresh packaged-app.ts with package-desktop.ts's ARTIFACT_NAME replaced. */
async function withArtifactName(name: string, check: (fresh: PackagedApp) => void): Promise<void> {
	vi.resetModules();
	vi.doMock('./package-desktop.ts', async (importOriginal) => ({
		...(await importOriginal<typeof import('./package-desktop.ts')>()),
		ARTIFACT_NAME: name
	}));
	try {
		check(await import('./packaged-app.ts'));
	} finally {
		vi.doUnmock('./package-desktop.ts');
		vi.resetModules();
	}
}

function fakeRunner(respond: (command: Command) => RunResult): Runner & { calls: Command[] } {
	const calls: Command[] = [];
	const run = (async (command: Command) => {
		calls.push(command);
		return respond(command);
	}) as Runner & { calls: Command[] };
	run.calls = calls;
	return run;
}

describe('expectedArtefacts', () => {
	it('names the universal dmg and zip, their blockmaps and latest-mac.yml for darwin', () => {
		expect(expectedArtefacts('darwin', '0.1.5-rc.1')).toEqual([
			'price-check-0.1.5-rc.1-mac-universal.dmg',
			'price-check-0.1.5-rc.1-mac-universal.dmg.blockmap',
			'price-check-0.1.5-rc.1-mac-universal.zip',
			'price-check-0.1.5-rc.1-mac-universal.zip.blockmap',
			'latest-mac.yml'
		]);
	});

	it('names the x64 setup exe, its blockmap and latest.yml for win32', () => {
		expect(expectedArtefacts('win32', '0.1.5-rc.1')).toEqual([
			'price-check-0.1.5-rc.1-win-x64.exe',
			'price-check-0.1.5-rc.1-win-x64.exe.blockmap',
			'latest.yml'
		]);
	});

	it('names the x86_64 AppImage and latest-linux.yml for linux', () => {
		expect(expectedArtefacts('linux', '0.1.5')).toEqual([
			'price-check-0.1.5-linux-x86_64.AppImage',
			'latest-linux.yml'
		]);
	});

	it('never names a file with whitespace (GitHub would rename it)', () => {
		for (const platform of ['darwin', 'win32', 'linux'] as const) {
			for (const name of expectedArtefacts(platform, '0.1.5-rc.1')) expect(name).not.toMatch(/\s/);
		}
	});

	it('refuses a version package:desktop would refuse', () => {
		expect(() => expectedArtefacts('darwin', '0.1')).toThrow(/MAJOR\.MINOR\.PATCH/);
		expect(() => expectedArtefacts('linux', '0.1.5 beta')).toThrow(/MAJOR\.MINOR\.PATCH/);
		expect(() => expectedArtefacts('win32', '0.1.5-beta.1')).toThrow(/MAJOR\.MINOR\.PATCH/);
		expect(() => expectedArtefacts('linux', 'v0.1.5')).toThrow(/MAJOR\.MINOR\.PATCH/);
	});

	it('takes one- and many-digit MAJOR, MINOR, PATCH and rc numbers', () => {
		expect(expectedArtefacts('linux', '1.0.0')[0]).toBe('price-check-1.0.0-linux-x86_64.AppImage');
		expect(expectedArtefacts('linux', '10.20.30-rc.12')[0]).toBe(
			'price-check-10.20.30-rc.12-linux-x86_64.AppImage'
		);
	});

	it('refuses an ARTIFACT_NAME macro it cannot fill', async () => {
		await withArtifactName('price-check-${version}-${channel}.${ext}', (fresh) => {
			expect(thrownMessage(() => fresh.expectedArtefacts('linux', '0.1.5'))).toBe(
				'ARTIFACT_NAME uses an unknown macro ${channel}'
			);
		});
	});

	it('refuses an ARTIFACT_NAME that yields a name with whitespace', async () => {
		await withArtifactName('Price Check-${version}-${os}-${arch}.${ext}', (fresh) => {
			expect(thrownMessage(() => fresh.expectedArtefacts('linux', '0.1.5'))).toBe(
				"artefact name contains whitespace: 'Price Check-0.1.5-linux-x86_64.AppImage'"
			);
		});
	});
});

describe('locate and executablePath', () => {
	let out: string;
	beforeEach(() => {
		out = mkdtempSync(join(tmpdir(), 'packaged-app-'));
	});
	afterEach(() => rmSync(out, { recursive: true, force: true }));

	function universalApp(): string {
		const app = join(out, 'mac-universal', `${PRODUCT_NAME}.app`);
		mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
		return app;
	}

	it("gives '<out>/mac-universal/<PRODUCT_NAME>.app/Contents/MacOS/<PRODUCT_NAME>' on darwin", () => {
		universalApp();
		expect(executablePath(locate(out, 'darwin'))).toBe(
			join(out, 'mac-universal', `${PRODUCT_NAME}.app`, 'Contents', 'MacOS', PRODUCT_NAME)
		);
		expect(PRODUCT_NAME).toBe('Price Check');
	});

	it.each(['mac-arm64', 'mac-x64', 'mac'])('refuses an output dir holding %s/', (dir) => {
		universalApp();
		mkdirSync(join(out, dir));
		expect(thrownMessage(() => locate(out, 'darwin'))).toBe(
			`${out} holds a single-arch mac build (${dir}): only mac-universal ships`
		);
	});

	it('refuses a dir with no universal app', () => {
		mkdirSync(join(out, 'mac-arm64', `${PRODUCT_NAME}.app`), { recursive: true });
		expect(() => locate(out, 'darwin')).toThrow();
		rmSync(join(out, 'mac-arm64'), { recursive: true });
		expect(() => locate(out, 'darwin')).toThrow(/no universal app/);
	});

	it('returns the one AppImage on linux and refuses two or none', () => {
		expect(thrownMessage(() => locate(out, 'linux'))).toBe(
			`expected exactly one AppImage in ${out}, found 0`
		);
		writeFileSync(join(out, 'price-check-0.1.5-linux-x86_64.AppImage'), '');
		expect(executablePath(locate(out, 'linux'))).toBe(
			join(out, 'price-check-0.1.5-linux-x86_64.AppImage')
		);
		writeFileSync(join(out, 'price-check-0.1.4-linux-x86_64.AppImage'), '');
		expect(thrownMessage(() => locate(out, 'linux'))).toBe(
			`expected exactly one AppImage in ${out}, found 2: ` +
				'price-check-0.1.4-linux-x86_64.AppImage, price-check-0.1.5-linux-x86_64.AppImage'
		);
	});

	it('names clashing files in sorted order whatever order the dir is read in', async () => {
		for (const name of ['a.AppImage', 'b.AppImage', 'c.AppImage']) {
			writeFileSync(join(out, name), '');
		}
		vi.resetModules();
		vi.doMock('node:fs', async (importOriginal) => {
			const fs = await importOriginal<typeof import('node:fs')>();
			const readdirSync = (path: string, options: { withFileTypes: true }) =>
				fs.readdirSync(path, options).sort((a, b) => b.name.localeCompare(a.name));
			return { ...fs, readdirSync };
		});
		try {
			const fresh = await import('./packaged-app.ts');
			expect(thrownMessage(() => fresh.locate(out, 'linux'))).toBe(
				`expected exactly one AppImage in ${out}, found 3: a.AppImage, b.AppImage, c.AppImage`
			);
		} finally {
			vi.doUnmock('node:fs');
			vi.resetModules();
		}
	});

	it('locates the one installer on win32 and runs the app from its install dir', () => {
		writeFileSync(join(out, 'price-check-0.1.5-win-x64.exe'), '');
		writeFileSync(join(out, 'price-check-0.1.5-win-x64.exe.blockmap'), '');
		const located = locate(out, 'win32');
		expect(located).toEqual({
			platform: 'win32',
			outDir: out,
			installer: join(out, 'price-check-0.1.5-win-x64.exe')
		});
		expect(() => executablePath(located)).toThrow(/install it first/);
		expect(executablePath(located, INSTALL_DIR)).toBe(`${INSTALL_DIR}\\${PRODUCT_NAME}.exe`);
		writeFileSync(join(out, 'other.exe'), '');
		expect(() => locate(out, 'win32')).toThrow(/exactly one installer/);
	});

	it('refuses a missing output dir', () => {
		expect(() => locate(join(out, 'absent'), 'linux')).toThrow(/no output dir/);
	});
});

describe('packagedUserDataDir', () => {
	it('is <home>/Library/Application Support/price-check on darwin', () => {
		expect(packagedUserDataDir('darwin', {}, '/Users/u')).toBe(
			'/Users/u/Library/Application Support/price-check'
		);
	});

	it('is <APPDATA>\\price-check on win32, and refuses without APPDATA', () => {
		expect(
			packagedUserDataDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u')
		).toBe('C:\\Users\\u\\AppData\\Roaming\\price-check');
		expect(() => packagedUserDataDir('win32', {}, 'C:\\Users\\u')).toThrow(/APPDATA/);
	});

	it('trims APPDATA and treats a blank one as unset', () => {
		expect(packagedUserDataDir('win32', { APPDATA: ' C:\\A ' }, 'C:\\U')).toBe(
			'C:\\A\\price-check'
		);
		expect(() => packagedUserDataDir('win32', { APPDATA: '  ' }, 'C:\\U')).toThrow(
			/APPDATA is not set/
		);
	});

	it('is $XDG_CONFIG_HOME/price-check on linux, falling back to <home>/.config', () => {
		expect(packagedUserDataDir('linux', { XDG_CONFIG_HOME: '/x/config' }, '/home/u')).toBe(
			'/x/config/price-check'
		);
		expect(packagedUserDataDir('linux', {}, '/home/u')).toBe('/home/u/.config/price-check');
		expect(packagedUserDataDir('linux', { XDG_CONFIG_HOME: '  ' }, '/home/u')).toBe(
			'/home/u/.config/price-check'
		);
	});

	it('takes its folder name from APP_DIR_NAME, not a literal', async () => {
		expect(APP_DIR_NAME).toBe('price-check');
		vi.resetModules();
		vi.doMock('../src/desktop/app-paths.ts', () => ({ APP_DIR_NAME: 'renamed-dir' }));
		try {
			const fresh = await import('./packaged-app.ts');
			expect(fresh.packagedUserDataDir('darwin', {}, '/Users/u')).toBe(
				'/Users/u/Library/Application Support/renamed-dir'
			);
			expect(fresh.packagedUserDataDir('win32', { APPDATA: 'C:\\A' }, 'C:\\U')).toBe(
				'C:\\A\\renamed-dir'
			);
			expect(fresh.packagedUserDataDir('linux', {}, '/home/u')).toBe('/home/u/.config/renamed-dir');
		} finally {
			vi.doUnmock('../src/desktop/app-paths.ts');
			vi.resetModules();
		}
	});
});

describe('parseRegQuery', () => {
	it("picks the key whose DisplayName is the product's and skips the others", () => {
		const key = parseRegQuery(regOutput([OTHER_APP, PRODUCT]));
		expect(key?.key).toBe(PRODUCT.key);
		expect(key?.values.DisplayName).toBe('Price Check 0.1.5');
		expect(installLocationOf(key!)).toBe(INSTALL_DIR);
	});

	it('accepts a bare PRODUCT_NAME DisplayName', () => {
		const bare = { ...PRODUCT, values: { ...PRODUCT.values, DisplayName: PRODUCT_NAME } };
		expect(parseRegQuery(regOutput([bare]))?.key).toBe(PRODUCT.key);
	});

	it.each([
		'Price Checker 2.0.0',
		'Price Check Pro',
		'price check 0.1.5',
		'My Price Check 0.1.5',
		''
	])("returns null when the only DisplayName is '%s'", (displayName) => {
		const other = { key: PRODUCT.key, values: { ...PRODUCT.values, DisplayName: displayName } };
		expect(parseRegQuery(regOutput([other]))).toBeNull();
	});

	it('returns null for empty output and a key with no DisplayName', () => {
		expect(parseRegQuery('')).toBeNull();
		expect(
			parseRegQuery(regOutput([{ key: PRODUCT.key, values: { UninstallString: 'x' } }]))
		).toBeNull();
	});

	it('prefers an InstallLocation value over the UninstallString', () => {
		const withLocation = {
			key: PRODUCT.key,
			values: { ...PRODUCT.values, InstallLocation: 'D:\\Apps\\pc' }
		};
		expect(installLocationOf(parseRegQuery(regOutput([withLocation]))!)).toBe('D:\\Apps\\pc');
		const neither = {
			key: PRODUCT.key,
			values: { DisplayName: PRODUCT_NAME, UninstallString: 'x' }
		};
		expect(installLocationOf(parseRegQuery(regOutput([neither]))!)).toBeNull();
	});

	const PRODUCT_LINES = [
		`    DisplayName    REG_SZ    ${PRODUCT_NAME} 0.1.5`,
		`    UninstallString    REG_SZ    "C:\\A\\u.exe" /currentuser`
	];
	const PRODUCT_VALUES = {
		DisplayName: `${PRODUCT_NAME} 0.1.5`,
		UninstallString: '"C:\\A\\u.exe" /currentuser'
	};

	it('reads LF-only output as well as CRLF', () => {
		expect(parseRegQuery(['', PRODUCT.key, ...PRODUCT_LINES, ''].join('\n'))).toEqual({
			key: PRODUCT.key,
			values: PRODUCT_VALUES
		});
	});

	it('strips a leading byte-order mark before the first key', () => {
		expect(parseRegQuery(['\uFEFF' + PRODUCT.key, ...PRODUCT_LINES].join('\r\n'))).toEqual({
			key: PRODUCT.key,
			values: PRODUCT_VALUES
		});
	});

	it('keeps a byte-order mark that is not at the start', () => {
		const text = [PRODUCT.key, ...PRODUCT_LINES, '    InstallLocation    REG_SZ    D:\\\uFEFFApps'];
		expect(parseRegQuery(text.join('\r\n'))?.values.InstallLocation).toBe('D:\\\uFEFFApps');
	});

	it('drops trailing whitespace from every line', () => {
		const text = [
			`${PRODUCT.key}  `,
			`    DisplayName    REG_SZ    ${PRODUCT_NAME} 0.1.5   `,
			`    UninstallString    REG_SZ    "C:\\A\\u.exe" /currentuser\t `
		];
		expect(parseRegQuery(text.join('\r\n'))).toEqual({ key: PRODUCT.key, values: PRODUCT_VALUES });
	});

	it('keeps a value with no data as an empty string', () => {
		// reg prints '    Name    REG_SZ    ' for an empty value; its trailing spaces go.
		const text = [PRODUCT.key, ...PRODUCT_LINES, '    InstallLocation    REG_SZ    '];
		const key = parseRegQuery(text.join('\r\n'));
		expect(key).toEqual({ key: PRODUCT.key, values: { ...PRODUCT_VALUES, InstallLocation: '' } });
		expect(installLocationOf(key!)).toBe('C:\\A');
	});

	it('ignores lines that are not a key or a four-space-column value', () => {
		const text = [
			'    Stray    REG_SZ    before any key',
			PRODUCT.key,
			'    Parent    REG_SZ    HKEY_CURRENT_USER\\Software\\Other',
			'Unindented    Extra    REG_SZ    x',
			'    Narrow    REG_SZ  x',
			...PRODUCT_LINES
		];
		expect(parseRegQuery(text.join('\r\n'))).toEqual({
			key: PRODUCT.key,
			values: { Parent: 'HKEY_CURRENT_USER\\Software\\Other', ...PRODUCT_VALUES }
		});
	});
});

describe('installLocationOf', () => {
	const at = (values: Record<string, string>) => installLocationOf({ key: PRODUCT.key, values });

	it('trims InstallLocation and skips a blank one', () => {
		expect(at({ InstallLocation: ' D:\\Apps\\pc ' })).toBe('D:\\Apps\\pc');
		expect(at({ InstallLocation: '   ', UninstallString: '"C:\\P\\u.exe"' })).toBe('C:\\P');
	});

	it('reads a quoted UninstallString after leading whitespace', () => {
		expect(at({ UninstallString: '  "C:\\P\\u.exe" /currentuser' })).toBe('C:\\P');
	});

	it('takes the quoted path only when it opens the UninstallString', () => {
		expect(at({ UninstallString: 'C:\\P\\u.exe "C:\\Q\\arg.txt"' })).toBeNull();
	});

	it('is null with neither value', () => {
		expect(at({})).toBeNull();
	});
});

describe('installWindows', () => {
	const installer = 'C:\\out\\price-check-0.1.5-win-x64.exe';

	it("runs '<installer> /S' then reads the HKCU uninstall entry", async () => {
		const run = fakeRunner((command) =>
			command.file === 'reg'
				? { code: 0, stdout: regOutput([OTHER_APP, PRODUCT]), stderr: '' }
				: { code: 0, stdout: '', stderr: '' }
		);
		const installed = await installWindows(installer, run);
		expect(installed.installLocation).toBe(INSTALL_DIR);
		expect(run.calls[0]).toEqual({ file: installer, args: ['/S'] });
		expect(run.calls[1]).toEqual({
			file: 'reg',
			args: ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s']
		});
	});

	it('rejects when the installer exits 2, before reading the registry', async () => {
		const run = fakeRunner((command) =>
			command.file === installer
				? { code: 2, stdout: '', stderr: '' }
				: { code: 0, stdout: regOutput([PRODUCT]), stderr: '' }
		);
		await expect(installWindows(installer, run)).rejects.toThrow(/exited 2/);
		expect(run.calls).toHaveLength(1);
	});

	it('rejects with the reg failure when the registry cannot be read', async () => {
		const run = fakeRunner((command) =>
			command.file === 'reg'
				? { code: -1, stdout: '', stderr: 'spawn reg ENOENT' }
				: { code: 0, stdout: '', stderr: '' }
		);
		await expect(installWindows(installer, run)).rejects.toThrow(
			/reg query HKCU.* exited -1: spawn reg ENOENT/
		);
	});

	it('rejects when no per-user entry for the product appears', async () => {
		const none = fakeRunner((command) =>
			command.file === 'reg'
				? {
						code: 1,
						stdout: '',
						stderr: 'ERROR: The system was unable to find the specified registry key'
					}
				: { code: 0, stdout: '', stderr: '' }
		);
		await expect(installWindows(installer, none)).rejects.toThrow(/no per-user \(HKCU\)/);
		const other = fakeRunner((command) =>
			command.file === 'reg'
				? { code: 0, stdout: regOutput([OTHER_APP]), stderr: '' }
				: { code: 0, stdout: '', stderr: '' }
		);
		await expect(installWindows(installer, other)).rejects.toThrow(/no per-user \(HKCU\)/);
	});
});

describe('findUserInstall', () => {
	const query = 'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s';
	const failing = (code: number, stderr: string) =>
		findUserInstall(fakeRunner(() => ({ code, stdout: '', stderr })));

	it("names reg's last stderr line, whatever the line endings", async () => {
		await expect(failing(5, 'WARNING: slow\r\nERROR: Access is denied.\r\n')).rejects.toThrow(
			new Error(`${query} exited 5: ERROR: Access is denied.`)
		);
		await expect(failing(5, 'WARNING: slow\nERROR: Access is denied.')).rejects.toThrow(
			new Error(`${query} exited 5: ERROR: Access is denied.`)
		);
	});

	it('names only the exit code when reg wrote no stderr', async () => {
		await expect(failing(5, '')).rejects.toThrow(new Error(`${query} exited 5`));
	});

	it('refuses a product key it cannot find the install dir from', async () => {
		const bare = { key: PRODUCT.key, values: { DisplayName: PRODUCT_NAME } };
		const run = fakeRunner(() => ({ code: 0, stdout: regOutput([bare]), stderr: '' }));
		await expect(findUserInstall(run)).rejects.toThrow(
			new Error(`${PRODUCT.key} names no InstallLocation or quoted UninstallString`)
		);
	});
});

describe('runCli', () => {
	let out: string;
	let lines: { stdout: string[]; stderr: string[] };
	beforeEach(() => {
		out = mkdtempSync(join(tmpdir(), 'packaged-app-cli-'));
		lines = { stdout: [], stderr: [] };
	});
	afterEach(() => rmSync(out, { recursive: true, force: true }));

	const deps = (
		platform: NodeJS.Platform,
		run: Runner = fakeRunner(() => ({ code: 0, stdout: '', stderr: '' }))
	) => ({
		platform,
		run,
		stdout: (line: string) => lines.stdout.push(line),
		stderr: (line: string) => lines.stderr.push(line)
	});

	it('exe prints the darwin executable for PRICE_CHECK_PACKAGED_EXE', async () => {
		mkdirSync(join(out, 'mac-universal', `${PRODUCT_NAME}.app`), { recursive: true });
		expect(await runCli(['exe', out], deps('darwin'))).toBe(0);
		expect(lines.stdout).toEqual([
			join(out, 'mac-universal', `${PRODUCT_NAME}.app`, 'Contents', 'MacOS', PRODUCT_NAME)
		]);
	});

	it('exe prints the AppImage on linux and exits 1 on two', async () => {
		writeFileSync(join(out, 'a.AppImage'), '');
		expect(await runCli(['exe', out], deps('linux'))).toBe(0);
		expect(lines.stdout).toEqual([join(out, 'a.AppImage')]);
		writeFileSync(join(out, 'b.AppImage'), '');
		expect(await runCli(['exe', out], deps('linux'))).toBe(1);
		expect(lines.stderr.join('\n')).toMatch(/exactly one AppImage/);
	});

	it('install runs the located installer and prints the installed exe; exe reads it back', async () => {
		writeFileSync(join(out, 'price-check-0.1.5-win-x64.exe'), '');
		const run = fakeRunner((command) =>
			command.file === 'reg'
				? { code: 0, stdout: regOutput([PRODUCT]), stderr: '' }
				: { code: 0, stdout: '', stderr: '' }
		);
		expect(await runCli(['install', out], deps('win32', run))).toBe(0);
		expect(run.calls[0]).toEqual({
			file: join(out, 'price-check-0.1.5-win-x64.exe'),
			args: ['/S']
		});
		expect(await runCli(['exe', out], deps('win32', run))).toBe(0);
		expect(lines.stdout).toEqual([
			`${INSTALL_DIR}\\${PRODUCT_NAME}.exe`,
			`${INSTALL_DIR}\\${PRODUCT_NAME}.exe`
		]);
	});

	it('exits 1 when the installer fails or nothing is installed', async () => {
		writeFileSync(join(out, 'price-check-0.1.5-win-x64.exe'), '');
		const failing = fakeRunner(() => ({ code: 2, stdout: '', stderr: '' }));
		expect(await runCli(['install', out], deps('win32', failing))).toBe(1);
		expect(await runCli(['exe', out], deps('win32', failing))).toBe(1);
		const absent = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'ERROR: not found' }));
		expect(await runCli(['exe', out], deps('win32', absent))).toBe(1);
		expect(lines.stderr.join('\n')).toMatch(
			/\.exe \/S exited 2[\s\S]*reg query HKCU.* exited 2[\s\S]*not installed for this user/
		);
		expect(lines.stdout).toEqual([]);
	});

	it('refuses install off Windows, unknown commands and stray arguments', async () => {
		mkdirSync(join(out, 'mac-universal', `${PRODUCT_NAME}.app`), { recursive: true });
		expect(await runCli(['install', out], deps('darwin'))).toBe(1);
		expect(await runCli(['run', out], deps('darwin'))).toBe(1);
		expect(await runCli(['exe', out, 'extra'], deps('darwin'))).toBe(1);
		expect(await runCli(['exe'], deps('darwin'))).toBe(1);
		expect(await runCli(['exe', out], deps('freebsd'))).toBe(1);
		expect(lines.stdout).toEqual([]);
		const usage = 'packaged-app: usage: packaged-app.ts exe <outDir> | install <outDir>';
		expect(lines.stderr).toEqual([
			'packaged-app: install is Windows-only',
			usage,
			usage,
			usage,
			'packaged-app: no packaged app for freebsd'
		]);
	});
});

describe('spawnRunner', () => {
	const node = (script: string): Command => ({ file: process.execPath, args: ['-e', script] });

	it('resolves exit 0 with stdout and stderr as text, past a few KB of output', async () => {
		const script = "process.stdout.write('x'.repeat(4096)); process.stderr.write('note')";
		expect(await spawnRunner(node(script))).toEqual({
			code: 0,
			stdout: 'x'.repeat(4096),
			stderr: 'note'
		});
	});

	it("resolves a non-zero exit with the process's own code and stderr", async () => {
		const script = "process.stdout.write('part'); process.stderr.write('bad'); process.exit(3)";
		expect(await spawnRunner(node(script))).toEqual({ code: 3, stdout: 'part', stderr: 'bad' });
	});

	it('falls back to the error message when the process wrote no stderr', async () => {
		const result = await spawnRunner(node('process.exit(4)'));
		expect(result.code).toBe(4);
		expect(result.stderr).toMatch(/^Command failed: /);
	});

	it('resolves -1 with the spawn error when the file cannot be run', async () => {
		const result = await spawnRunner({ file: join(tmpdir(), 'no-such-packaged-app'), args: [] });
		expect(result.code).toBe(-1);
		expect(result.stderr).toMatch(/ENOENT/);
	});
});
