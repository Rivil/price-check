import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { ALERTS_ENCRYPTION_KEY, CHECK_INTERVAL_HOURS, SCHEDULER_DISABLED } from '$app/env/private';
import { alertsKey, parseAlertsKey, setAlertsKey } from '#lib/server/alerts/crypto.ts';
import { installDesktop } from '#lib/server/alerts/desktop.ts';
import { db } from '#lib/server/db/index.ts';
import { migrateDb } from '#lib/server/db/migrate.ts';
import { formatError } from '#lib/server/error-log.ts';
import { createLocalRequestHandle } from '#lib/server/local-request.ts';
import { readNotifier } from '#lib/server/notify-bridge.ts';
import { closeOnce, publishRuntime } from '#lib/server/runtime-bridge.ts';
import { startScheduler, type SchedulerControls } from '#lib/server/scheduler.ts';
import { checkUrl } from '#lib/server/shops/index.ts';
import { getWatch } from '#lib/server/watches.ts';

/**
 * Inside Electron, registers the desktop channel and seeds its row before the first
 * scheduler pass, so that pass already routes desktop alerts. Outside Electron there
 * is no notifier and nothing happens (decision desktop_only_driver). A failure here
 * never stops startup: installDesktop has already unregistered the driver, the app
 * runs without desktop alerts this launch, and the log line carries the error's type
 * and frames only, never its message (a failed query's text holds its params).
 */
async function setUpDesktopAlerts(): Promise<void> {
	const notifier = readNotifier();
	if (notifier === undefined) return;
	try {
		await installDesktop(db, alertsKey(), notifier, {
			watchExists: async (id) => (await getWatch(db, id)) !== null
		});
	} catch (error) {
		console.error(`[server] desktop alerts not set up: ${formatError(error)}`);
	}
}

/**
 * Loads the alert-credentials key first — without a valid ALERTS_ENCRYPTION_KEY
 * the server refuses to start, naming the variable but never its value (decision
 * encryption_key) — then brings the database up to date before the first request
 * (a fresh volume has no tables), sets up desktop alerts when running in the app,
 * then re-checks due watches in the background.
 * Last, it publishes the scheduler and database controls for the desktop main
 * process (resume runs a pass, quit stops the scheduler and closes the db); with
 * the scheduler off, requestPass and stop are no-ops, so main never needs to know.
 */
export const init: ServerInit = async () => {
	if (!building) {
		setAlertsKey(parseAlertsKey(ALERTS_ENCRYPTION_KEY));
		await migrateDb(db);
		await setUpDesktopAlerts();
	}
	const scheduler: SchedulerControls = startScheduler({
		env: { CHECK_INTERVAL_HOURS, SCHEDULER_DISABLED, VITEST: process.env.VITEST },
		building,
		db,
		check: (url) => checkUrl(url)
	}) ?? { requestPass() {}, stop: async () => {} };
	publishRuntime({
		requestPass: scheduler.requestPass,
		stop: scheduler.stop,
		closeDb: closeOnce(() => db.$client.close())
	});
};

/**
 * The whole access control of a single-user local install (decision
 * local_request_guard): every request, /health included, must be addressed to a
 * loopback Host or it gets a 403 before any route runs, and every POST, PUT,
 * PATCH or DELETE must carry Origin http://<Host> or it gets the same 403. Kit's
 * own CSRF check does not cover this: it is compiled out of `vite dev` and
 * checks form content types only (in a build it still answers a forged form post
 * first). Every response also denies framing. There is no login and no session.
 */
export const handle: Handle = createLocalRequestHandle();

/**
 * Replaces Kit's default, which prints each error's message and its cause chain:
 * either can carry an ntfy topic or token (decision error_log_content). The route
 * id, not the URL, names where it happened. Expected errors such as 404s log
 * nothing. Returns nothing, so the client still gets Kit's 'Internal Error'. Must
 * never throw: Kit would then print the raw error.
 */
export const handleError: HandleServerError = ({ kind, error, event }) => {
	if (kind !== 'unknown') return;
	console.error(`[server] error on route ${event.route.id}: ${formatError(error)}`);
};
