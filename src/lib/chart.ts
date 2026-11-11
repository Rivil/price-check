// The price chart as numbers: where each mark sits, for a chosen range. Pure, so
// every rule is tested here and the component only draws the result. Times and
// labels arrive prebuilt: the server formats them, so no viewer's clock or timezone
// reaches the chart.

const DAY_MS = 24 * 60 * 60 * 1000;

// Positions are percentages of the plot. Failures have no price, so they sit on
// their own baseline below the price area instead of breaking into the line.
const PRICE_TOP = 5;
const PRICE_BOTTOM = 85;
const FAILURE_Y = 95;

export const RANGES = [
	{ id: '30d', label: '30 days', ms: 30 * DAY_MS },
	{ id: '90d', label: '90 days', ms: 90 * DAY_MS },
	{ id: 'all', label: 'All time', ms: null }
] as const;

export type ChartRange = (typeof RANGES)[number]['id'];

export const DEFAULT_RANGE: ChartRange = 'all';

export type ChartPoint = { at: number; pricePence: number; label: string };
export type ChartFailure = { at: number; label: string };

export type ChartInput = {
	points: ChartPoint[];
	failures: ChartFailure[];
	targetPence: number | null;
	now: number;
};

export type ChartMark = {
	kind: 'price' | 'failure';
	at: number;
	x: number;
	y: number;
	label: string;
};

export type ChartView = {
	/** SVG path through the price marks, left to right; '' with none. */
	line: string;
	/** In time order, so stepping through them never skips a failure. */
	marks: ChartMark[];
	targetY: number | null;
	/** Nothing to mark in this range. */
	empty: boolean;
};

function round(value: number) {
	return Math.round(value * 100) / 100;
}

function linePath(marks: ChartMark[]) {
	return marks
		.map((mark, i) => `${i === 0 ? 'M' : 'L'}${round(mark.x)} ${round(mark.y)}`)
		.join(' ');
}

export function chartView(input: ChartInput, range: ChartRange): ChartView {
	const { now, targetPence } = input;
	const windowMs = RANGES.find((r) => r.id === range)?.ms ?? null;
	const inRange = ({ at }: { at: number }) => windowMs === null || at >= now - windowMs;
	const points = input.points.filter(inRange);
	const failures = input.failures.filter(inRange);

	// A stamp past `now` stretches the domain, so a clock skew can't push it off the plot.
	const times = [...points, ...failures].map((mark) => mark.at);
	const from = windowMs === null ? Math.min(...times) : now - windowMs;
	const to = Math.max(now, ...times);
	const toX = (at: number) => (to === from ? 100 : ((at - from) / (to - from)) * 100);

	// Failures carry no price, and a target off the data's scale must stay on the plot.
	const prices = points.map((point) => point.pricePence);
	if (targetPence !== null) prices.push(targetPence);
	const low = Math.min(...prices);
	const high = Math.max(...prices);
	const toY = (pence: number) =>
		high === low
			? (PRICE_TOP + PRICE_BOTTOM) / 2
			: PRICE_TOP + ((high - pence) / (high - low)) * (PRICE_BOTTOM - PRICE_TOP);

	const priceMarks = points
		.map(({ at, pricePence, label }): ChartMark => {
			return { kind: 'price', at, x: toX(at), y: toY(pricePence), label };
		})
		.sort((a, b) => a.at - b.at);
	const failureMarks = failures.map(({ at, label }): ChartMark => {
		return { kind: 'failure', at, x: toX(at), y: FAILURE_Y, label };
	});
	const marks = [...priceMarks, ...failureMarks].sort((a, b) => a.at - b.at);

	return {
		line: linePath(priceMarks),
		marks,
		targetY: targetPence === null ? null : toY(targetPence),
		empty: marks.length === 0
	};
}

/** The mark index a key moves to, stopping at the ends; null for any other key. */
export function nextMark(index: number, key: string, count: number): number | null {
	switch (key) {
		case 'ArrowRight':
			return Math.min(index + 1, count - 1);
		case 'ArrowLeft':
			return Math.max(index - 1, 0);
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}

/**
 * The index of the mark closest to a position in a plot rendered at width x height
 * pixels; null with no marks. Measured in pixels, not percentages, because the plot
 * is far wider than it is tall.
 */
export function nearestMark(
	marks: ChartMark[],
	x: number,
	y: number,
	width: number,
	height: number
): number | null {
	let nearest: number | null = null;
	let shortest = Infinity;
	marks.forEach((mark, index) => {
		const distance = Math.hypot((mark.x / 100) * width - x, (mark.y / 100) * height - y);
		if (distance < shortest) {
			shortest = distance;
			nearest = index;
		}
	});
	return nearest;
}
