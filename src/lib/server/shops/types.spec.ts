import { describe, expect, it } from 'vitest';
import { MAX_FAILURE_MESSAGE, clipMessage, failure, type FailureReason } from './types.ts';

const REASONS: FailureReason[] = [
	'unsupported',
	'blocked',
	'unavailable',
	'variant_required',
	'parse_failed',
	'not_found',
	'fetch_failed'
];

describe('failure', () => {
	it('builds exactly ok, reason and message', () => {
		for (const reason of REASONS) {
			expect(failure(reason, 'why')).toStrictEqual({ ok: false, reason, message: 'why' });
		}
	});

	it('rejects bad input', () => {
		expect(() => failure('nope' as FailureReason, 'why')).toThrow('unknown failure reason: nope');
		expect(() => failure('blocked', '')).toThrow('failure message must not be empty');
		expect(() => failure('blocked', ' \n\t ')).toThrow('failure message must not be empty');
	});

	it('bounds the message length', () => {
		expect(MAX_FAILURE_MESSAGE).toBe(120);
		const longest = 'm'.repeat(120);
		expect(failure('fetch_failed', longest).message).toBe(longest);
		expect(() => failure('fetch_failed', 'm'.repeat(121))).toThrow(
			'failure message longer than 120 chars: '
		);
	});
});

describe('clipMessage', () => {
	it('collapses whitespace', () => {
		expect(clipMessage('  socket \n\t hang   up  ')).toBe('socket hang up');
		expect(clipMessage('  ')).toBe('unknown error');
		expect(clipMessage('')).toBe('unknown error');
	});

	it('clips to the failure bound', () => {
		const exact = 'c'.repeat(120);
		expect(clipMessage(exact)).toBe(exact);

		const clipped = clipMessage('c'.repeat(121));
		expect(clipped).toHaveLength(120);
		expect(clipped).toBe(`${'c'.repeat(119)}…`);
		// Whatever it returns is a valid failure message.
		expect(() => failure('fetch_failed', clipMessage('x '.repeat(500)))).not.toThrow();
	});
});
