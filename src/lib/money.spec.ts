import { describe, expect, it } from 'vitest';
import { MAX_POUNDS_PENCE, formatPence, parsePounds } from './money.ts';

describe('parsePounds', () => {
	it('parse table', () => {
		for (const [input, pence] of [
			['24', 2400],
			['24.9', 2490],
			['24.99', 2499],
			['£24.99', 2499],
			['  24.99 ', 2499],
			['0.01', 1],
			['0.5', 50],
			['007.50', 750],
			['1299', 129900],
			['100000', 10_000_000],
			['100000.00', 10_000_000]
		] as const) {
			expect(parsePounds(input), input).toEqual({ ok: true, pence });
		}
	});

	it('rejection table', () => {
		for (const input of [
			'',
			'   ',
			'£',
			'0',
			'0.00',
			'£0',
			'-1',
			'-0.50',
			'+5',
			'abc',
			'1,299',
			'1 299',
			'24.999',
			'24.',
			'.99',
			'1e3',
			'0x10',
			'Infinity',
			'NaN',
			'24.99p',
			'£ 24.99',
			'$24.99'
		]) {
			const result = parsePounds(input);
			expect(result.ok, JSON.stringify(input)).toBe(false);
			expect(result).toHaveProperty('message');
		}
	});

	it('messages', () => {
		expect(parsePounds('abc')).toEqual({
			ok: false,
			message: 'Enter a price in pounds, like 24.99'
		});
		expect(parsePounds('0')).toEqual({ ok: false, message: 'The price must be more than £0.00' });
		expect(parsePounds('100000.01')).toEqual({
			ok: false,
			message: 'The price must be at most £100,000.00'
		});
	});

	it('bounds', () => {
		expect(MAX_POUNDS_PENCE).toBe(10_000_000);
		expect(parsePounds('100000')).toEqual({ ok: true, pence: 10_000_000 });
		expect(parsePounds('99999.99')).toEqual({ ok: true, pence: 9_999_999 });
		for (const input of ['100000.01', '100001', '1000000', '99999999999999999999']) {
			expect(parsePounds(input).ok, input).toBe(false);
		}
	});
});

describe('formatPence', () => {
	it('format', () => {
		expect(formatPence(129900)).toBe('£1,299.00');
		expect(formatPence(5)).toBe('£0.05');
		expect(formatPence(50)).toBe('£0.50');
		expect(formatPence(0)).toBe('£0.00');
		expect(formatPence(1999)).toBe('£19.99');
		expect(formatPence(100000)).toBe('£1,000.00');
		expect(formatPence(99999)).toBe('£999.99');
		expect(formatPence(123456789)).toBe('£1,234,567.89');
	});
});
