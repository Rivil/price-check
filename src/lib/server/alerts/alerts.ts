// Alert routing: after every check, which of the channels get told, and the
// per-channel record of which have had the current price drop (decision
// delivery_state_per_channel). Sending goes through each channel's driver with an
// injected fetch, so nothing here reaches a real server on its own.
//
// Log lines name the watch, the channel kind and a fixed failure reason only —
// never a topic, a token or an error's text (c-7).
import { and, eq, sql } from 'drizzle-orm';
import { formatPence } from '../../money.ts';
import type { Db } from '../db/client.ts';
import { priceDropDelivery, watch } from '../db/schema.ts';
import type { CheckFailure } from '../shops/types.ts';
import { describeFailure, type Alert, type DriverDeps } from './channel.ts';
import { channelsFor, type Logger, type RoutedChannel } from './channels.ts';

export type AlertDeps = {
	/** The channel key; read per call (and inside the never-throw guard), as alertsKey() is. */
	key: () => Buffer;
	fetch: DriverDeps['fetch'];
	now?: () => Date;
	log?: Logger;
};

/** What happened to one channel: sent now, failed now, or already had this drop. */
export type ChannelOutcome = 'sent' | 'send_failed' | 'already_sent';

export type AlertOutcome =
	| 'sent'
	| 'send_failed'
	| 'already_sent'
	| 'no_channel'
	| 'rearmed'
	| 'not_due'
	| 'not_found'
	| 'in_progress'
	| 'error';

/**
 * outcome sums the call up: 'send_failed' if any channel's send failed, else 'sent'
 * if any was sent, else 'already_sent'. channels has one entry per channel routed
 * this alert kind, keyed by channel kind.
 */
export type AlertReport = { outcome: AlertOutcome; channels: Record<string, ChannelOutcome> };

const defaultLog: Logger = (message) => console.error(message);

/** Only the error's type: its text could carry anything, a topic or a token included. */
const errorName = (error: unknown) => (error instanceof Error ? error.name : 'error');

const summary = (channels: Record<string, ChannelOutcome>): AlertOutcome => {
	const outcomes = Object.values(channels);
	if (outcomes.includes('send_failed')) return 'send_failed';
	return outcomes.includes('sent') ? 'sent' : 'already_sent';
};

/**
 * Sends one alert to one channel. Never rejects: a failed or throwing send is
 * logged by watch, channel kind and reason (or error type) only, and is false.
 */
async function deliver(
	channel: RoutedChannel,
	alert: Alert,
	deps: AlertDeps,
	what: string,
	log: Logger
): Promise<boolean> {
	try {
		const result = await channel.driver.send(channel.config, alert, { fetch: deps.fetch });
		if (result.ok) return true;
		log(`[alerts] ${what} (${channel.kind}) not delivered: ${describeFailure(result.reason)}`);
	} catch (error) {
		log(`[alerts] ${what} (${channel.kind}) failed (${errorName(error)})`);
	}
	return false;
}

/**
 * Marks the drop delivered to `kind`, for `targetPence` — but only while the watch's
 * target still is that: one statement, so a target changed during the send leaves
 * no row behind and the new target can still alert. Replaces a stale row for an
 * older target in place.
 */
async function recordDelivery(
	db: Db,
	watchId: string,
	kind: string,
	targetPence: number,
	at: Date
): Promise<void> {
	await db
		.insert(priceDropDelivery)
		.select((qb) =>
			qb
				.select({
					watchId: watch.id,
					kind: sql<string>`${kind}`.as('kind'),
					targetPence: sql<number>`${watch.targetPence}`.as('target_pence'),
					deliveredAt: sql<Date>`${at.getTime()}`.as('delivered_at')
				})
				.from(watch)
				.where(and(eq(watch.id, watchId), eq(watch.targetPence, targetPence)))
		)
		.onConflictDoUpdate({
			target: [priceDropDelivery.watchId, priceDropDelivery.kind],
			set: {
				targetPence: sql`excluded.target_pence`,
				deliveredAt: sql`excluded.delivered_at`
			}
		});
}

// Watches with a decision in flight (decision alert_claim). Module level because
// the scheduler and "Check now" each build their own hook, and they overlap. The
// app runs as one process; a second one would need a claim in the database.
const inFlight = new Set<string>();

/**
 * Called after a successful check has been recorded. At or below target: send the
 * drop, in parallel, to each enabled price-drop channel without a delivery row for
 * the current target, and record a row for each one delivered to — so a channel
 * whose send failed is retried on the next such check, and only that channel (c-5).
 * Above target (or no target): delete the watch's delivery rows, which re-arms it
 * and drops any pending retry (decision stale_retry_dropped).
 * One call per watch at a time: an overlapping call neither waits nor retries, it
 * returns 'in_progress' and leaves the watch to the next check. A crash between
 * delivery and the row can repeat an alert once, but never loses one.
 * Never throws — a failed alert must never fail the check.
 */
