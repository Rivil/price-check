// The desktop channel driver: shows an alert as a native notification through the
// notifier main publishes on the notify bridge (decision notify_bridge). It is only
// registered when that notifier is present (decision desktop_only_driver), and its
// stored row is seeded on, with price drops ticked and failed checks not (decision
// default_on_seed). The server bundle never imports electron: the notifier is injected.
//
// A click opens the watch in the app, not the shop (decision click_target): the path
// is resolved at click time, so a watch deleted since opens the watchlist instead.
//
// Delivery (decision delivery_result): the OS accepting the notice is delivered. An
// unsupported platform, an Electron 'failed' event, or a notifier that throws or
// rejects is a failed send with a fixed reason, so alerts.ts logs it by kind and
// reason only and retries it on the next check. send never throws.
import type { DesktopNotice, DesktopNotifier } from '../notify-bridge.ts';
import type { Db } from '../db/client.ts';
import type { Alert, ChannelDriver, SendResult } from './channel.ts';
import { ensureChannel, registerDriver, type AnyDriver } from './channels.ts';

/** The desktop channel has no settings of its own. */
export type DesktopConfig = Record<string, never>;

export type DesktopDeps = {
	/** Whether the watch still exists; asked when a notification is clicked. */
	watchExists(watchId: string): Promise<boolean>;
};

export const TEST_CLICK_PATH = '/account/alerts';
export const FALLBACK_CLICK_PATH = '/';

/** The in-app path a click on `alert` opens, resolved when it is clicked. */
async function clickPathFor(alert: Alert, { watchExists }: DesktopDeps): Promise<string> {
	if (alert.kind === 'test') return TEST_CLICK_PATH;
	if (alert.watchId === undefined) return FALLBACK_CLICK_PATH;
	try {
		if (await watchExists(alert.watchId)) return `/watches/${encodeURIComponent(alert.watchId)}`;
	} catch {
		// Fall through: an unanswerable lookup opens the watchlist, never a dead page.
	}
	return FALLBACK_CLICK_PATH;
}

export function createDesktopDriver(
	notifier: DesktopNotifier,
	deps: DesktopDeps
): ChannelDriver<DesktopConfig> {
	return {
		kind: 'desktop',
		defaultKinds: ['price_drop'],
		parseConfig: () => ({ ok: true, config: {} }),
		view: () => ({}),

		async send(_config, alert): Promise<SendResult> {
			const notice: DesktopNotice = {
				title: alert.title,
				body: alert.message,
				clickPath: () => clickPathFor(alert, deps)
			};
			try {
				// Inside the try: a notifier that throws synchronously is caught too.
				const result = await notifier.show(notice);
				if (result.ok) return { ok: true };
				return { ok: false, reason: result.reason === 'unsupported' ? 'unsupported' : 'refused' };
			} catch {
				// The error's text is never kept: the result carries a fixed reason only.
				return { ok: false, reason: 'unreachable' };
			}
		}
	};
}

/**
 * Registers the desktop driver and seeds its channel row if none exists (enabled,
 * price drops on, failed checks off); a user's saved choices are never changed.
 * Returns a function that unregisters the driver. If seeding fails the driver is
 * unregistered again and the error rethrown.
 */
export async function installDesktop(
	db: Db,
	key: Buffer,
	notifier: DesktopNotifier,
	deps: DesktopDeps
): Promise<() => void> {
	const unregister = registerDriver(createDesktopDriver(notifier, deps) as AnyDriver);
	try {
		await ensureChannel(db, key, 'desktop', { priceDrops: true, checkFailures: false });
	} catch (error) {
		unregister();
		throw error;
	}
	return unregister;
}
