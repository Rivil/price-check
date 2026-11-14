import type { BrowserWindow, BrowserWindowConstructorOptions, shell } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createMainWindow,
	createWindowState,
	isAppUrl,
	showWindow,
	type MainWindow,
	type NavigationEvent,
	type WindowDeps
} from './window.ts';

// Compile-time only (pnpm check): the real Electron BrowserWindow and shell must
// satisfy the structural deps main.ts passes in.
type RealDeps = { BrowserWindow: typeof BrowserWindow; shell: typeof shell };
const realDepsFit = (deps: RealDeps): WindowDeps => deps;
void realDepsFit;

const PORT = 41234;
const ORIGIN = `http://127.0.0.1:${PORT}`;

type OpenHandler = (details: { url: string }) => { action: string };
type Listener = (...args: unknown[]) => void;
type NavigationListener = (event: NavigationEvent) => void;

class FakeWindow implements MainWindow {
	static instances: FakeWindow[] = [];

	readonly options: BrowserWindowConstructorOptions;
	readonly loaded: string[] = [];
	readonly listeners = new Map<string, Listener[]>();
	readonly webListeners = new Map<string, NavigationListener[]>();
	openHandler: OpenHandler | null = null;
	destroyed = false;
	minimized = false;
	restore = vi.fn(() => {
		this.minimized = false;
	});
	show = vi.fn();
	focus = vi.fn();

	readonly webContents = {
		setWindowOpenHandler: (handler: OpenHandler) => {
			this.openHandler = handler;
		},
		on: (event: string, listener: NavigationListener) => {
			this.webListeners.set(event, [...(this.webListeners.get(event) ?? []), listener]);
		}
	};

	constructor(options: BrowserWindowConstructorOptions) {
		this.options = options;
		FakeWindow.instances.push(this);
	}

	loadURL(url: string): Promise<void> {
		this.loaded.push(url);
		return Promise.resolve();
	}

	on(event: string, listener: Listener): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	isMinimized(): boolean {
		return this.minimized;
	}

	/** What Electron does on close: 'close' (cancellable), then destroy and 'closed'. */
	close(): { prevented: boolean } {
		let prevented = false;
		const event = {
			preventDefault: () => {
				prevented = true;
			}
		};
		for (const listener of this.listeners.get('close') ?? []) listener(event);
		if (!prevented) {
			this.destroyed = true;
			for (const listener of this.listeners.get('closed') ?? []) listener();
		}
		return { prevented };
	}

	open(url: string): { action: string } {
		if (!this.openHandler) throw new Error('no window open handler set');
		return this.openHandler({ url });
	}

	navigate(event: 'will-navigate' | 'will-redirect', url: string): { prevented: boolean } {
		let prevented = false;
		const navigation: NavigationEvent = {
			url,
			preventDefault: () => {
				prevented = true;
			}
		};
		for (const listener of this.webListeners.get(event) ?? []) listener(navigation);
		return { prevented };
	}
}

function makeDeps() {
	const openExternal = vi.fn((url: string) => {
		void url;
		return Promise.resolve();
	});
	const deps: WindowDeps = { BrowserWindow: FakeWindow, shell: { openExternal } };
	return { deps, openExternal };
}

function openWindow() {
	const { deps, openExternal } = makeDeps();
	const window = createMainWindow(deps, ORIGIN) as FakeWindow;
	return { window, openExternal };
}

afterEach(() => {
	FakeWindow.instances = [];
});

