import { describe, expect, it } from 'vitest';
import { sparkline, SPARKLINE_WINDOW_MS } from './sparkline.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-02T12:00:00.000Z');
const daysAgo = (days: number, pricePence = 1000) => ({
	pricePence,
	checkedAt: new Date(NOW.getTime() - days * DAY)
});

const xs = (path: string) => [...path.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));

describe('sparkline', () => {
	it('fixed window', () => {
		expect(SPARKLINE_WINDOW_MS).toBe(30 * DAY);

		expect(sparkline([daysAgo(15)], NOW)?.dot.x).toBe(50);

		// More points on the card don't move it: the domain isn't the data's extent.
		const crowded = sparkline([daysAgo(15), daysAgo(14), daysAgo(1)], NOW);
		expect(xs(crowded?.path ?? '')[0]).toBe(50);
	});

	it('one point', () => {
		const line = sparkline([daysAgo(3)], NOW);

		expect(line?.dot.x).toBe(90);
		expect(Number.isFinite(line?.dot.y)).toBe(true);
	});

	it('flat', () => {
		const line = sparkline([daysAgo(2), daysAgo(1)], NOW);

		expect(line?.dot.y).toBe(50);
		expect(line?.path).not.toMatch(/NaN|Infinity/);
	});

	it('no points', () => {
		expect(sparkline([], NOW)).toBeNull();
	});

	it('higher prices sit higher', () => {
		const line = sparkline([daysAgo(2, 2000), daysAgo(1, 1000)], NOW);

		expect(line?.path).toMatch(/^M\S+ 10 L\S+ 90$/);
	});

	it('order', () => {
		const shuffled = [daysAgo(10, 1000), daysAgo(1, 3000), daysAgo(20, 2000)];
		const line = sparkline(shuffled, NOW);

		expect(xs(line?.path ?? '').map(Math.round)).toEqual([33, 67, 97]);
		expect(line?.dot.x).toBeCloseTo((29 / 30) * 100);
		expect(line?.dot.y).toBe(10);

		const newestFirst = sparkline([daysAgo(1), daysAgo(5)], NOW);
		expect(newestFirst?.dot.x).toBeCloseTo((29 / 30) * 100);
	});

	it('leaves its input alone', () => {
		const points = [daysAgo(1), daysAgo(5)];

		sparkline(points, NOW);

		expect(points).toEqual([daysAgo(1), daysAgo(5)]);
	});
});