export async function alertAfterSuccess(
	db: Db,
	watchId: string,
	deps: AlertDeps
): Promise<AlertReport> {
	const log = deps.log ?? defaultLog;
	if (inFlight.has(watchId)) return { outcome: 'in_progress', channels: {} };
	inFlight.add(watchId);
	try {
		const [w] = await db.select().from(watch).where(eq(watch.id, watchId));
		if (w === undefined) return { outcome: 'not_found', channels: {} };

		const dropped =
			w.targetPence !== null && w.pricePence !== null && w.pricePence <= w.targetPence;
		if (!dropped) {
			const cleared = await db
				.delete(priceDropDelivery)
				.where(eq(priceDropDelivery.watchId, w.id))
				.returning({ kind: priceDropDelivery.kind });
			return { outcome: cleared.length > 0 ? 'rearmed' : 'not_due', channels: {} };
		}
		const targetPence = w.targetPence!;

		const routed = await channelsFor(db, deps.key(), 'price_drop', { log });
		if (routed.length === 0) return { outcome: 'no_channel', channels: {} };

		const delivered = await db
			.select({ kind: priceDropDelivery.kind, targetPence: priceDropDelivery.targetPence })
			.from(priceDropDelivery)
			.where(eq(priceDropDelivery.watchId, w.id));
		const done = new Set(delivered.filter((d) => d.targetPence === targetPence).map((d) => d.kind));

		const label = w.title ?? w.canonicalUrl;
		const alert: Alert = {
			kind: 'price_drop',
			title: `Price drop: ${label}`,
			message: `${label} is now ${formatPence(w.pricePence!)}, at or below your ${formatPence(targetPence)} target.`,
			click: w.canonicalUrl
		};
		const now = deps.now ?? (() => new Date());

		const channels: Record<string, ChannelOutcome> = {};
		await Promise.allSettled(
			routed.map(async (channel) => {
				if (done.has(channel.kind)) {
					channels[channel.kind] = 'already_sent';
					return;
				}
				const sent = await deliver(channel, alert, deps, `alert for watch ${w.id}`, log);
				channels[channel.kind] = sent ? 'sent' : 'send_failed';
				if (!sent) return;
				try {
					await recordDelivery(db, w.id, channel.kind, targetPence, now());
				} catch (error) {
					// Delivered but unrecorded: the next check sends it again, never loses it.
					log(
						`[alerts] delivery for watch ${w.id} (${channel.kind}) not recorded (${errorName(error)})`
					);
				}
			})
		);
		return { outcome: summary(channels), channels };
	} catch (error) {
		log(`[alerts] alert for watch ${watchId} failed (${errorName(error)})`);
		return { outcome: 'error', channels: {} };
	} finally {
		inFlight.delete(watchId);
	}
}

/**
 * Called after a failed check has been recorded: tells each enabled channel set for
 * failed checks, in parallel, every time — no claim and no record, so a long outage
 * alerts on each check and nothing is retried (decision failure_alerts_no_retry).
 * Never throws — a failed alert must never fail the check.
 */
export async function alertAfterFailure(
	db: Db,
	watchId: string,
	result: CheckFailure,
	deps: AlertDeps
): Promise<AlertReport> {
	const log = deps.log ?? defaultLog;
	try {
		const [w] = await db.select().from(watch).where(eq(watch.id, watchId));
		if (w === undefined) return { outcome: 'not_found', channels: {} };

		const routed = await channelsFor(db, deps.key(), 'check_failed', { log });
		if (routed.length === 0) return { outcome: 'no_channel', channels: {} };

		const label = w.title ?? w.canonicalUrl;
		const alert: Alert = {
			kind: 'check_failed',
			title: `Check failed: ${label}`,
			message: `Couldn't check ${label}: ${result.message}.`,
			click: w.canonicalUrl
		};
		const channels: Record<string, ChannelOutcome> = {};
		await Promise.allSettled(
			routed.map(async (channel) => {
				const sent = await deliver(channel, alert, deps, `failure alert for watch ${w.id}`, log);
				channels[channel.kind] = sent ? 'sent' : 'send_failed';
			})
		);
		return { outcome: summary(channels), channels };
	} catch (error) {
		log(`[alerts] failure alert for watch ${watchId} failed (${errorName(error)})`);
		return { outcome: 'error', channels: {} };
	}
}
