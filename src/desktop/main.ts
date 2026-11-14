// The Electron main entry (spec c-1, c-7): the one module that imports electron's
// values (boundary.spec pins that). It wires the real Electron objects into the
// lifecycle and the window, tray, login-item, key and server modules; every
// decision lives in those modules, not here.
//
// Bundled by scripts/build-desktop.ts to dist-desktop/main.js (package.json main),
// so the app root is one level above this file at runtime, and the SvelteKit server
// is adapter-node's build/handler.js under it. The handler is imported at runtime by
// loadAdapterHandler, only after the desktop env and cwd are in place: a static
// import would run the server's module-level env reads against the user's shell.
//
// The desktop notifier is built here, before startup, and published on the notify
// bridge by loadAdapterHandler ahead of that import. Its clicks route to the window
// through runDesktop. The e2e seam reads PRICE_CHECK_E2E_NOTIFY from the user's env
// now, before loadAdapterHandler swaps process.env for the server's.
//
// The server runs in serverCwdFor(APP_ROOT): the repo root unpackaged, the
// app.asar.unpacked sibling packaged, where drizzle/ ships (chdir into app.asar would
// throw ENOTDIR). The handler and the tray icons are still read from APP_ROOT.
//
// Updates (05-release c-5, c-6; decision update_flow) run only when app.isPackaged:
// the updater is built with the same notifier, its onReady shows the tray's 'Restart
// to update', and once startup has finished it starts checking and is published for
// the packaged e2e suite. An unpackaged run (pnpm dev, the e2e suite) builds no
// updater and publishes no handle. The feed comes only from app-update.yml.
// PRICE_CHECK_PREDECESSOR_PID (set by the version an update replaced) is read and
// removed now, before loadAdapterHandler swaps process.env for the server's.
// runDesktop gets process.platform and Electron's native autoUpdater (Squirrel.Mac):
// on macOS, quit waits for it to stage a handed-over update before exiting.
//
// '[desktop] listening on http://127.0.0.1:<port>' is printed once the server is up:
// the desktop e2e harness reads it to find the per-launch port.
import {
	app,
	autoUpdater,
	BrowserWindow,
	dialog,
	Menu,
	Notification,
	powerMonitor,
	shell,
	Tray
} from 'electron';
import electronUpdater from 'electron-updater';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntime } from '#lib/server/runtime-bridge.ts';
import { loadOrCreateAlertsKey } from './alerts-key.ts';
import { appUserModelIdFor } from './app-id.ts';
import { desktopPaths, resolveUserDataDir, serverCwdFor } from './app-paths.ts';
import { PREDECESSOR_PID_ENV, runDesktop, STARTUP_ERROR_TITLE } from './lifecycle.ts';
import { createLoginItem } from './login-item.ts';
import { createNotifier } from './notifier.ts';
import { notificationClassFor } from './notify-seam.ts';
import { serverEnv } from './server-env.ts';
import { loadAdapterHandler, startDesktopServer } from './server.ts';
import { createTray, type TrayHandle } from './tray.ts';
import { createUpdater, publishUpdaterHandle, type UpdaterController } from './updater.ts';
import { createWindowState, showWindow, type WindowState } from './window.ts';

/** dist-desktop/main.js -> the repo (or packaged app) root. */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Where the server runs: drizzle/ is resolved against it (app.asar.unpacked packaged). */
const SERVER_CWD = serverCwdFor(APP_ROOT);
const HANDLER_URL = new URL('../build/handler.js', import.meta.url).href;
const ICON_DIR = join(APP_ROOT, 'src', 'desktop', 'assets');
/** How long a notification may go unreported before it counts as delivered. */
const NOTIFY_SETTLE_MS = 4_000;

const paths = desktopPaths(
	resolveUserDataDir({
		appData: app.getPath('appData'),
		isPackaged: app.isPackaged,
		env: process.env
	})
);

const loginItem = createLoginItem({
	app,
	platform: process.platform,
	argv: process.argv,
	env: process.env,
	execPath: process.execPath,
	homeDir: homedir(),
	userData: paths.userData
});

