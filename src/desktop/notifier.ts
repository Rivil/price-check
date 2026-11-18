// The desktop notifier main publishes on the notify bridge (spec c-1, c-2, c-5;
// decisions notify_bridge, delivery_result, click_target).
//
// show() resolves once the OS has accepted or refused the notice:
// - isSupported() false: {ok:false, reason:'unsupported'}, and nothing is constructed.
// - 'show': {ok:true}. 'failed' first (macOS and Windows only): {ok:false, 'failed'}.
// - Neither within settleMs: {ok:true}. Suppression the OS does not report
//   (permission denied, Focus, no Linux daemon) counts as delivered; treating it as
//   a failure would re-notify on every check.
// Once settled the settle timer is cleared, so no armed timer holds up quit.
//
// Title and body go to Electron exactly as given. No toastXml: on Windows it replaces
// every other option and would need its own XML escaping.
//
// Electron drops a garbage-collected Notification's listeners, so a click on it would
// go nowhere. Each one is held here until 'click', 'close' or 'failed'; Linux may
// never emit 'close', so only the newest MAX_RETAINED are held.
//
// A click resolves the notice's clickPath() and hands it to the click handler. A path
// that rejects, or is not a single-slash path ('//host' and '/\host' are
// protocol-relative), opens '/' instead. A click before setClickHandler is kept and
// delivered when the handler arrives.
//
// Runs in the Electron main bundle: Electron is injected, types via `import type` only.
import type { DesktopFailure, DesktopNotice, DesktopNotifier } from '#lib/server/notify-bridge.ts';
import type { NotificationCtor, NotificationLike } from './notify-seam.ts';

export const MAX_RETAINED = 20;
const FALLBACK_PATH = '/';

export type ShowResult = { ok: true } | { ok: false; reason: DesktopFailure };

export type ClickHandler = (path: string) => void;

export type NotifierInput = {
	/** Electron's Notification class, or the e2e seam's recorder. */
	Notification: NotificationCtor;
	/** How long show() waits for 'show' or 'failed' before counting it delivered. */
	settleMs: number;
};

export type NotifierHandle = {
	notifier: DesktopNotifier;
	/** Where clicks go; a click that came before this is delivered to it now. */
	setClickHandler(handler: ClickHandler): void;
	/** How many notifications are held against garbage collection. */
	retainedCount(): number;
};

/** True for an in-app path: one leading slash, not protocol-relative. */
function isAppPath(path: unknown): path is string {
	return (
		typeof path === 'string' &&
		path.startsWith('/') &&
		!path.startsWith('//') &&
		!path.startsWith('/\\')
	);
}

async function resolveClickPath(notice: DesktopNotice): Promise<string> {
	try {
		const path = await notice.clickPath();
		return isAppPath(path) ? path : FALLBACK_PATH;
	} catch (error) {
		console.error('desktop notification: resolving the click path failed', error);
		return FALLBACK_PATH;
	}
}

export function createNotifier({ Notification, settleMs }: NotifierInput): NotifierHandle {
	const retained: NotificationLike[] = [];
	let clickHandler: ClickHandler | undefined;
	let pendingClick: string | undefined;

	function retain(notification: NotificationLike): void {
		retained.push(notification);
		if (retained.length > MAX_RETAINED) retained.splice(0, retained.length - MAX_RETAINED);
	}

	function release(notification: NotificationLike): void {
		const index = retained.indexOf(notification);
		if (index !== -1) retained.splice(index, 1);
	}

	function deliverClick(path: string): void {
		if (!clickHandler) {
			pendingClick = path;
			return;
		}
		try {
			clickHandler(path);
		} catch (error) {
			console.error('desktop notification: click handler failed', error);
		}
	}

	async function onClick(notice: DesktopNotice): Promise<void> {
		deliverClick(await resolveClickPath(notice));
	}

	const notifier: DesktopNotifier = {
		show(notice) {
			if (!Notification.isSupported()) {
				return Promise.resolve({ ok: false, reason: 'unsupported' });
			}
			let notification: NotificationLike;
			try {
				notification = new Notification({ title: notice.title, body: notice.body });
			} catch (error) {
				console.error('desktop notification: constructing it failed', error);
				return Promise.resolve({ ok: false, reason: 'failed' });
			}
			return new Promise<ShowResult>((resolve) => {
				let settled = false;
				const timer = setTimeout(() => settle({ ok: true }), settleMs);
				function settle(result: ShowResult): void {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(result);
				}

				notification.on('show', () => settle({ ok: true }));
				notification.on('failed', (_event, error) => {
					console.error('desktop notification: the OS reported a failure', error);
					release(notification);
					settle({ ok: false, reason: 'failed' });
				});
				notification.on('close', () => release(notification));
				notification.on('click', () => {
					release(notification);
					void onClick(notice);
				});

				retain(notification);
				try {
					notification.show();
				} catch (error) {
					console.error('desktop notification: showing it failed', error);
					release(notification);
					settle({ ok: false, reason: 'failed' });
				}
			});
		}
	};

	return {
		notifier,
		setClickHandler(handler) {
			clickHandler = handler;
			if (pendingClick === undefined) return;
			const path = pendingClick;
			pendingClick = undefined;
			deliverClick(path);
		},
		retainedCount: () => retained.length
	};
}
