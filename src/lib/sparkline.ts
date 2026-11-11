// A card's sparkline as numbers. The x domain is always the same 30 days, never the
// data's own extent, so cards stay comparable whatever their check interval
// (decision sparkline_window).

export const SPARKLINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Percentages of the drawing, with room so a stroke at either extreme isn't clipped.
const TOP = 10;
const BOTTOM = 90;

export type SparklinePoint = { pricePence: number; checkedAt: Date };

export type Sparkline = {
	/** SVG path, left to right. */
	path: string;
	/** The latest point. */
	dot: { x: number; y: number };
};

function round(value: number) {
	return Math.round(value * 100) / 100;
}

/** Draws points from the 30 days up to `now`; null with none. */
export function sparkline(points: SparklinePoint[], now: Date): Sparkline | null {
	if (points.length === 0) return null;

	const from = now.getTime() - SPARKLINE_WINDOW_MS;
	const prices = points.map((point) => point.pricePence);
	const low = Math.min(...prices);
	const high = Math.max(...prices);

	const coords = [...points]
		.sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime())
		.map(({ checkedAt, pricePence }) => ({
			x: ((checkedAt.getTime() - from) / SPARKLINE_WINDOW_MS) * 100,
			y: high === low ? 50 : TOP + ((high - pricePence) / (high - low)) * (BOTTOM - TOP)
		}));

	return {
		path: coords.map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`).join(' '),
		dot: coords[coords.length - 1]
	};
}
