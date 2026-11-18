// The update controller (spec c-5; decision update_flow). A packaged install checks
// GitHub Releases at launch and every UPDATE_CHECK_INTERVAL_MS, lets electron-updater
// download a newer release in the background, then shows one notification per
// version and tells main (onReady) so the tray can offer 'Restart to update'. It
// never restarts the app itself: the lifecycle calls installOnExit on Quit or on
// 'Restart to update'.
//
// An unpackaged run (pnpm dev, the e2e suite) is inert: start() touches neither the
// updater nor a timer.
//
// Channels: electron-updater turns allowPrerelease on when the running version has a
// prerelease part (0.1.5-rc.1). Its GitHub provider then follows the newest release
// in the rc channel and asks for rc*.yml, so an rc install would never take the
// final 0.1.5. With allowPrerelease false the provider reads /releases/latest, which
// GitHub never points at a pre-release: an rc install takes the final, a final
// install never takes an rc. `channel` is never set (its setter turns allowDowngrade
// on).
//
// The feed comes only from app-update.yml, written at package time: nothing here may
// set a feed URL or update config path at runtime (decision update_flow).
//
// Runs in the Electron main bundle: the updater is injected, types via `import type`
// only.
import type { AppUpdater, UpdateDownloadedEvent } from 'electron-updater';
import type { DesktopNotifier } from '#lib/server/notify-bridge.ts';

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATER_HANDLE_KEY = Symbol.for('price-check.updater');

/** The slice of electron-updater's autoUpdater the controller uses. */
export type AutoUpdater = Pick<
	AppUpdater,
	| 'autoDownload'
	| 'autoInstallOnAppQuit'
	| 'allowDowngrade'
	| 'allowPrerelease'
	| 'autoRunAppAfterInstall'
	| 'checkForUpdates'
	| 'quitAndInstall'
> & {
	on(event: 'error', listener: (error: Error, message?: string) => void): unknown;
	on(
		event: 'checking-for-update' | 'update-available' | 'update-not-available',
		listener: () => void
	): unknown;
	on(event: 'update-downloaded', listener: (event: UpdateDownloadedEvent) => void): unknown;
};

type IntervalHandle = ReturnType<typeof setInterval>;

export type UpdaterTimers = {
	setInterval(callback: () => void, ms: number): IntervalHandle;
	clearInterval(handle: IntervalHandle): void;
};

export type UpdaterLog = {
	info(message: string): void;
	error(message: string, error?: unknown): void;
};

export type UpdaterInput = {
	autoUpdater: AutoUpdater;
	isPackaged: boolean;
	/** The running version, for the log only: electron-updater reads its own. */
	appVersion: string;
	notifier: DesktopNotifier;
	/** Called once per newly downloaded version (main shows the tray item). */
	onReady(version: string): void;
	timers: UpdaterTimers;
	log: UpdaterLog;
};

export type UpdateState = 'idle' | 'checking' | 'downloaded';

export type UpdaterStatus = {
	state: UpdateState;
	/** The downloaded version waiting to install, or null. */
	version: string | null;
	/** Every version a notification was shown for, each once, oldest first. */
	notified: string[];
};

/** 'quit' installs without relaunching; 'restart' relaunches the new version. */
export type ExitMode = 'quit' | 'restart';

export type UpdaterController = {
	start(): void;
	stop(): void;
	status(): UpdaterStatus;
	/** Starts a check now, or joins the one in flight. Resolves when it settles. */
	checkNow(): Promise<void>;
	/** True once an update is downloaded and not yet handed to the installer. */
	pending(): boolean;
	/** Hands a downloaded update to the installer; false when nothing was handed. */
	installOnExit(mode: ExitMode): boolean;
};

/** What main publishes for the packaged e2e suite. */
export type UpdaterHandle = {
	status(): UpdaterStatus;
	restart(): void;
	checkNow(): Promise<void>;
};

export const UPDATE_NOTICE_TITLE = 'Price Check update ready';

function updateNotice(version: string) {
	return {
		title: UPDATE_NOTICE_TITLE,
		body: `Version ${version} is downloaded. Choose Restart to update in the tray menu, or it installs when you quit.`,
		clickPath: () => Promise.resolve('/')
	};
}