const notifications = createNotifier({
	Notification: notificationClassFor({
		isPackaged: app.isPackaged,
		env: process.env,
		Notification
	}),
	settleMs: NOTIFY_SETTLE_MS
});

let windowState: WindowState | null = null;
let tray: TrayHandle<Menu> | null = null;
/** The tray's 'Restart to update' action, as runDesktop handed it to createTray. */
let restartToUpdate: (() => void) | null = null;

/** The process an update replaced, read before the server's env replaces process.env. */
const predecessorPid = parsePid(process.env[PREDECESSOR_PID_ENV]);
delete process.env[PREDECESSOR_PID_ENV];

function parsePid(raw: string | undefined): number | null {
	if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return null;
	const pid = Number(raw);
	return Number.isSafeInteger(pid) && pid !== process.pid ? pid : null;
}

/** Signal 0 only probes: ESRCH means gone; EPERM means alive but not ours. */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Packaged only: reading electronUpdater.autoUpdater builds the platform updater. */
const updater: UpdaterController | null = app.isPackaged
	? createUpdater({
			autoUpdater: electronUpdater.autoUpdater,
			isPackaged: app.isPackaged,
			appVersion: app.getVersion(),
			notifier: notifications.notifier,
			onReady: () => tray?.setUpdateReady(true),
			timers: { setInterval, clearInterval },
			log: {
				info: (message) => console.log(`[updater] ${message}`),
				error: (message, error) => console.error(`[updater] ${message}`, error ?? '')
			}
		})
	: null;

/** macOS: the app menu carries Quit (Cmd+Q), and Edit keeps copy and paste working in forms. */
function installAppMenu(): void {
	if (process.platform !== 'darwin') return;
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: app.name,
				submenu: [
					{ role: 'about' },
					{ type: 'separator' },
					{ role: 'hide' },
					{ role: 'hideOthers' },
					{ role: 'unhide' },
					{ type: 'separator' },
					{ role: 'quit' }
				]
			},
			{ role: 'editMenu' },
			{ role: 'windowMenu' }
		])
	);
}

runDesktop({
	app,
	powerMonitor,
	dialog,
	paths,
	loadKey: loadOrCreateAlertsKey,
	async startServer(key) {
		const env = serverEnv(process.env, { dbFile: paths.dbFile, key });
		const handler = await loadAdapterHandler(env, HANDLER_URL, SERVER_CWD, {
			notifier: notifications.notifier
		});
		const server = await startDesktopServer({ handler });
		console.log(`[desktop] listening on ${server.origin}`);
		return server;
	},
	readRuntime,
	createTray: (actions) => {
		restartToUpdate = actions.restartToUpdate;
		tray = createTray(
			{ Tray, Menu, platform: process.platform },
			{ ...actions, loginItem, iconDir: ICON_DIR }
		);
		return tray;
	},
	showWindow(origin, path) {
		windowState ??= createWindowState({ BrowserWindow, shell }, origin);
		showWindow(windowState, path);
	},
	appUserModelId: appUserModelIdFor({
		platform: process.platform,
		isPackaged: app.isPackaged,
		execPath: process.execPath
	}),
	notifications,
	loginItem,
	platform: process.platform,
	...(updater ? { updates: updater } : {}),
	nativeUpdater: autoUpdater,
	predecessorPid,
	isProcessAlive
}).then(
	(outcome) => {
		if (outcome !== 'started') return;
		installAppMenu();
		if (app.isPackaged && updater && restartToUpdate) {
			updater.start();
			publishUpdaterHandle({
				status: () => updater.status(),
				restart: restartToUpdate,
				checkNow: () => updater.checkNow()
			});
		}
	},
	(error: unknown) => {
		// A step after the server started threw (the tray, the window): exit rather
		// than linger without a way back, holding the lock against every relaunch.
		console.error('desktop startup failed', error);
		try {
			dialog.showErrorBox(
				STARTUP_ERROR_TITLE,
				error instanceof Error ? error.message : String(error)
			);
		} catch (boxError) {
			console.error('desktop startup: showing the error failed', boxError);
		}
		app.exit(1);
	}
);
