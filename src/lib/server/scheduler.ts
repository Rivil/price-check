// The in-process re-check scheduler (decisions in_process_scheduler, due_based_ticks):
// every tick runs one pass over the watches that are due, one check at a time.
// Nothing is scheduled per watch, so a restart loses nothing.
import { checkIntervalFromEnv, checkWatch, dueWatches, type DueWatch } from './checks.ts';
import { liveAfterFailure, liveAfterSuccess } from './alerts/live.ts';
import type { Db } from './db/client.ts';
import { formatError } from './error-log.ts';
import type { CheckResult } from './shops/types.ts';

export const TICK_MS = 5 * 60 * 1000;

/** How long stop() waits for the pass in flight before giving up on it. */
export const STOP_DRAIN_MS = 5_000;

export type SchedulerDeps = {
	/** The watches due at this moment, in the order to check them. */
	due(now: Date): Promise<DueWatch[]>;
	/** Checks and records one watch. May throw: that watch is logged and the pass goes on. */
	checkOne(watch: DueWatch): Promise<unknown>;
	now?: () => Date;
	log?: (message: string) => void;
};

/** What the running app may do with its scheduler: the desktop main process drives these. */
export type SchedulerControls = {
	/**
	 * Runs a pass now if none is running, else queues exactly one follow-up pass to
	 * run when the current one ends (an OS resume must not be lost to the overlap guard).
	 */
	requestPass(): void;
	/**
	 * Clears the interval, drops any queued follow-up and waits for the pass in flight,
	 * at most drainMs: quit closes the database next, so it must not run under a pass.
	 */
	stop(drainMs?: number): Promise<void>;
};

export type Scheduler = SchedulerControls & {
	/** Starts a pass unless one is already running or the scheduler is stopped; returns it, or null when skipped. */
	tick(): Promise<void> | null;
	/** Ticks now and then every tickMs, until stop(). */
	start(): void;
};

export function createScheduler(deps: SchedulerDeps, tickMs = TICK_MS): Scheduler {
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? ((message) => console.error(`[scheduler] ${message}`));
	let running: Promise<void> | null = null;
	let followUp = false;
	let stopped = false;
	let interval: ReturnType<typeof setInterval> | null = null;

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
		if (stopped || running !== null) return null;
		const current = pass()
			.catch((error) => log(`pass failed: ${formatError(error)}`))
			.finally(() => {
				running = null;
				if (followUp) {
					followUp = false;
					void tick();
				}
			});
		running = current;
		return current;
	}

	return {
		tick,
		requestPass() {
			if (stopped) return;
			// One queued follow-up covers any number of requests: it reads the clock when it starts.
			if (tick() === null) followUp = true;
		},
		start() {
			void tick();
			interval = setInterval(() => void tick(), tickMs);
		},
		async stop(drainMs = STOP_DRAIN_MS) {
			stopped = true;
			followUp = false;
			if (interval !== null) clearInterval(interval);
			interval = null;
			const inFlight = running;
			if (inFlight === null) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const drained = await Promise.race([
				inFlight.then(() => true),
				new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), drainMs)))
			]);
			clearTimeout(timer);
			if (!drained) log(`stop: the pass in flight did not finish within ${drainMs}ms`);
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
export function startScheduler({
	env,
	building,
	db,
	check
}: StartOptions): SchedulerControls | null {
	if (building || env.VITEST !== undefined || env.SCHEDULER_DISABLED === '1') return null;
	const intervalMs = checkIntervalFromEnv(env);
	const scheduler = createScheduler({
		due: (now) => dueWatches(db, now, intervalMs),
		// A scheduled check can send its owner a price-drop or failed-check alert.
		checkOne: (watch) =>
			checkWatch(db, watch, {
				check,
				afterSuccess: liveAfterSuccess(db),
				afterFailure: liveAfterFailure(db)
			})
	});
	scheduler.start();
	return { requestPass: scheduler.requestPass, stop: scheduler.stop };
}
