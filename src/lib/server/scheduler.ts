// The in-process re-check scheduler (decisions in_process_scheduler, due_based_ticks):
// every tick runs one pass over the watches that are due, one check at a time.
// Nothing is scheduled per watch, so a restart loses nothing.
import { checkIntervalFromEnv, checkWatch, dueWatches, type DueWatch } from './checks.ts';
import { liveAfterFailure, liveAfterSuccess } from './alerts/live.ts';
import type { Db } from './db/client.ts';
import { formatError } from './error-log.ts';
import type { CheckResult } from './shops/types.ts';

export const TICK_MS = 5 * 60 * 1000;

export type SchedulerDeps = {
	/** The watches due at this moment, in the order to check them. */
	due(now: Date): Promise<DueWatch[]>;
	/** Checks and records one watch. May throw: that watch is logged and the pass goes on. */
	checkOne(watch: DueWatch): Promise<unknown>;
	now?: () => Date;
	log?: (message: string) => void;
};

export type Scheduler = {
	/** Starts a pass unless one is already running; returns it, or null when skipped. */
	tick(): Promise<void> | null;
	/** Ticks now and then every tickMs; returns a stop function. */
	start(): () => void;
};

export function createScheduler(deps: SchedulerDeps, tickMs = TICK_MS): Scheduler {
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? ((message) => console.error(`[scheduler] ${message}`));
	let running: Promise<void> | null = null;

	async function pass() {
		for (const watch of await deps.due(now())) {
			try {
				await deps.checkOne(watch);
			} catch (error) {
				log(`check of watch ${watch.id} failed: ${formatError(error)}`);
			}
		}
	}

	function tick() {
		// A slow pass (the client spaces requests by seconds) must not overlap the next.
		if (running !== null) return null;
		const current = pass()
			.catch((error) => log(`pass failed: ${formatError(error)}`))
			.finally(() => {
				running = null;
			});
		running = current;
		return current;
	}

	return {
		tick,
		start() {
			void tick();
			const handle = setInterval(() => void tick(), tickMs);
			return () => clearInterval(handle);
		}
	};
}

export type StartOptions = {
	env: Record<string, string | undefined>;
	building: boolean;
	db: Db;
	/** One live check through the shared rate-limited client. */
	check(url: string): Promise<CheckResult>;
};

/**
 * Starts the scheduler for the running server, or returns null when it must not
 * run: during a build, under Vitest, or with SCHEDULER_DISABLED=1 (e2e), so no
 * test can trigger a live check (r-01). An invalid CHECK_INTERVAL_HOURS throws.
 */
export function startScheduler({ env, building, db, check }: StartOptions): (() => void) | null {
	if (building || env.VITEST !== undefined || env.SCHEDULER_DISABLED === '1') return null;
	const intervalMs = checkIntervalFromEnv(env);
	return createScheduler({
		due: (now) => dueWatches(db, now, intervalMs),
		// A scheduled check can send its owner a price-drop or failed-check alert.
		checkOne: (watch) =>
			checkWatch(db, watch, {
				check,
				afterSuccess: liveAfterSuccess(db),
				afterFailure: liveAfterFailure(db)
			})
	}).start();
}