export function createUpdater({
	autoUpdater,
	isPackaged,
	appVersion,
	notifier,
	onReady,
	timers,
	log
}: UpdaterInput): UpdaterController {
	let started = false;
	let stopped = false;
	let interval: IntervalHandle | undefined;
	let inFlight: Promise<void> | null = null;
	let state: UpdateState = 'idle';
	let downloaded: string | null = null;
	let installed = false;
	const notified: string[] = [];

	function safeLog(level: keyof UpdaterLog, message: string, error?: unknown): void {
		try {
			log[level](message, error);
		} catch {
			// A failing logger must never break the update flow.
		}
	}

	function settleIdle(): void {
		if (state === 'checking') state = 'idle';
	}

	function onDownloaded(event: UpdateDownloadedEvent): void {
		const version = event.version;
		downloaded = version;
		installed = false;
		state = 'downloaded';
		if (notified.includes(version)) return;
		notified.push(version);
		safeLog('info', `update ${version} downloaded`);
		notifier.show(updateNotice(version)).then(
			(result) => {
				if (!result.ok) safeLog('error', `update notification for ${version}: ${result.reason}`);
			},
			(error: unknown) => safeLog('error', `update notification for ${version} failed`, error)
		);
		try {
			onReady(version);
		} catch (error) {
			safeLog('error', 'update onReady failed', error);
		}
	}

	async function checkOnce(): Promise<void> {
		try {
			const result = await autoUpdater.checkForUpdates();
			// A failed download is reported through 'error'; its promise would
			// otherwise reject unhandled.
			result?.downloadPromise?.catch(() => undefined);
		} catch (error) {
			settleIdle();
			safeLog('error', 'update check failed', error);
		}
	}

	function runCheck(): Promise<void> {
		if (inFlight) return inFlight;
		// Cleared in a later microtask, so a checkForUpdates that throws at once
		// cannot clear it before it is set.
		const check = checkOnce().finally(() => {
			if (inFlight === check) inFlight = null;
		});
		inFlight = check;
		return check;
	}

	return {
		start() {
			if (!isPackaged || started || stopped) return;
			started = true;
			autoUpdater.allowPrerelease = false;
			autoUpdater.allowDowngrade = false;
			autoUpdater.autoDownload = true;
			autoUpdater.autoInstallOnAppQuit = false;
			autoUpdater.on('error', (error) => {
				settleIdle();
				safeLog('error', 'updater error', error);
			});
			autoUpdater.on('checking-for-update', () => {
				if (state === 'idle') state = 'checking';
			});
			autoUpdater.on('update-not-available', settleIdle);
			autoUpdater.on('update-downloaded', onDownloaded);
			safeLog('info', `updates on for ${appVersion}`);
			void runCheck();
			interval = timers.setInterval(() => void runCheck(), UPDATE_CHECK_INTERVAL_MS);
		},
		stop() {
			stopped = true;
			if (interval !== undefined) timers.clearInterval(interval);
			interval = undefined;
		},
		status: () => ({ state, version: downloaded, notified: [...notified] }),
		checkNow() {
			if (!started || stopped) return Promise.resolve();
			return runCheck();
		},
		pending: () => downloaded !== null && !installed,
		installOnExit(mode) {
			if (downloaded === null || installed) return false;
			installed = true;
			try {
				// macOS: MacUpdater ignores quitAndInstall's arguments and relaunches only
				// when autoRunAppAfterInstall is on, so a plain Quit turns it off (the
				// update still installs, the app stays closed). Windows and Linux read it
				// only for a non-silent install, and this one is silent: there the second
				// argument decides.
				autoUpdater.autoRunAppAfterInstall = mode === 'restart';
				autoUpdater.quitAndInstall(true, mode === 'restart');
				return true;
			} catch (error) {
				installed = false;
				safeLog('error', 'handing the update to the installer failed', error);
				return false;
			}
		}
	};
}

/** Publishes the updater for the packaged e2e suite (main, packaged only). */
export function publishUpdaterHandle(handle: UpdaterHandle): void {
	(globalThis as { [UPDATER_HANDLE_KEY]?: UpdaterHandle })[UPDATER_HANDLE_KEY] = handle;
}
