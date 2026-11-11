import { describe, expect, it } from 'vitest';
import {
	chartView,
	DEFAULT_RANGE,
	nearestMark,
	nextMark,
	RANGES,
	type ChartFailure,
	type ChartInput,
	type ChartMark,
	type ChartPoint
} from './chart.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);
const NOW = T0 + 200 * DAY;

const point = (at: number, pricePence = 1000): ChartPoint => ({
	at,
	pricePence,
	label: `price ${at}`
});
const failure = (at: number): ChartFailure => ({ at, label: `failed ${at}` });

const input = (overrides: Partial<ChartInput>): ChartInput => ({
	points: [],
	failures: [],
	targetPence: null,
	now: NOW,
	...overrides
});

/** The path's coordinates as [x, y] pairs. */
const pathCoords = (line: string) =>
	[...line.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

const finite = (marks: ChartMark[]) =>
	marks.every((mark) => Number.isFinite(mark.x) && Number.isFinite(mark.y));

const ids = (marks: ChartMark[]) => marks.map((mark) => mark.label);

describe('chartView', () => {
	it('time axis', () => {
		const view = chartView(
			input({ points: [point(T0), point(T0 + DAY), point(T0 + 9 * DAY)], now: T0 + 9 * DAY }),
			'all'
		);

		expect(view.marks[0].x).toBe(0);
		expect(view.marks[1].x).toBeCloseTo(11.1, 1);
		expect(view.marks[2].x).toBe(100);
	});

	it('one mark per check', () => {
		const view = chartView(
			input({ points: [point(T0), point(T0 + DAY), point(T0 + 2 * DAY)] }),
			'all'
		);

		expect(view.marks).toHaveLength(3);
		expect(view.marks.every((mark) => mark.kind === 'price')).toBe(true);
		expect(view.empty).toBe(false);
	});

	it('order', () => {
		const view = chartView(
			input({
				points: [point(T0 + 2 * DAY, 3000), point(T0 + DAY, 2000), point(T0, 1000)],
				now: T0 + 2 * DAY
			}),
			'all'
		);

		expect(view.line).toMatch(/^M/);
		const xs = pathCoords(view.line).map(([x]) => x);
		expect(xs).toEqual([0, 50, 100]);
		expect(ids(view.marks)).toEqual([T0, T0 + DAY, T0 + 2 * DAY].map((at) => `price ${at}`));
	});

	describe('price scale', () => {
		const points = [point(T0, 1000), point(T0 + DAY, 1500), point(T0 + 2 * DAY, 2000)];
		const ys = (targetPence: number | null) =>
			chartView(input({ points, targetPence }), 'all').marks.map((mark) => mark.y);

		it('spans the plot from the lowest price to the highest', () => {
			expect(ys(null)).toEqual([85, 45, 5]);
		});

		it('a target outside the prices widens the scale', () => {
			const [low, middle, high] = ys(500);

			expect(low).toBeCloseTo(58.33);
			expect(middle).toBeCloseTo(31.67);
			expect(high).toBe(5);
		});

		it('draws one line through the marks', () => {
			const view = chartView(input({ points, now: T0 + 2 * DAY }), 'all');

			expect(view.line.match(/[ML]/g)).toEqual(['M', 'L', 'L']);
			expect(pathCoords(view.line)).toEqual([
				[0, 85],
				[50, 45],
				[100, 5]
			]);
		});
	});

	describe('degenerate', () => {
		it('one point', () => {
			const view = chartView(input({ points: [point(T0)] }), 'all');

			expect(finite(view.marks)).toBe(true);
			expect(pathCoords(view.line).flat().every(Number.isFinite)).toBe(true);
			expect(view.line).not.toMatch(/NaN|Infinity/);
		});

		it('flat price', () => {
			const view = chartView(input({ points: [point(T0), point(T0 + DAY)] }), 'all');

			expect(finite(view.marks)).toBe(true);
			expect(view.marks[0].y).toBe(view.marks[1].y);
			expect(view.marks[0].y).toBeGreaterThan(0);
			expect(view.marks[0].y).toBeLessThan(100);
		});

		it('first check is now', () => {
			const view = chartView(input({ points: [point(NOW)] }), 'all');

			expect(view.marks).toHaveLength(1);
			expect(view.marks[0].x).toBe(100);
			expect(finite(view.marks)).toBe(true);
		});
	});

	describe('target', () => {
		it.each([
			['far above', 10_000_000],
			['far below', 1]
		])('%s every price', (_, targetPence) => {
			const view = chartView(
				input({ points: [point(T0, 1000), point(T0 + DAY, 2000)], targetPence }),
				'all'
			);

			expect(view.targetY).toBeGreaterThanOrEqual(0);
			expect(view.targetY).toBeLessThanOrEqual(100);
			for (const mark of view.marks) {
				expect(mark.y).toBeGreaterThanOrEqual(0);
				expect(mark.y).toBeLessThanOrEqual(100);
			}
		});

		it('sits at its price on the scale', () => {
			const view = chartView(
				input({ points: [point(T0, 1000), point(T0 + DAY, 2000)], targetPence: 1500 }),
				'all'
			);

			const [low, high] = [view.marks[0].y, view.marks[1].y];
			expect(view.targetY).toBeCloseTo((low + high) / 2);
			expect(high).toBeLessThan(low);
		});

		it('null target', () => {
			expect(chartView(input({ points: [point(T0)] }), 'all').targetY).toBeNull();
		});
	});

	describe('failures', () => {
		it('consecutive failures keep their own place on one baseline', () => {
			const view = chartView(
				input({
					points: [point(T0, 1000), point(T0 + 3 * DAY, 2000)],
					failures: [failure(T0 + DAY), failure(T0 + 2 * DAY)],
					now: T0 + 3 * DAY
				}),
				'all'
			);

			const failed = view.marks.filter((mark) => mark.kind === 'failure');
			expect(failed[0].x).toBeCloseTo(100 / 3);
			expect(failed[1].x).toBeCloseTo(200 / 3);
			expect(failed[0].y).toBe(failed[1].y);
			const prices = view.marks.filter((mark) => mark.kind === 'price');
			expect(failed[0].y).toBeGreaterThan(Math.max(...prices.map((mark) => mark.y)));
			expect(failed[0].y).toBeLessThanOrEqual(100);
		});

		it('stay out of the line', () => {
			const view = chartView(
				input({
					points: [point(T0, 1000), point(T0 + 3 * DAY, 2000)],
					failures: [failure(T0 + DAY)],
					now: T0 + 3 * DAY
				}),
				'all'
			);

			expect(pathCoords(view.line).map(([x]) => x)).toEqual([0, 100]);
		});

		it('five inside one pixel stay five marks', () => {
			const view = chartView(
				input({
					points: [point(T0)],
					failures: [1, 2, 3, 4, 5].map((ms) => failure(NOW - ms))
				}),
				'all'
			);

			expect(view.marks.filter((mark) => mark.kind === 'failure')).toHaveLength(5);
		});
	});

	it('failure before first point', () => {
		const view = chartView(
			input({
				points: [point(T0 + 5 * DAY)],
				failures: [failure(T0)],
				now: T0 + 10 * DAY
			}),
			'all'
		);

		expect(view.marks.map((mark) => [mark.kind, mark.x])).toEqual([
			['failure', 0],
			['price', 50]
		]);
	});

	describe('window', () => {
		it.each([
			['30d', 30],
			['90d', 90]
		] as const)('%s keeps its edge and drops anything older', (range, days) => {
			const edge = NOW - days * DAY;

			const points = chartView(input({ points: [point(edge), point(edge - 1)] }), range);
			expect(ids(points.marks)).toEqual([`price ${edge}`]);
			expect(points.marks[0].x).toBe(0);

			const failures = chartView(input({ failures: [failure(edge), failure(edge - 1)] }), range);
			expect(ids(failures.marks)).toEqual([`failed ${edge}`]);
		});

		it.each([
			['30d', 30],
			['90d', 90]
		] as const)('%s domain is the whole window, not the data', (range, days) => {
			const view = chartView(input({ points: [point(NOW - 2 * DAY), point(NOW)] }), range);

			expect(view.marks[0].x).toBeCloseTo(100 - (2 / days) * 100);
			expect(view.marks[1].x).toBe(100);
		});
	});

	it('rescale', () => {
		const points = [point(NOW - 100 * DAY, 90_000), point(NOW - 2 * DAY, 1000), point(NOW, 2000)];
		const view = chartView(input({ points, failures: [failure(NOW - DAY)] }), '30d');
		const [low, high] = view.marks.filter((mark) => mark.kind === 'price');

		// Only the two points in the window set the scale, so they span the price area.
		const spanning = chartView(input({ points: points.slice(1) }), 'all');
		expect(low.y).toBe(spanning.marks[0].y);
		expect(high.y).toBe(spanning.marks[1].y);

		const withTarget = chartView(input({ points, targetPence: 500 }), '30d');
		expect(withTarget.marks[0].y).not.toBe(low.y);
		expect(withTarget.targetY).toBeGreaterThan(withTarget.marks[0].y);
	});

	it('all time', () => {
		const view = chartView(
			input({
				points: [point(T0), point(T0 + 50 * DAY)],
				failures: [failure(T0 + 100 * DAY)],
				now: T0 + 200 * DAY
			}),
			'all'
		);

		expect(view.marks.map((mark) => mark.x)).toEqual([0, 25, 50]);

		const pastNow = chartView(input({ points: [point(T0), point(T0 + 10 * DAY)], now: T0 }), 'all');
		expect(pastNow.marks.map((mark) => mark.x)).toEqual([0, 100]);
	});

	it('sparse range', () => {
		const view = chartView(
			input({ points: [point(T0)], failures: [failure(NOW - DAY)], targetPence: 900 }),
			'30d'
		);

		expect(view.empty).toBe(false);
		expect(view.line).toBe('');
		expect(view.marks).toHaveLength(1);
		expect(finite(view.marks)).toBe(true);
		expect(Number.isFinite(view.targetY)).toBe(true);
	});

	it('empty window', () => {
		const view = chartView(input({ points: [point(T0)], targetPence: 900 }), '30d');

		expect(view.empty).toBe(true);
		expect(view.marks).toEqual([]);
		expect(view.line).toBe('');
		expect(Number.isFinite(view.targetY)).toBe(true);

		const noTarget = chartView(input({ points: [point(T0)] }), '30d');
		expect(noTarget.empty).toBe(true);
		expect(noTarget.targetY).toBeNull();
	});

	it.each(RANGES.map((range) => range.id))('future stamp in %s', (range) => {
		const view = chartView(
			input({
				points: [point(NOW - DAY), point(NOW + DAY)],
				failures: [failure(NOW + 2 * DAY)]
			}),
			range
		);

		expect(view.marks).toHaveLength(3);
		for (const mark of view.marks) {
			expect(mark.x).toBeGreaterThanOrEqual(0);
			expect(mark.x).toBeLessThanOrEqual(100);
		}
	});

	it('default', () => {
		expect(DEFAULT_RANGE).toBe('all');
		expect(RANGES.map((range) => range.label)).toEqual(['30 days', '90 days', 'All time']);
	});
});

describe('nextMark', () => {
	it('keys', () => {
		expect(nextMark(1, 'ArrowRight', 3)).toBe(2);
		expect(nextMark(2, 'ArrowRight', 3)).toBe(2);
		expect(nextMark(2, 'ArrowLeft', 3)).toBe(1);
		expect(nextMark(1, 'ArrowLeft', 3)).toBe(0);
		expect(nextMark(0, 'ArrowLeft', 3)).toBe(0);
		expect(nextMark(1, 'Home', 3)).toBe(0);
		expect(nextMark(1, 'End', 3)).toBe(2);
		expect(nextMark(1, 'Enter', 3)).toBeNull();
		expect(nextMark(1, 'ArrowUp', 3)).toBeNull();
	});

	it('keys step onto a failure between two points', () => {
		const { marks } = chartView(
			input({ points: [point(T0), point(T0 + 2 * DAY)], failures: [failure(T0 + DAY)] }),
			'all'
		);

		const next = nextMark(0, 'ArrowRight', marks.length);
		expect(marks[next as number].kind).toBe('failure');
	});
});

describe('nearestMark', () => {
	const mark = (x: number, y: number, kind: ChartMark['kind'] = 'price'): ChartMark => ({
		kind,
		at: 0,
		x,
		y,
		label: ''
	});

	it('nearest by rendered distance', () => {
		const marks = [mark(10, 50), mark(50, 50), mark(90, 50)];

		expect(nearestMark(marks, 25, 25, 100, 50)).toBe(0);
		expect(nearestMark(marks, 60, 25, 100, 50)).toBe(1);
		expect(nearestMark(marks, 99, 0, 100, 50)).toBe(2);
	});

	it('nearest measures pixels, not percentages', () => {
		// 10% apart either way, but the plot is 10x wider than tall.
		const marks = [mark(50, 40), mark(60, 50)];

		expect(nearestMark(marks, 500, 50, 1000, 100)).toBe(0);
		expect(nearestMark(marks, 600, 40, 1000, 100)).toBe(1);
	});

	it('nearest prefers a failure on its baseline over a price with a closer x', () => {
		const marks = [mark(50, 20), mark(52, 95, 'failure')];

		expect(nearestMark(marks, 170, 190, 340, 200)).toBe(1);
	});

	it('nearest reaches both ends of 1,460 marks', () => {
		const marks = Array.from({ length: 1460 }, (_, i) => mark((i / 1459) * 100, 50));

		expect(nearestMark(marks, 0, 100, 340, 200)).toBe(0);
		expect(nearestMark(marks, 340, 100, 340, 200)).toBe(1459);
	});

	it('nearest with no marks', () => {
		expect(nearestMark([], 10, 10, 340, 200)).toBeNull();
	});
});
