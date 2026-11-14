import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { ALERTS_ENCRYPTION_KEY, CHECK_INTERVAL_HOURS, SCHEDULER_DISABLED } from '$app/env/private';
import { parseAlertsKey, setAlertsKey } from '#lib/server/alerts/crypto.ts';
import { db } from '#lib/server/db/index.ts';
import { migrateDb } from '#lib/server/db/migrate.ts';
import { formatError } from '#lib/server/error-log.ts';
import { createLocalRequestHandle } from '#lib/server/local-request.ts';
import { startScheduler } from '#lib/server/scheduler.ts';
import { checkUrl } from '#lib/server/shops/index.ts';

/**
 * Loads the alert-credentials key first — without a valid ALERTS_ENCRYPTION_KEY
 * the server refuses to start, naming the variable but never its value (decision
 * encryption_key) — then brings the database up to date before the first request
 * (a fresh volume has no tables), then re-checks due watches in the background.
 */
export const init: ServerInit = async () => {
	if (!building) {
		setAlertsKey(parseAlertsKey(ALERTS_ENCRYPTION_KEY));
		await migrateDb(db);
	}
	startScheduler({
		env: { CHECK_INTERVAL_HOURS, SCHEDULER_DISABLED, VITEST: process.env.VITEST },
		building,
		db,
		check: (url) => checkUrl(url)
	});
};

/**
 * The whole access control of a single-user local install (decision
 * local_request_guard): every request, /health included, must be addressed to a
 * loopback Host or it gets a 403 before any route runs. Kit's CSRF origin check
 * covers cross-origin form POSTs. There is no login and no session.
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
