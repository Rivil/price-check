// A watch's checks as the watch page shows them: one timeline, the price stats and
// the chart's input. Every time and tooltip string is built here, on the server, so
// the page reads the same whatever the viewer's timezone.
import type { ChartInput } from './chart.ts';
import { formatPence } from './money.ts';
import { failureLabel, formatCheckedAt } from './watch-view.ts';

export type PriceCheck = { pricePence: number; checkedAt: Date };
export type FailedCheck = { reason: string; message: string | null; checkedAt: Date };

export type TimelineRow =
	| { kind: 'price'; checkedAt: string; price: string }
	| { kind: 'failure'; checkedAt: string; reason: string };

export type PriceStats = {
	lowest: string;
	highest: string;
	average: string;
	/** Null when the first price was 0, which no percentage can start from. */
	change: string | null;
};

/** 'Blocked by Amazon — captcha page', or the label alone with no message. */
function failureText({ reason, message }: FailedCheck) {
	const label = failureLabel(reason);
	return message ? `${label} — ${message}` : label;
}

/** Every check, newest first (decision failure_reasons). */
export function timeline(points: PriceCheck[], failures: FailedCheck[]): TimelineRow[] {
	const dated = [
		...points.map((point) => {
			const row: TimelineRow = {
				kind: 'price',
				checkedAt: formatCheckedAt(point.checkedAt),
				price: formatPence(point.pricePence)
			};
			return { at: point.checkedAt.getTime(), row };
		}),
		...failures.map((failure) => {
			const row: TimelineRow = {
				kind: 'failure',
				checkedAt: formatCheckedAt(failure.checkedAt),
				reason: failureText(failure)
			};
			return { at: failure.checkedAt.getTime(), row };
		})
	];
	return dated.sort((a, b) => b.at - a.at).map(({ row }) => row);
}

function percentChange(first: number, latest: number) {
	if (first === 0) return null;
	const percent = (((latest - first) / first) * 100).toFixed(1);
	// A change too small to show is no change, not '-0.0%'.
	if (Number(percent) === 0) return '0.0%';
	return `${latest > first ? '+' : ''}${percent}%`;
}

/** Ever-values over every price, whatever the chart's range (decision chart_range). */
export function priceStats(points: PriceCheck[]): PriceStats | null {
	if (points.length === 0) return null;

	const prices = [...points]
		.sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime())
		.map((point) => point.pricePence);
	const total = prices.reduce((sum, price) => sum + price, 0);

	return {
		lowest: formatPence(Math.min(...prices)),
		highest: formatPence(Math.max(...prices)),
		// formatPence takes whole pence.
		average: formatPence(Math.round(total / prices.length)),
		change: percentChange(prices[0], prices[prices.length - 1])
	};
}

export function chartInput(
	points: PriceCheck[],
	failures: FailedCheck[],
	targetPence: number | null,
	now: Date
): ChartInput {
	return {
		points: points.map(({ pricePence, checkedAt }) => ({
			at: checkedAt.getTime(),
			pricePence,
			label: `${formatPence(pricePence)} · ${formatCheckedAt(checkedAt)}`
		})),
		failures: failures.map((failure) => ({
			at: failure.checkedAt.getTime(),
			label: `Failed: ${failureText(failure)} · ${formatCheckedAt(failure.checkedAt)}`
		})),
		targetPence,
		now: now.getTime()
	};
}
