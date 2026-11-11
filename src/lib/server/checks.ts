// Re-checking watches: applying a check's result, choosing which watches are due,
// a user's "Check now", and the price and failure history those checks build. Shop
// access is injected (check), so nothing here can reach the network on its own (r-01).
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { checkFailure, pricePoint, watch } from './db/schema.ts';
import type { CheckFailure, CheckResult } from './shops/types.ts';
import { getWatch, runAfterSuccess } from './watches.ts';

export const DEFAULT_INTERVAL_HOURS = 6;
const HOUR_MS = 60 * 60 * 1000;

/** 'Check now' is refused this long after a watch's last check (decision manual_check_cooldown). */
export const CHECK_COOLDOWN_MS = 15 * 60 * 1000;
export const COOLDOWN_MESSAGE = 'Checked less than 15 minutes ago — try again later';

export type CheckDeps = {
	/** One live check of a product URL (ShopRegistry.check bound to the shared client). */
	check(url: string): Promise<CheckResult>;
	now?: () => Date;
	newId?: () => string;
	/** Called once after a successful check is recorded (e.g. to alert); its failure never fails the check. */
	afterSuccess?: (watchId: string) => Promise<unknown>;
	/** Called once after a failed check is recorded (e.g. to alert); its failure is only logged. */
	afterFailure?: (watchId: string, result: CheckFailure) => Promise<unknown>;
};

/** The re-check interval in ms: CHECK_INTERVAL_HOURS, a whole number of hours from 1 to 168 (default 6). */
export function checkIntervalFromEnv(env: Record<string, string | undefined>): number {
	const raw = env.CHECK_INTERVAL_HOURS?.trim();
	if (raw === undefined || raw === '') return DEFAULT_INTERVAL_HOURS * HOUR_MS;
	const hours = /^\d+$/.test(raw) ? Number(raw) : NaN;
	if (!(hours >= 1 && hours <= 168)) {
		throw new Error(
			`CHECK_INTERVAL_HOURS must be a whole number of hours from 1 to 168, got "${raw}"`
		);
	}
	return hours * HOUR_MS;
}

/**
 * Applies one check's result to a watch. A success updates what the check saw,
 * clears the watch's current failure and appends a history point; a failure
 * records the reason, message and time on the watch and appends a failure row,
 * keeping the last known price (failure_keeps_price). Rows are never cleared: a
 * later success leaves the failures before it in the history.
 */
export async function recordCheck(
	db: Db,
	watchId: string,
	result: CheckResult,
	checkedAt: Date,
	newId: () => string = () => crypto.randomUUID()
): Promise<void> {
	if (!result.ok) {
		await db.transaction(async (tx) => {
			await tx
				.update(watch)
				.set({
					lastCheckedAt: checkedAt,
					lastCheckReason: result.reason,
					lastCheckMessage: result.message
				})
				.where(eq(watch.id, watchId));
			await tx.insert(checkFailure).values({
				id: newId(),
				watchId,
				reason: result.reason,
				message: result.message,
				checkedAt
			});
		});
		return;
	}
	await db.transaction(async (tx) => {
		await tx
			.update(watch)
			.set({
				title: result.title,
				imageUrl: result.imageUrl,
				pricePence: result.pricePence,
				lastCheckedAt: checkedAt,
				lastCheckReason: null,
				lastCheckMessage: null
			})
			.where(eq(watch.id, watchId));
		await tx
			.insert(pricePoint)
			.values({ id: newId(), watchId, pricePence: result.pricePence, checkedAt });
	});
}

export type DueWatch = { id: string; canonicalUrl: string };

/**
 * Every watch whose last check is at least intervalMs old, whatever that check's
 * outcome: never-checked first, then oldest-checked first.
 */
export function dueWatches(db: Db, now: Date, intervalMs: number): Promise<DueWatch[]> {
	const cutoff = new Date(now.getTime() - intervalMs);
	return db
		.select({ id: watch.id, canonicalUrl: watch.canonicalUrl })
		.from(watch)
		.where(or(isNull(watch.lastCheckedAt), lte(watch.lastCheckedAt, cutoff)))
		.orderBy(sql`${watch.lastCheckedAt} IS NOT NULL`, asc(watch.lastCheckedAt), asc(watch.id));
}

/** One check of one watch, recorded like any other. */
export async function checkWatch(db: Db, due: DueWatch, deps: CheckDeps): Promise<CheckResult> {
	const result = await deps.check(due.canonicalUrl);
	await recordCheck(db, due.id, result, (deps.now ?? (() => new Date()))(), deps.newId);
	if (result.ok) await runAfterSuccess(deps.afterSuccess, due.id);
	else await runAfterFailure(deps.afterFailure, due.id, result);
	return result;
}

/** Runs an afterFailure hook; whatever it does, the check's own result stands. */
async function runAfterFailure(
	hook: CheckDeps['afterFailure'],
	watchId: string,
	result: CheckFailure
): Promise<void> {
	if (hook === undefined) return;
	try {
		await hook(watchId, result);
	} catch (error) {
		// Only the error's type: its text could carry anything, an ntfy topic included.
		console.error(
			`[checks] after-failure hook for watch ${watchId} failed (${error instanceof Error ? error.name : 'error'})`
		);
	}
}

export type CheckNowResult =
	| { kind: 'checked'; result: CheckResult }
	| { kind: 'cooldown'; message: string }
	| { kind: 'not_found' };

/** A user's "Check now" on their own watch, refused within the cooldown. */
export async function checkNow(
	db: Db,
	userId: string,
	watchId: string,
	deps: CheckDeps
): Promise<CheckNowResult> {
	const own = await getWatch(db, userId, watchId);
	if (own === null) return { kind: 'not_found' };
	const now = (deps.now ?? (() => new Date()))();
	if (
		own.lastCheckedAt !== null &&
		now.getTime() - own.lastCheckedAt.getTime() < CHECK_COOLDOWN_MS
	) {
		return { kind: 'cooldown', message: COOLDOWN_MESSAGE };
	}
	const result = await checkWatch(db, own, { ...deps, now: () => now });
	return { kind: 'checked', result };
}

export type HistoryPoint = { pricePence: number; checkedAt: Date };

/** The user's watch's history, newest first; empty for another user's watch. */
export function priceHistory(db: Db, userId: string, watchId: string): Promise<HistoryPoint[]> {
	return db
		.select({ pricePence: pricePoint.pricePence, checkedAt: pricePoint.checkedAt })
		.from(pricePoint)
		.innerJoin(watch, eq(watch.id, pricePoint.watchId))
		.where(and(eq(watch.id, watchId), eq(watch.userId, userId)))
		.orderBy(desc(pricePoint.checkedAt), desc(pricePoint.id));
}

export type FailurePoint = { reason: string; message: string | null; checkedAt: Date };

/** The user's watch's failed checks, newest first; empty for another user's watch. */
export function failureHistory(db: Db, userId: string, watchId: string): Promise<FailurePoint[]> {
	return db
		.select({
			reason: checkFailure.reason,
			message: checkFailure.message,
			checkedAt: checkFailure.checkedAt
		})
		.from(checkFailure)
		.innerJoin(watch, eq(watch.id, checkFailure.watchId))
		.where(and(eq(watch.id, watchId), eq(watch.userId, userId)))
		.orderBy(desc(checkFailure.checkedAt), desc(checkFailure.id));
}