describe('createMainWindow', () => {
	it('locks down webPreferences: isolated, sandboxed, no node, no preload', () => {
		const { window } = openWindow();
		const prefs = window.options.webPreferences;

		expect(prefs?.contextIsolation).toBe(true);
		expect(prefs?.sandbox).toBe(true);
		expect(prefs?.nodeIntegration).toBe(false);
		expect(prefs).not.toHaveProperty('preload');
	});

	it('loads the app origin', () => {
		const { window } = openWindow();

		expect(window.loaded).toEqual([ORIGIN]);
	});

	it.each(['https://www.amazon.co.uk/dp/B0X', 'https://ntfy.sh/t'])(
		'denies window.open(%s) and opens it in the default browser once',
		(url) => {
			const { window, openExternal } = openWindow();

			expect(window.open(url)).toEqual({ action: 'deny' });
			expect(openExternal).toHaveBeenCalledTimes(1);
			expect(openExternal).toHaveBeenCalledWith(url);
			expect(FakeWindow.instances).toHaveLength(1);
		}
	);

	it('denies a same-origin window.open and loads it in this window instead', () => {
		const { window, openExternal } = openWindow();

		expect(window.open(`${ORIGIN}/watches/1`)).toEqual({ action: 'deny' });
		expect(window.loaded).toEqual([ORIGIN, `${ORIGIN}/watches/1`]);
		expect(openExternal).not.toHaveBeenCalled();
		expect(FakeWindow.instances).toHaveLength(1);
	});

	describe.each([
		'file:///etc/passwd',
		'javascript:alert(1)',
		'smb://h/s',
		'ms-msdt:x',
		'not a url'
	])('the non-web URL %s', (url) => {
		it('never reaches shell.openExternal from window.open', () => {
			const { window, openExternal } = openWindow();

			expect(window.open(url)).toEqual({ action: 'deny' });
			expect(openExternal).not.toHaveBeenCalled();
			expect(window.loaded).toEqual([ORIGIN]);
		});

		it('never reaches shell.openExternal from a navigation, which is prevented', () => {
			const { window, openExternal } = openWindow();

			expect(window.navigate('will-navigate', url).prevented).toBe(true);
			expect(openExternal).not.toHaveBeenCalled();
		});
	});

	it.each(['https://evil.example/', `http://127.0.0.1:${PORT + 1}/`, `https://127.0.0.1:${PORT}/`])(
		'prevents an off-origin will-navigate to %s',
		(url) => {
			const { window } = openWindow();

			expect(window.navigate('will-navigate', url).prevented).toBe(true);
		}
	);

	it('hands an off-origin http(s) link navigation to the default browser', () => {
		const { window, openExternal } = openWindow();

		window.navigate('will-navigate', 'https://www.amazon.co.uk/dp/B0X');

		expect(openExternal).toHaveBeenCalledTimes(1);
		expect(openExternal).toHaveBeenCalledWith('https://www.amazon.co.uk/dp/B0X');
	});

	it('lets a same-origin navigation through', () => {
		const { window, openExternal } = openWindow();

		expect(window.navigate('will-navigate', `${ORIGIN}/watches/1`).prevented).toBe(false);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('prevents an off-origin redirect and lets a same-origin one through', () => {
		const { window, openExternal } = openWindow();

		expect(window.navigate('will-redirect', 'https://evil.example/').prevented).toBe(true);
		expect(window.navigate('will-redirect', `${ORIGIN}/watches/1`).prevented).toBe(false);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('never cancels close: the window is destroyed', () => {
		const { window } = openWindow();

		expect(window.close().prevented).toBe(false);
		expect(window.isDestroyed()).toBe(true);
	});
});

describe('isAppUrl', () => {
	it('matches only the exact scheme, host and port', () => {
		expect(isAppUrl(`${ORIGIN}/a?b=1`, ORIGIN)).toBe(true);
		expect(isAppUrl(`http://localhost:${PORT}/`, ORIGIN)).toBe(false);
		expect(isAppUrl(`http://127.0.0.1:${PORT}.evil.example/`, ORIGIN)).toBe(false);
		expect(isAppUrl('about:blank', ORIGIN)).toBe(false);
	});
});

describe('showWindow', () => {
	it('creates the window when none was created yet', () => {
		const { deps } = makeDeps();
		const state = createWindowState(deps, ORIGIN);

		const window = showWindow(state) as FakeWindow;

		expect(FakeWindow.instances).toEqual([window]);
		expect(state.window).toBe(window);
		expect(window.show).toHaveBeenCalledTimes(1);
		expect(window.focus).toHaveBeenCalledTimes(1);
	});

	it('creates exactly one new window after the old one was closed', () => {
		const { deps } = makeDeps();
		const state = createWindowState(deps, ORIGIN);
		const first = showWindow(state) as FakeWindow;
		first.close();

		const second = showWindow(state) as FakeWindow;

		expect(FakeWindow.instances).toEqual([first, second]);
		expect(second).not.toBe(first);
		expect(state.window).toBe(second);
		expect(second.loaded).toEqual([ORIGIN]);
		expect(second.show).toHaveBeenCalledTimes(1);
	});

	it('recreates a window destroyed without a closed event reaching it', () => {
		const { deps } = makeDeps();
		const state = createWindowState(deps, ORIGIN);
		const first = showWindow(state) as FakeWindow;
		first.destroyed = true;

		showWindow(state);

		expect(FakeWindow.instances).toHaveLength(2);
	});

	it('restores a minimised window instead of creating another', () => {
		const { deps } = makeDeps();
		const state = createWindowState(deps, ORIGIN);
		const window = showWindow(state) as FakeWindow;
		window.minimized = true;

		expect(showWindow(state)).toBe(window);
		expect(window.restore).toHaveBeenCalledTimes(1);
		expect(window.show).toHaveBeenCalledTimes(2);
		expect(window.focus).toHaveBeenCalledTimes(2);
		expect(FakeWindow.instances).toHaveLength(1);
	});

	it('only shows and focuses a visible window', () => {
		const { deps } = makeDeps();
		const state = createWindowState(deps, ORIGIN);
		const window = showWindow(state) as FakeWindow;

		expect(showWindow(state)).toBe(window);
		expect(window.restore).not.toHaveBeenCalled();
		expect(FakeWindow.instances).toHaveLength(1);
	});
});
