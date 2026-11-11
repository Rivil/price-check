import { describe, expect, it } from 'vitest';
import { chartInput, priceStats, timeline, type FailedCheck } from './watch-history.ts';

const at = (time: string) => new Date(`2026-11-01T${time}:00Z`);
const price = (pricePence: number, time = '09:00') => ({ pricePence, checkedAt: at(time) });
const failed = (time: string, overrides: Partial<FailedCheck> = {}): FailedCheck => ({
	reason: 'blocked',
	message: 'captcha page',
	checkedAt: at(time),
	...overrides
});

describe('timeline', () => {
	it('interleave', () => {
		const rows = timeline(
			[price(1000, '09:00'), price(2000, '12:00')],
			[failed('10:00'), failed('11:00')]
		);

		expect(rows).toEqual([
			{ kind: 'price', checkedAt: '1 Nov 2026, 12:00', price: '£20.00' },
			{ kind: 'failure', checkedAt: '1 Nov 2026, 11:00', reason: expect.any(String) },
			{ kind: 'failure', checkedAt: '1 Nov 2026, 10:00', reason: expect.any(String) },
			{ kind: 'price', checkedAt: '1 Nov 2026, 09:00', price: '£10.00' }
		]);
	});

	it('same millisecond', () => {
		const points = [price(1000, '09:00')];
		const failures = [failed('09:00', { reason: 'unavailable' }), failed('09:00')];

		const rows = timeline(points, failures);

		expect(rows.map((row) => row.kind)).toEqual(['price', 'failure', 'failure']);
		expect(rows[1]).toMatchObject({ reason: 'Currently unavailable — captcha page' });
		expect(rows[2]).toMatchObject({ reason: 'Blocked by Amazon — captcha page' });
		expect(timeline(points, failures)).toEqual(rows);
	});

	it('reason', () => {
		const [withMessage, noMessage, emptyMessage] = timeline(
			[],
			[failed('12:00'), failed('11:00', { message: null }), failed('10:00', { message: '' })]
		);

		expect(withMessage).toMatchObject({ reason: 'Blocked by Amazon — captcha page' });
		expect(noMessage).toMatchObject({ reason: 'Blocked by Amazon' });
		expect(emptyMessage).toMatchObject({ reason: 'Blocked by Amazon' });
	});

	it('no checks', () => {
		expect(timeline([], [])).toEqual([]);
	});
});

describe('priceStats', () => {
	it('low high', () => {
		const stats = priceStats([price(1000, '09:00'), price(800, '10:00'), price(1200, '11:00')]);

		expect(stats).toMatchObject({ lowest: '£8.00', highest: '£12.00', average: '£10.00' });
	});

	it('average', () => {
		// A mean of 900.5 pence, which formatPence would print as '£9.0.5'.
		expect(priceStats([price(1000, '09:00'), price(801, '10:00')])?.average).toBe('£9.01');
	});

	it('change base', () => {
		const newestFirst = [price(1500, '12:00'), price(1200, '10:00'), price(1000, '09:00')];

		expect(priceStats(newestFirst)?.change).toBe('+50.0%');
	});

	it('change signs', () => {
		const change = (first: number, latest: number) =>
			priceStats([price(first, '09:00'), price(latest, '10:00')])?.change;

		expect(change(1000, 750)).toBe('-25.0%');
		expect(change(1000, 1000)).toBe('0.0%');
		expect(priceStats([price(1000)])?.change).toBe('0.0%');
		expect(change(1_000_000, 999_999)).toBe('0.0%');
		expect(change(1_000_000, 1_000_001)).toBe('0.0%');
	});

	it('percent edges', () => {
		const stats = priceStats([price(0, '09:00'), price(1000, '10:00')]);

		expect(stats?.change).toBeNull();
		expect(stats?.lowest).toBe('£0.00');
	});

	it('no prices', () => {
		expect(priceStats([])).toBeNull();
	});
});

describe('chartInput', () => {
	const now = at('13:00');

	it('tooltips', () => {
		const input = chartInput([price(1999, '09:30')], [failed('10:30')], null, now);

		expect(input.points[0].label).toBe('£19.99 · 1 Nov 2026, 09:30');
		expect(input.failures[0].label).toBe(
			'Failed: Blocked by Amazon — captcha page · 1 Nov 2026, 10:30'
		);
	});

	it('carries the numbers the chart draws from', () => {
		const input = chartInput([price(1999, '09:30')], [failed('10:30')], 1500, now);

		expect(input).toMatchObject({
			points: [{ at: at('09:30').getTime(), pricePence: 1999 }],
			failures: [{ at: at('10:30').getTime() }],
			targetPence: 1500,
			now: now.getTime()
		});
	});

	it('uk time', () => {
		const summer = { pricePence: 100, checkedAt: new Date('2026-07-15T23:05:00Z') };

		expect(chartInput([summer], [], null, now).points[0].label).toContain('16 Jul 2026, 00:05');
	});
});
