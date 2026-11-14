// The app window (spec c-5/c-7, decisions external_links and window_close).
//
// The window only ever shows the local origin. Any window.open or target=_blank is
// denied, so no second app window exists: an off-origin http(s) URL goes to the
// default browser (where the user's shop session lives, and the address bar shows
// what the page really is), a same-origin one loads in this window, anything else
// is dropped. Only http and https ever reach shell.openExternal: file:, javascript:,
// smb: or ms-msdt: links handed to the OS would open local files or protocol
// handlers. Off-origin navigations and redirects in the window are prevented.
//
// Closing the window destroys it and nothing here ever cancels a close: the app
// stays alive in the tray because the lifecycle keeps running, not because the
// window hides. A cancelled close would also hang Quit behind it.
//
// Runs in the Electron main bundle: Electron types via `import type` only; main.ts
// passes the real BrowserWindow and shell.
import type { BrowserWindowConstructorOptions, WindowOpenHandlerResponse } from 'electron';

export const WINDOW_TITLE = 'Price Check';

/** The slice of a navigation event this module reads. */
export type NavigationEvent = { url: string; preventDefault(): void };

/** The slice of Electron's WebContents this module uses. */
export type MainWebContents = {
	setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResponse): void;
	on(event: 'will-navigate', listener: (event: NavigationEvent) => void): unknown;
	on(event: 'will-redirect', listener: (event: NavigationEvent) => void): unknown;
};

/** The slice of Electron's BrowserWindow this module uses. */
export type MainWindow = {
	webContents: MainWebContents;
	loadURL(url: string): Promise<void>;
	on(event: 'closed', listener: () => void): unknown;
	isDestroyed(): boolean;
	isMinimized(): boolean;
	restore(): void;
	show(): void;
	focus(): void;
};

export type WindowDeps = {
	BrowserWindow: new (options: BrowserWindowConstructorOptions) => MainWindow;
	shell: { openExternal(url: string): Promise<void> };
};

/** What showWindow needs to (re)create the window; `window` is the live one, if any. */
export type WindowState = {
	deps: WindowDeps;
	/** http://127.0.0.1:<port>, the desktop server's origin. */
	origin: string;
	window: MainWindow | null;
};

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

function parseUrl(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

/** True only for a URL on exactly the app's origin (scheme, host and port). */
export function isAppUrl(url: string, origin: string): boolean {
	const parsed = parseUrl(url);
	return parsed !== null && parsed.origin === new URL(origin).origin;
}

/** True only for an http(s) URL: the one kind the default browser may be handed. */
export function isExternalWebUrl(url: string): boolean {
	const parsed = parseUrl(url);
	return parsed !== null && EXTERNAL_PROTOCOLS.has(parsed.protocol);
}

function logFailure(what: string) {
	return (error: unknown): void => {
		console.error(`desktop window: ${what} failed`, error);
	};
}

/** Hands an off-origin http(s) URL to the default browser; drops every other URL. */
function openOutside(deps: WindowDeps, url: string): void {
	if (!isExternalWebUrl(url)) return;
	deps.shell.openExternal(url).catch(logFailure('opening an external link'));
}

export function windowOptions(): BrowserWindowConstructorOptions {
	return {
		width: 1100,
		height: 800,
		minWidth: 480,
		minHeight: 400,
		title: WINDOW_TITLE,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webviewTag: false
		}
	};
}

/** Opens the app window on `origin` with the external-link policy attached. */
export function createMainWindow(deps: WindowDeps, origin: string): MainWindow {
	const window = new deps.BrowserWindow(windowOptions());
	const { webContents } = window;

	webContents.setWindowOpenHandler(({ url }) => {
		if (isAppUrl(url, origin)) {
			window.loadURL(url).catch(logFailure('loading a page'));
		} else {
			openOutside(deps, url);
		}
		return { action: 'deny' };
	});

	webContents.on('will-navigate', (event) => {
		if (isAppUrl(event.url, origin)) return;
		event.preventDefault();
		openOutside(deps, event.url);
	});

	webContents.on('will-redirect', (event) => {
		if (!isAppUrl(event.url, origin)) event.preventDefault();
	});

	window.loadURL(origin).catch(logFailure('loading the app'));
	return window;
}

export function createWindowState(deps: WindowDeps, origin: string): WindowState {
	return { deps, origin, window: null };
}

/**
 * Brings the app window up: recreates it if it was never created or has been
 * closed, restores it if minimised, then shows and focuses it. Never opens a
 * second window while one is alive.
 */
export function showWindow(state: WindowState): MainWindow {
	let window = state.window;
	if (window === null || window.isDestroyed()) {
		const created = createMainWindow(state.deps, state.origin);
		created.on('closed', () => {
			if (state.window === created) state.window = null;
		});
		state.window = created;
		window = created;
	} else if (window.isMinimized()) {
		window.restore();
	}
	window.show();
	window.focus();
	return window;
}
