// Start at login (spec c-6, decision login_start): on by default, registered once on
// a packaged first launch and never re-asserted, so a user's opt-out in the OS
// settings sticks. A marker file in userData records that the one registration
// happened; it is written only after the OS call succeeded, so a failed attempt is
// retried on the next launch. Unpackaged dev and e2e runs never register anything,
// not even from the tray toggle: they would register the bare electron binary.
//
// macOS and Windows use Electron's login-item API. Linux (which that API does not
// cover) gets an XDG autostart entry. isEnabled always reads the live OS state, never
// the marker.
//
// A login launch is tray-only. It is detected by '--login-launch' in argv on every
// OS (Windows and Linux register with it; on macOS the API ignores args, so there the
// flag is only the e2e seam) and, on macOS, by getLoginItemSettings().wasOpenedAtLogin.
// Electron 45 derives that from the launch Apple event (kAEOpenApplication carrying
// keyAELaunchedAsLogInItem), read in applicationDidFinishLaunching; whether macOS 13+
// still sends that for an SMAppService main-app login item is unconfirmed, so a miss
// there shows the window at login rather than breaking anything.
//
// Runs in the Electron main bundle: Electron is injected structurally, no import.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const LOGIN_LAUNCH_ARG = '--login-launch';
export const MARKER_FILE_NAME = 'login-item-registered';
export const AUTOSTART_FILE_NAME = 'price-check.desktop';
const APP_NAME = 'Price Check';

/** The slice of Electron's app this module uses. */
export type LoginItemApp = {
	readonly isPackaged: boolean;
	setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
	getLoginItemSettings(options?: { args?: string[] }): {
		openAtLogin: boolean;
		wasOpenedAtLogin: boolean;
	};
};

export type LoginItemDeps = {
	app: LoginItemApp;
	platform: NodeJS.Platform;
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
	/** process.execPath: the packaged binary (on an AppImage, its per-run mount path). */
	execPath: string;
	/** os.homedir(), for the ~/.config fallback. */
	homeDir: string;
	userData: string;
};

export type RegisterOutcome =
	| { status: 'registered' }
	| { status: 'already-registered' }
	| { status: 'unpackaged' }
	| { status: 'failed'; error: unknown };

export type LoginItem = {
	/** Registers on a packaged first launch; never throws, never re-asserts. */
	ensureRegisteredOnce(): RegisterOutcome;
	/** True when this process was started by the OS at login. */
	isLoginLaunch(): boolean;
	/** The OS's current start-at-login state for this app. */
	isEnabled(): boolean;
	/** Adds or removes the OS registration; throws if the OS call fails. */
	setEnabled(enabled: boolean): void;
};

/** $XDG_CONFIG_HOME/autostart (a relative value is ignored, per the XDG spec), else ~/.config/autostart. */
export function autostartDir(env: NodeJS.ProcessEnv, homeDir: string): string {
	const configHome = env.XDG_CONFIG_HOME;
	const base = configHome && isAbsolute(configHome) ? configHome : join(homeDir, '.config');
	return join(base, 'autostart');
}

/**
 * One Exec argument, quoted per the Desktop Entry spec: inside double quotes, `"`,
 * `` ` ``, `$` and `\` are backslash-escaped; then the value-level string escapes
 * apply (so each backslash is doubled again), and `%` becomes `%%` (field codes).
 */
export function quoteExecArg(arg: string): string {
	const quoted = `"${arg.replace(/["`$\\]/g, '\\$&')}"`;
	return quoted
		.replace(/\\/g, '\\\\')
		.replace(/\n/g, '\\n')
		.replace(/\t/g, '\\t')
		.replace(/\r/g, '\\r')
		.replace(/%/g, '%%');
}

/**
 * The autostart entry. On an AppImage the binary runs from a per-run /tmp/.mount_*
 * dir, so the entry points at $APPIMAGE, the file the user actually has.
 */
export function autostartEntry(env: NodeJS.ProcessEnv, execPath: string): string {
	const appImage = env.APPIMAGE?.trim();
	const target = appImage ? appImage : execPath;
	return [
		'[Desktop Entry]',
		'Type=Application',
		'Version=1.0',
		`Name=${APP_NAME}`,
		'Comment=Checks watched prices in the background',
		`Exec=${quoteExecArg(target)} ${LOGIN_LAUNCH_ARG}`,
		'Terminal=false',
		'X-GNOME-Autostart-enabled=true',
		''
	].join('\n');
}

/** An entry the desktop disabled in place instead of deleting it. */
function entryDisabled(contents: string): boolean {
	return /^\s*(Hidden\s*=\s*true|X-GNOME-Autostart-enabled\s*=\s*false)\s*$/m.test(contents);
}

export function createLoginItem(deps: LoginItemDeps): LoginItem {
	const { app, platform, argv, env, execPath, homeDir, userData } = deps;
	const markerFile = join(userData, MARKER_FILE_NAME);
	const autostartFile = join(autostartDir(env, homeDir), AUTOSTART_FILE_NAME);
	const usesElectronApi = platform === 'darwin' || platform === 'win32';
	// Windows compares the registered args too: without them, get reports false and
	// set(false) leaves the registry entry in place.
	const loginArgs = platform === 'win32' ? { args: [LOGIN_LAUNCH_ARG] } : {};

	function osEnabled(): boolean {
		if (usesElectronApi) return app.getLoginItemSettings(loginArgs).openAtLogin;
		if (!existsSync(autostartFile)) return false;
		return !entryDisabled(readFileSync(autostartFile, 'utf8'));
	}

	function osSet(enabled: boolean): void {
		if (usesElectronApi) {
			app.setLoginItemSettings({ openAtLogin: enabled, ...loginArgs });
			return;
		}
		if (enabled) {
			mkdirSync(autostartDir(env, homeDir), { recursive: true });
			writeFileSync(autostartFile, autostartEntry(env, execPath), 'utf8');
		} else {
			rmSync(autostartFile, { force: true });
		}
	}

	return {
		ensureRegisteredOnce() {
			if (!app.isPackaged) return { status: 'unpackaged' };
			if (existsSync(markerFile)) return { status: 'already-registered' };
			try {
				osSet(true);
				mkdirSync(userData, { recursive: true });
				writeFileSync(markerFile, `${new Date().toISOString()}\n`, 'utf8');
				return { status: 'registered' };
			} catch (error) {
				return { status: 'failed', error };
			}
		},

		isLoginLaunch() {
			if (argv.includes(LOGIN_LAUNCH_ARG)) return true;
			// An unpackaged run is never registered, so only the flag can mark it.
			if (platform !== 'darwin' || !app.isPackaged) return false;
			try {
				return app.getLoginItemSettings().wasOpenedAtLogin === true;
			} catch {
				return false;
			}
		},

		isEnabled() {
			if (!app.isPackaged) return false;
			return osEnabled();
		},

		setEnabled(enabled) {
			if (!app.isPackaged) return;
			osSet(enabled);
		}
	};
}
