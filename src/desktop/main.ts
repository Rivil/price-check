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
// '[desktop] listening on http://127.0.0.1:<port>' is printed once the server is up:
// the desktop e2e harness reads it to find the per-launch port.
import { app, BrowserWindow, dialog, Menu, powerMonitor, shell, Tray } from 'electron';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntime } from '#lib/server/runtime-bridge.ts';
import { loadOrCreateAlertsKey } from './alerts-key.ts';
import { desktopPaths, resolveUserDataDir } from './app-paths.ts';
import { runDesktop, STARTUP_ERROR_TITLE } from './lifecycle.ts';
import { createLoginItem } from './login-item.ts';
import { serverEnv } from './server-env.ts';
import { loadAdapterHandler, startDesktopServer } from './server.ts';
import { createTray } from './tray.ts';
import { createWindowState, showWindow, type WindowState } from './window.ts';

/** dist-desktop/main.js -> the repo (or packaged app) root. */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HANDLER_URL = new URL('../build/handler.js', import.meta.url).href;
const ICON_DIR = join(APP_ROOT, 'src', 'desktop', 'assets');

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

let windowState: WindowState | null = null;

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
		const handler = await loadAdapterHandler(env, HANDLER_URL, APP_ROOT);
		const server = await startDesktopServer({ handler });
		console.log(`[desktop] listening on ${server.origin}`);
		return server;
	},
	readRuntime,
	createTray: (actions) =>
		createTray(
			{ Tray, Menu, platform: process.platform },
			{ ...actions, loginItem, iconDir: ICON_DIR }
		),
	showWindow(origin) {
		windowState ??= createWindowState({ BrowserWindow, shell }, origin);
		showWindow(windowState);
	},
	loginItem
}).then(
	(outcome) => {
		if (outcome === 'started') installAppMenu();
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
