// How a stored watch reads on a page: one view shape for the watchlist and the
// watch page, built on the server so dates render the same for every viewer.
import { formatPence } from './money.ts';

export type WatchRow = {
	id: string;
	canonicalUrl: string;
	title: string | null;
	imageUrl: string | null;
	pricePence: number | null;
	targetPence: number | null;
	lastCheckedAt: Date | null;
	lastCheckReason: string | null;
	lastCheckMessage: string | null;
};

export type WatchView = {
	id: string;
	/** The product title, or its canonical URL until a check has named it. */
	label: string;
	canonicalUrl: string;
	imageUrl: string | null;
	price: string | null;
	target: string | null;
	checkedAt: string | null;
	/** Set when the last check failed. */
	failure: { reason: string; label: string; message: string } | null;
	/** The latest check succeeded with a price at or below a set target. */
	atOrBelowTarget: boolean;
};

const REASON_LABELS: Record<string, string> = {
	blocked: 'Blocked by Amazon',
	unavailable: 'Currently unavailable',
	parse_failed: "Couldn't read the page",
	fetch_failed: "Couldn't reach Amazon",
	not_found: 'Page not found',
	variant_required: 'Pick a size or colour',
	unsupported: 'Unsupported link'
};

/** A 5-minute tick at ~6s spacing takes about 30 minutes to clear 300 due watches. */
export const OVERDUE_GRACE_MS = 60 * 60 * 1000;

const CHECKED_AT = new Intl.DateTimeFormat('en-GB', {
	dateStyle: 'medium',
	timeStyle: 'short',
	timeZone: 'Europe/London'
});

/** '1 Nov 2026, 09:30' in UK time. */
export function formatCheckedAt(at: Date): string {
	return CHECKED_AT.format(at);
}

/** A failure reason as a person reads it; an unknown reason stays as stored. */
export function failureLabel(reason: string): string {
	return REASON_LABELS[reason] ?? reason;
}

export type CheckStatus = {
	text: string;
	overdue: boolean;
	failed: boolean;
	/** When the scheduler next counts this watch as due; null before its first check. */
	nextDueAt: Date | null;
};

/**
 * What a card says about its checks. Next due is the scheduler's own sum (dueWatches),
 * and a check only reads as overdue past the grace (decision overdue_grace).
 */
export function checkStatus(
	row: Pick<WatchRow, 'lastCheckedAt' | 'lastCheckReason'>,
	now: Date,
	intervalMs: number
): CheckStatus {
	const { lastCheckedAt, lastCheckReason: reason } = row;
	const nextDueAt = lastCheckedAt && new Date(lastCheckedAt.getTime() + intervalMs);
	const overdue = nextDueAt !== null && now.getTime() > nextDueAt.getTime() + OVERDUE_GRACE_MS;

	let schedule = 'Not checked yet';
	if (lastCheckedAt && nextDueAt) {
		const next = overdue ? 'next check overdue, was due' : 'next check due';
		schedule = `Checked ${formatCheckedAt(lastCheckedAt)} · ${next} ${formatCheckedAt(nextDueAt)}`;
	}

	return {
		text: reason === null ? schedule : `Last check failed: ${failureLabel(reason)} · ${schedule}`,
		overdue,
		failed: reason !== null,
		nextDueAt
	};
}

/** True only for a successful latest check whose price is at or below a set target. */
export function isAtOrBelowTarget(
	row: Pick<WatchRow, 'pricePence' | 'targetPence' | 'lastCheckReason'>
): boolean {
	return (
		row.lastCheckReason === null &&
		row.pricePence !== null &&
		row.targetPence !== null &&
		row.pricePence <= row.targetPence
	);
}

export function toWatchView(row: WatchRow): WatchView {
	const reason = row.lastCheckReason;
	return {
		id: row.id,
		label: row.title ?? row.canonicalUrl,
		canonicalUrl: row.canonicalUrl,
		imageUrl: row.imageUrl,
		price: row.pricePence === null ? null : formatPence(row.pricePence),
		target: row.targetPence === null ? null : formatPence(row.targetPence),
		checkedAt: row.lastCheckedAt === null ? null : formatCheckedAt(row.lastCheckedAt),
		failure:
			reason === null
				? null
				: {
						reason,
						label: failureLabel(reason),
						message: row.lastCheckMessage ?? ''
					},
		atOrBelowTarget: isAtOrBelowTarget(row)
	};
}
