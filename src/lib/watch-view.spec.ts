import { describe, expect, it } from 'vitest';
import {
	checkStatus,
	failureLabel,
	formatCheckedAt,
	isAtOrBelowTarget,
	OVERDUE_GRACE_MS,
	toWatchView,
	type WatchRow
} from './watch-view.ts';

const base: WatchRow = {
	id: 'w1',
	canonicalUrl: 'https://www.amazon.co.uk/dp/B0ABC12345',
	title: 'A Product',
	imageUrl: 'https://img.example/a.jpg',
	pricePence: 129900,
	targetPence: 99900,
	lastCheckedAt: new Date('2026-11-01T09:30:00Z'),
	lastCheckReason: null,
	lastCheckMessage: null
};

describe('toWatchView', () => {
	it('priced watch', () => {
		expect(toWatchView(base)).toStrictEqual({
			id: 'w1',
			label: 'A Product',
			canonicalUrl: 'https://www.amazon.co.uk/dp/B0ABC12345',
			imageUrl: 'https://img.example/a.jpg',
			price: '£1,299.00',
			target: '£999.00',
			checkedAt: '1 Nov 2026, 09:30',
			failure: null,
			atOrBelowTarget: false
		});
	});

	it('failed, untitled watch', () => {
		const view = toWatchView({
			...base,
			title: null,
			imageUrl: null,
			pricePence: null,
			targetPence: null,
			lastCheckReason: 'blocked',
			lastCheckMessage: 'captcha page'
		});
		expect(view).toMatchObject({
			label: 'https://www.amazon.co.uk/dp/B0ABC12345',
			imageUrl: null,
			price: null,
			target: null,
			failure: { reason: 'blocked', label: 'Blocked by Amazon', message: 'captcha page' }
		});
	});

	it('reason labels', () => {
		for (const [reason, label] of [
			['blocked', 'Blocked by Amazon'],
			['unavailable', 'Currently unavailable'],
			['parse_failed', "Couldn't read the page"],
			['fetch_failed', "Couldn't reach Amazon"],
			['not_found', 'Page not found'],
			['variant_required', 'Pick a size or colour'],
			['unsupported', 'Unsupported link'],
			['something_new', 'something_new']
		]) {
			const view = toWatchView({ ...base, lastCheckReason: reason, lastCheckMessage: null });
			expect(view.failure, reason).toStrictEqual({ reason, label, message: '' });
		}
	});

	it('never checked', () => {
		expect(toWatchView({ ...base, lastCheckedAt: null }).checkedAt).toBeNull();
	});
});

describe('at or below target', () => {
	const ok = { lastCheckReason: null, lastCheckMessage: null };
	it.each([
		['price == target', { ...ok, pricePence: 2500, targetPence: 2500 }, true],
		['price < target', { ...ok, pricePence: 1999, targetPence: 2500 }, true],
		['price > target', { ...ok, pricePence: 2501, targetPence: 2500 }, false],
		['no price', { ...ok, pricePence: null, targetPence: 2500 }, false],
		['no target', { ...ok, pricePence: 1999, targetPence: null }, false],
		['price 0, no target', { ...ok, pricePence: 0, targetPence: null }, false],
		['price 0, target 0', { ...ok, pricePence: 0, targetPence: 0 }, true],
		[
			'latest check failed (kept price below target)',
			{ pricePence: 1999, targetPence: 2500, lastCheckReason: 'blocked', lastCheckMessage: 'x' },
			false
		]
	])('%s -> %s', (_name, fields, expected) => {
		expect(isAtOrBelowTarget(fields)).toBe(expected);
		expect(toWatchView({ ...base, ...fields }).atOrBelowTarget).toBe(expected);
	});
});

describe('formatCheckedAt', () => {
	it('uses UK time', () => {
		// GMT in winter, BST (UTC+1) in summer.
		expect(formatCheckedAt(new Date('2026-01-15T23:05:00Z'))).toBe('15 Jan 2026, 23:05');
		expect(formatCheckedAt(new Date('2026-07-15T23:05:00Z'))).toBe('16 Jul 2026, 00:05');
	});
});

describe('failureLabel', () => {
	it('labels a known reason and keeps an unknown one', () => {
		expect(failureLabel('blocked')).toBe('Blocked by Amazon');
		expect(failureLabel('something_new')).toBe('something_new');
	});
});

