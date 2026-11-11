import { describe, expect, it } from 'vitest';
import {
	LOGIN_LIMITS,
	createLoginLimiter,
	loginLimiter,
	normaliseEmail,
	tooManyAttemptsMessage
} from './login-limiter.ts';

const MINUTE = 60_000;

function limiter() {
	const clock = { t: 1_000_000 };
	const l = createLoginLimiter({
		perEmail: { max: 3, windowMs: 10 * MINUTE },
		perIp: { max: 5, windowMs: 10 * MINUTE },
		now: () => clock.t
	});
	return { l, clock };
}

describe('login limiter', () => {
	it('the server limits', () => {
		expect(LOGIN_LIMITS).toEqual({
			perEmail: { max: 5, windowMs: 15 * MINUTE },
			perIp: { max: 20, windowMs: 15 * MINUTE }
		});
		expect(loginLimiter.check('a@example.test', '1.2.3.4')).toEqual({ ok: true });
	});

	it('blocks an email at its limit until the oldest failure leaves the window', () => {
		const { l, clock } = limiter();
		for (let i = 0; i < 2; i++) {
			l.recordFailure('a@example.test', `10.0.0.${i}`);
			clock.t += MINUTE;
		}
		expect(l.check('a@example.test', '10.0.0.9')).toEqual({ ok: true });

		l.recordFailure('a@example.test', '10.0.0.2'); // 3rd, at t0 + 2 min
		// Oldest failure (t0) leaves at t0 + 10 min; now is t0 + 2 min → 8 min.
		expect(l.check('a@example.test', '10.0.0.9')).toEqual({
			ok: false,
			retryAfterSeconds: 8 * 60
		});
		// Other emails and the same address for another email are unaffected.
		expect(l.check('b@example.test', '10.0.0.2')).toEqual({ ok: true });

		clock.t += 8 * MINUTE - 1;
		expect(l.check('a@example.test', 'x')).toEqual({ ok: false, retryAfterSeconds: 1 });
		clock.t += 1;
		expect(l.check('a@example.test', 'x')).toEqual({ ok: true });
	});

	it('counts emails case- and space-insensitively', () => {
		const { l } = limiter();
		l.recordFailure('A@Example.test', '1');
		l.recordFailure(' a@example.TEST ', '2');
		l.recordFailure('a@example.test', '3');
		expect(normaliseEmail('  A@Example.TEST ')).toBe('a@example.test');
		expect(l.check('a@EXAMPLE.test', '4').ok).toBe(false);
	});

	it('blocks an address across different emails', () => {
		const { l } = limiter();
		for (let i = 0; i < 4; i++) l.recordFailure(`user${i}@example.test`, '9.9.9.9');
		expect(l.check('new@example.test', '9.9.9.9')).toEqual({ ok: true });
		l.recordFailure('user4@example.test', '9.9.9.9');
		expect(l.check('new@example.test', '9.9.9.9')).toEqual({
			ok: false,
			retryAfterSeconds: 10 * 60
		});
		expect(l.check('new@example.test', '8.8.8.8')).toEqual({ ok: true });
	});

	it('reports the longer wait when both limits apply', () => {
		const { l, clock } = limiter();
		for (let i = 0; i < 5; i++) {
			l.recordFailure(`u${i}@example.test`, 'ip');
			clock.t += MINUTE;
		}
		// IP limit frees at t0 + 10 min (now t0 + 5): 5 min.
		for (let i = 0; i < 3; i++) l.recordFailure('a@example.test', 'other');
		// Email limit frees at t0 + 15 min: 10 min.
		expect(l.check('a@example.test', 'ip')).toEqual({ ok: false, retryAfterSeconds: 10 * 60 });
	});

	it('a success clears only that email', () => {
		const { l } = limiter();
		for (let i = 0; i < 3; i++) l.recordFailure('a@example.test', 'ip');
		l.recordSuccess('A@example.test');
		expect(l.check('a@example.test', 'elsewhere')).toEqual({ ok: true });
		// The address keeps its 3 failures: 2 more block it.
		l.recordFailure('b@example.test', 'ip');
		l.recordFailure('c@example.test', 'ip');
		expect(l.check('d@example.test', 'ip').ok).toBe(false);
	});

	it('drops expired entries', () => {
		const { l, clock } = limiter();
		l.recordFailure('a@example.test', 'ip');
		expect(l.size()).toEqual({ emails: 1, ips: 1 });
		clock.t += 10 * MINUTE;
		l.check('a@example.test', 'ip');
		expect(l.size()).toEqual({ emails: 0, ips: 0 });

		// A spray of distinct keys is swept once past 1000.
		for (let i = 0; i < 1001; i++) l.recordFailure(`s${i}@example.test`, `ip${i}`);
		expect(l.size()).toEqual({ emails: 1001, ips: 1001 });
		clock.t += 10 * MINUTE;
		l.recordFailure('last@example.test', 'last');
		expect(l.size()).toEqual({ emails: 1, ips: 1 });

		l.reset();
		expect(l.size()).toEqual({ emails: 0, ips: 0 });
	});

	it('message', () => {
		expect(tooManyAttemptsMessage(1)).toBe('Too many sign-in attempts. Try again in 1 minute.');
		expect(tooManyAttemptsMessage(60)).toBe('Too many sign-in attempts. Try again in 1 minute.');
		expect(tooManyAttemptsMessage(61)).toBe('Too many sign-in attempts. Try again in 2 minutes.');
		expect(tooManyAttemptsMessage(900)).toBe('Too many sign-in attempts. Try again in 15 minutes.');
	});
});
