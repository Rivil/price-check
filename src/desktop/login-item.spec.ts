import type { App } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTempDir } from '#lib/server/testing/temp-dir.ts';
import {
	AUTOSTART_FILE_NAME,
	LOGIN_LAUNCH_ARG,
	MARKER_FILE_NAME,
	autostartDir,
	autostartEntry,
	createLoginItem,
	quoteExecArg,
	type LoginItemApp,
	type LoginItemDeps
} from './login-item.ts';

// Compile-time only (pnpm check): the real Electron app must satisfy the slice
// main.ts passes in.
const realAppFits = (app: App): LoginItemApp => app;
void realAppFits;

type SetCall = { openAtLogin: boolean; args?: string[] };

/**
 * Electron's login-item API as the OS behaves. On Windows the registry entry is
 * keyed by path + args: get without the registered args reports false, and set(false)
 * with other args leaves the entry in place.
 */
class FakeApp implements LoginItemApp {
	setCalls: SetCall[] = [];
	registered = false;
	registeredArgs: string[] = [];
	wasOpenedAtLogin = false;
	throwOnSet = false;
	throwOnGet = false;

	constructor(
		readonly isPackaged: boolean,
		private readonly platform: NodeJS.Platform
	) {}

	private argsMatch(args: string[] | undefined): boolean {
		if (this.platform !== 'win32') return true;
		return JSON.stringify(args ?? []) === JSON.stringify(this.registeredArgs);
	}

	setLoginItemSettings(settings: SetCall): void {
		this.setCalls.push(settings);
		if (this.throwOnSet) throw new Error('login item registration failed');
		if (settings.openAtLogin) {
			this.registered = true;
			this.registeredArgs = settings.args ?? [];
		} else if (this.argsMatch(settings.args)) {
			this.registered = false;
		}
	}

	getLoginItemSettings(options?: { args?: string[] }) {
		if (this.throwOnGet) throw new Error('SMAppService unavailable');
		return {
			openAtLogin: this.registered && this.argsMatch(options?.args),
			wasOpenedAtLogin: this.wasOpenedAtLogin
		};
	}
}

let root: string;
let home: string;
let userData: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'apc-login-'));
	home = join(root, 'home');
	userData = join(root, 'userData');
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	removeTempDir(root);
});

const EXEC_PATH = '/opt/Price Check/price-check';

function setup(
	platform: NodeJS.Platform,
	opts: { packaged?: boolean; argv?: string[]; env?: NodeJS.ProcessEnv; execPath?: string } = {}
) {
	const app = new FakeApp(opts.packaged ?? true, platform);
	const deps: LoginItemDeps = {
		app,
		platform,
		argv: opts.argv ?? [EXEC_PATH],
		env: opts.env ?? {},
		execPath: opts.execPath ?? EXEC_PATH,
		homeDir: home,
		userData
	};
	return { app, item: createLoginItem(deps), deps };
}

const markerFile = () => join(userData, MARKER_FILE_NAME);
const linuxEntry = () => join(home, '.config', 'autostart', AUTOSTART_FILE_NAME);