describe('checkStatus', () => {
	const HOUR = 60 * 60 * 1000;
	const checkedAt = new Date('2026-11-01T09:30:00Z');
	const row = { lastCheckedAt: checkedAt, lastCheckReason: null };
	const after = (ms: number) => new Date(checkedAt.getTime() + ms);

	it('status', () => {
		expect(checkStatus(row, new Date('2026-11-01T10:00:00Z'), 6 * HOUR)).toStrictEqual({
			text: 'Checked 1 Nov 2026, 09:30 · next check due 1 Nov 2026, 15:30',
			overdue: false,
			failed: false,
			nextDueAt: new Date('2026-11-01T15:30:00Z')
		});
	});

	it.each([6, 168])('overdue boundary at %ih', (hours) => {
		const interval = hours * HOUR;
		expect(OVERDUE_GRACE_MS).toBe(HOUR);

		const atEdge = checkStatus(row, after(interval + HOUR), interval);
		expect(atEdge.overdue).toBe(false);
		expect(atEdge.text).not.toContain('overdue');

		const past = checkStatus(row, after(interval + HOUR + 1), interval);
		expect(past.overdue).toBe(true);
		expect(past.text).toContain('overdue');
	});

	it('late but in grace', () => {
		const status = checkStatus(row, after(6 * HOUR + HOUR / 2), 6 * HOUR);

		expect(status.overdue).toBe(false);
		expect(status.text).not.toContain('overdue');
	});

	it('overdue still says when it was due', () => {
		const { text } = checkStatus(row, after(8 * HOUR), 6 * HOUR);

		expect(text).toBe('Checked 1 Nov 2026, 09:30 · next check overdue, was due 1 Nov 2026, 15:30');
	});

	it('interval', () => {
		const status = checkStatus(row, after(HOUR), 12 * HOUR);

		expect(status.text).toContain('next check due 1 Nov 2026, 21:30');
		expect(status.nextDueAt).toEqual(after(12 * HOUR));
	});

	it('never checked', () => {
		expect(
			checkStatus({ lastCheckedAt: null, lastCheckReason: null }, new Date(), 6 * HOUR)
		).toStrictEqual({ text: 'Not checked yet', overdue: false, failed: false, nextDueAt: null });
	});

	it('failed', () => {
		const failing = { lastCheckedAt: checkedAt, lastCheckReason: 'blocked' };

		const status = checkStatus(failing, after(HOUR), 6 * HOUR);
		expect(status.failed).toBe(true);
		expect(status.overdue).toBe(false);
		expect(status.text).toBe(
			'Last check failed: Blocked by Amazon · Checked 1 Nov 2026, 09:30 · next check due 1 Nov 2026, 15:30'
		);

		const late = checkStatus(failing, after(8 * HOUR), 6 * HOUR);
		expect(late.failed).toBe(true);
		expect(late.overdue).toBe(true);
		expect(late.text).toMatch(/^Last check failed: Blocked by Amazon .*overdue/);
	});

	it('failed with no check time', () => {
		const status = checkStatus(
			{ lastCheckedAt: null, lastCheckReason: 'blocked' },
			new Date(),
			6 * HOUR
		);

		expect(status).toStrictEqual({
			text: 'Last check failed: Blocked by Amazon · Not checked yet',
			overdue: false,
			failed: true,
			nextDueAt: null
		});
	});

	it('unknown reason', () => {
		const { text } = checkStatus(
			{ lastCheckedAt: checkedAt, lastCheckReason: 'something_new' },
			after(HOUR),
			6 * HOUR
		);

		expect(text).toMatch(/^Last check failed: something_new · /);
	});

	it('uk time', () => {
		// Clocks went back at 01:00 UTC on 25 Oct 2026: 23:00 BST, then 04:00 GMT.
		const { text } = checkStatus(
			{ lastCheckedAt: new Date('2026-10-24T22:00:00Z'), lastCheckReason: null },
			new Date('2026-10-24T23:00:00Z'),
			6 * HOUR
		);

		expect(text).toBe('Checked 24 Oct 2026, 23:00 · next check due 25 Oct 2026, 04:00');
	});

	it('one argument', () => {
		expect(toWatchView.length).toBe(1);
	});

	it('next due', () => {
		const odd = new Date(1_793_000_000_123);
		const status = checkStatus({ lastCheckedAt: odd, lastCheckReason: null }, odd, 6 * HOUR + 7);

		expect(status.nextDueAt?.getTime()).toBe(odd.getTime() + 6 * HOUR + 7);
	});
});