/** The Exec line's arguments as a Desktop Entry parser reads them back. */
function parseExec(entry: string): string[] {
	const line = entry.split('\n').find((l) => l.startsWith('Exec='));
	if (!line) throw new Error('no Exec line');
	// 1. String-value escapes (applied before quoting, per the spec).
	const value = line
		.slice('Exec='.length)
		.replace(/\\([\\snrt])/g, (_, c: string) =>
			c === '\\' ? '\\' : c === 's' ? ' ' : c === 'n' ? '\n' : c === 't' ? '\t' : '\r'
		);
	// 2. Quoting, field-code escapes outside it.
	const args: string[] = [];
	let i = 0;
	while (i < value.length) {
		if (value[i] === ' ') {
			i++;
			continue;
		}
		let arg = '';
		if (value[i] === '"') {
			i++;
			while (value[i] !== '"') {
				if (i >= value.length) throw new Error('unterminated quote');
				if (value[i] === '\\') {
					const next = value[i + 1];
					if (!'"`$\\'.includes(next)) throw new Error(`bad escape \\${next}`);
					arg += next;
					i += 2;
				} else if (value[i] === '%') {
					if (value[i + 1] !== '%') throw new Error('field code in a quoted arg');
					arg += '%';
					i += 2;
				} else {
					arg += value[i++];
				}
			}
			i++;
		} else {
			while (i < value.length && value[i] !== ' ') {
				if (/["`$\\ ]/.test(value[i])) throw new Error(`reserved char unquoted: ${value[i]}`);
				arg += value[i++];
			}
		}
		args.push(arg);
	}
	return args;
}

describe('ensureRegisteredOnce, packaged first launch', () => {
	it('darwin: registers once with openAtLogin true and writes the marker', () => {
		const { app, item } = setup('darwin');

		expect(item.ensureRegisteredOnce()).toEqual({ status: 'registered' });

		expect(app.setCalls).toEqual([{ openAtLogin: true }]);
		expect(existsSync(markerFile())).toBe(true);
	});

	it('win32: registers once with args [--login-launch] and writes the marker', () => {
		const { app, item } = setup('win32');

		expect(item.ensureRegisteredOnce()).toEqual({ status: 'registered' });

		expect(app.setCalls).toEqual([{ openAtLogin: true, args: [LOGIN_LAUNCH_ARG] }]);
		expect(existsSync(markerFile())).toBe(true);
		expect(item.isEnabled()).toBe(true);
	});

	it('linux: writes the autostart entry and the marker, never calls the Electron API', () => {
		const { app, item } = setup('linux');

		expect(item.ensureRegisteredOnce()).toEqual({ status: 'registered' });

		expect(app.setCalls).toEqual([]);
		expect(parseExec(readFileSync(linuxEntry(), 'utf8'))).toEqual([EXEC_PATH, LOGIN_LAUNCH_ARG]);
		expect(existsSync(markerFile())).toBe(true);
	});

	it('linux: honours an absolute XDG_CONFIG_HOME and ignores a relative one', () => {
		const xdg = join(root, 'xdg');
		const { item } = setup('linux', { env: { XDG_CONFIG_HOME: xdg } });

		item.ensureRegisteredOnce();

		expect(existsSync(join(xdg, 'autostart', AUTOSTART_FILE_NAME))).toBe(true);
		expect(autostartDir({ XDG_CONFIG_HOME: 'relative/dir' }, home)).toBe(
			join(home, '.config', 'autostart')
		);
	});
});

describe('ensureRegisteredOnce never re-asserts over a user opt-out', () => {
	it.each(['darwin', 'win32'] as const)(
		'%s: marker present and OS reporting off: no set call',
		(platform) => {
			const first = setup(platform);
			first.item.ensureRegisteredOnce();
			first.item.setEnabled(false); // the user's opt-out, as the OS would record it

			const { app, item } = setup(platform);
			expect(item.isEnabled()).toBe(false);

			expect(item.ensureRegisteredOnce()).toEqual({ status: 'already-registered' });

			expect(app.setCalls).toEqual([]);
		}
	);

	it('linux: marker present and the entry gone: no file written', () => {
		setup('linux').item.ensureRegisteredOnce();
		expect(existsSync(linuxEntry())).toBe(true);
		rmSync(linuxEntry()); // the user's opt-out

		const { item } = setup('linux');
		expect(item.ensureRegisteredOnce()).toEqual({ status: 'already-registered' });

		expect(existsSync(linuxEntry())).toBe(false);
	});
});

describe('unpackaged runs never register', () => {
	it.each(['darwin', 'win32', 'linux'] as const)(
		'%s: ensureRegisteredOnce and setEnabled(true) touch nothing',
		(platform) => {
			const { app, item } = setup(platform, { packaged: false });

			expect(item.ensureRegisteredOnce()).toEqual({ status: 'unpackaged' });
			item.setEnabled(true);

			expect(app.setCalls).toEqual([]);
			expect(existsSync(markerFile())).toBe(false);
			expect(existsSync(linuxEntry())).toBe(false);
			expect(existsSync(join(home, '.config'))).toBe(false);
			expect(item.isEnabled()).toBe(false);
		}
	);
});

describe('linux autostart entry', () => {
	it('quotes a path with a space so it stays one argument', () => {
		const entry = autostartEntry({}, '/opt/Price Check/price-check');

		expect(entry).toContain('Exec="/opt/Price Check/price-check" --login-launch\n');
		expect(parseExec(entry)).toEqual(['/opt/Price Check/price-check', LOGIN_LAUNCH_ARG]);
	});

	it('escapes a double quote per the spec (quote escape, then string escape)', () => {
		const path = '/opt/a"b/price-check';
		const entry = autostartEntry({}, path);

		expect(entry).toContain('Exec="/opt/a\\\\"b/price-check" --login-launch\n');
		expect(parseExec(entry)).toEqual([path, LOGIN_LAUNCH_ARG]);
	});

	it.each([
		['backslash', '/opt/a\\b/price-check'],
		['dollar and backtick', '/opt/$HOME/`x`/price-check'],
		['percent', '/opt/100%/price-check'],
		['tab', '/opt/a\tb/price-check']
	])('round-trips a path with a %s', (_, path) => {
		expect(parseExec(autostartEntry({}, path))).toEqual([path, LOGIN_LAUNCH_ARG]);
	});

	it('uses $APPIMAGE, not the per-run mount path, when set', () => {
		const appImage = '/home/u/Apps/Price Check.AppImage';
		const { item } = setup('linux', {
			env: { APPIMAGE: appImage },
			execPath: '/tmp/.mount_PriceCabc123/price-check'
		});

		item.ensureRegisteredOnce();

		const entry = readFileSync(linuxEntry(), 'utf8');
		expect(parseExec(entry)).toEqual([appImage, LOGIN_LAUNCH_ARG]);
		expect(entry).not.toContain('.mount_');
	});

	it('quoteExecArg always quotes', () => {
		expect(quoteExecArg('/usr/bin/x')).toBe('"/usr/bin/x"');
	});
});

describe('isLoginLaunch', () => {
	it.each(['win32', 'linux', 'darwin'] as const)('%s: true with --login-launch in argv', (p) => {
		expect(setup(p, { argv: [EXEC_PATH, LOGIN_LAUNCH_ARG] }).item.isLoginLaunch()).toBe(true);
	});

	it.each(['win32', 'linux', 'darwin'] as const)('%s: false for a plain launch', (p) => {
		expect(setup(p).item.isLoginLaunch()).toBe(false);
	});

	it('darwin: true when the OS reports wasOpenedAtLogin', () => {
		const { app, item } = setup('darwin');
		app.wasOpenedAtLogin = true;

		expect(item.isLoginLaunch()).toBe(true);
	});

	it('darwin: an unpackaged run with --login-launch is a login launch (e2e seam)', () => {
		const { item } = setup('darwin', { packaged: false, argv: ['electron', LOGIN_LAUNCH_ARG] });

		expect(item.isLoginLaunch()).toBe(true);
	});

	it('darwin: a throwing getLoginItemSettings means a normal launch, not a crash', () => {
		const { app, item } = setup('darwin');
		app.throwOnGet = true;

		expect(item.isLoginLaunch()).toBe(false);
	});

	it('win32 and linux ignore wasOpenedAtLogin', () => {
		for (const p of ['win32', 'linux'] as const) {
			const { app, item } = setup(p);
			app.wasOpenedAtLogin = true;
			expect(item.isLoginLaunch()).toBe(false);
		}
	});
});

describe('isEnabled / setEnabled (the tray toggle)', () => {
	it.each(['darwin', 'win32'] as const)('%s: isEnabled reads the OS, not the marker', (p) => {
		const { app, item } = setup(p);
		mkdirSync(userData, { recursive: true });
		writeFileSync(markerFile(), ''); // marker present, OS off
		expect(item.isEnabled()).toBe(false);

		app.registered = true;
		app.registeredArgs = p === 'win32' ? [LOGIN_LAUNCH_ARG] : [];
		rmSync(markerFile()); // OS on, marker gone
		expect(item.isEnabled()).toBe(true);
	});

	it('linux: isEnabled reads the entry, not the marker', () => {
		const { item } = setup('linux');
		mkdirSync(userData, { recursive: true });
		writeFileSync(markerFile(), '');
		expect(item.isEnabled()).toBe(false);

		item.setEnabled(true);
		rmSync(markerFile());
		expect(item.isEnabled()).toBe(true);
	});

	it('linux: an entry the desktop disabled in place reads as off', () => {
		const { item } = setup('linux');
		item.setEnabled(true);
		writeFileSync(linuxEntry(), readFileSync(linuxEntry(), 'utf8') + 'Hidden=true\n');

		expect(item.isEnabled()).toBe(false);
	});

	it('win32: setEnabled(false) passes the registered args, so the entry is removed', () => {
		const { app, item } = setup('win32');
		item.ensureRegisteredOnce();

		item.setEnabled(false);

		expect(app.setCalls.at(-1)).toEqual({ openAtLogin: false, args: [LOGIN_LAUNCH_ARG] });
		expect(app.registered).toBe(false);
		expect(item.isEnabled()).toBe(false);
	});

	it.each(['darwin', 'win32', 'linux'] as const)('%s: off then on restores it', (p) => {
		const { item } = setup(p);
		item.ensureRegisteredOnce();

		item.setEnabled(false);
		expect(item.isEnabled()).toBe(false);
		if (p === 'linux') expect(existsSync(linuxEntry())).toBe(false);

		item.setEnabled(true);
		expect(item.isEnabled()).toBe(true);
		if (p === 'linux') {
			expect(parseExec(readFileSync(linuxEntry(), 'utf8'))).toEqual([EXEC_PATH, LOGIN_LAUNCH_ARG]);
		}
	});
});

describe('registration failures', () => {
	it.each(['darwin', 'win32'] as const)(
		'%s: a throwing setLoginItemSettings is reported, not thrown, and no marker',
		(p) => {
			const { app, item } = setup(p);
			app.throwOnSet = true;

			const outcome = item.ensureRegisteredOnce();

			expect(outcome.status).toBe('failed');
			expect(existsSync(markerFile())).toBe(false);

			app.throwOnSet = false; // the next launch retries
			const next = setup(p);
			expect(next.item.ensureRegisteredOnce()).toEqual({ status: 'registered' });
		}
	);

	it('linux: an unwritable autostart dir is reported, not thrown, and no marker', () => {
		const xdg = join(root, 'xdg-is-a-file');
		writeFileSync(xdg, ''); // mkdir <file>/autostart fails with ENOTDIR
		const { item } = setup('linux', { env: { XDG_CONFIG_HOME: xdg } });

		const outcome = item.ensureRegisteredOnce();

		expect(outcome.status).toBe('failed');
		expect(existsSync(markerFile())).toBe(false);
	});
});
