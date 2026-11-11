// Failed-sign-in limiter for the /login form. The form calls auth.api.signInEmail
// from the server, which skips better-auth's own HTTP rate limiter, so this is the
// only brute-force guard on that path. In memory: the app runs as one process, and
// a restart clearing the counts is acceptable. No $app/* imports.

export interface LimitRule {
	max: number;
	windowMs: number;
}

export interface LoginLimiterOptions {
	perEmail: LimitRule;
	perIp: LimitRule;
	now?: () => number;
}

export type LimitDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

const MINUTE = 60_000;

export const LOGIN_LIMITS = {
	perEmail: { max: 5, windowMs: 15 * MINUTE },
	perIp: { max: 20, windowMs: 15 * MINUTE }
} as const satisfies Omit<LoginLimiterOptions, 'now'>;

/** Emails are counted whether or not the account exists, so a 429 never reveals one. */
export function normaliseEmail(email: string) {
	return email.trim().toLowerCase();
}

export function createLoginLimiter({
	perEmail,
	perIp,
	now = () => Date.now()
}: LoginLimiterOptions) {
	const emails = new Map<string, number[]>();
	const ips = new Map<string, number[]>();

	/** Failures still inside the window; drops the key once none are left. */
	function live(store: Map<string, number[]>, key: string, rule: LimitRule, at: number) {
		const kept = (store.get(key) ?? []).filter((t) => at - t < rule.windowMs);
		if (kept.length) store.set(key, kept);
		else store.delete(key);
		return kept;
	}

	function blocked(store: Map<string, number[]>, key: string, rule: LimitRule, at: number) {
		const failures = live(store, key, rule, at);
		if (failures.length < rule.max) return 0;
		// Free again once the oldest failure that keeps it at the limit leaves the window.
		const freeAt = failures[failures.length - rule.max] + rule.windowMs;
		return Math.max(1, Math.ceil((freeAt - at) / 1000));
	}

	function sweep(store: Map<string, number[]>, rule: LimitRule, at: number) {
		for (const key of [...store.keys()]) live(store, key, rule, at);
	}

	return {
		check(email: string, ip: string): LimitDecision {
			const at = now();
			const wait = Math.max(
				blocked(emails, normaliseEmail(email), perEmail, at),
				blocked(ips, ip, perIp, at)
			);
			return wait ? { ok: false, retryAfterSeconds: wait } : { ok: true };
		},

		recordFailure(email: string, ip: string) {
			const at = now();
			for (const [store, key, rule] of [
				[emails, normaliseEmail(email), perEmail],
				[ips, ip, perIp]
			] as const) {
				store.set(key, [...live(store, key, rule, at), at]);
			}
			// Bound memory under a spray of distinct emails or addresses.
			if (emails.size > 1000) sweep(emails, perEmail, at);
			if (ips.size > 1000) sweep(ips, perIp, at);
		},

		recordSuccess(email: string) {
			emails.delete(normaliseEmail(email));
		},

		size() {
			return { emails: emails.size, ips: ips.size };
		},

		reset() {
			emails.clear();
			ips.clear();
		}
	};
}

export type LoginLimiter = ReturnType<typeof createLoginLimiter>;

/** The server's one limiter. */
export const loginLimiter = createLoginLimiter(LOGIN_LIMITS);

export function tooManyAttemptsMessage(retryAfterSeconds: number) {
	const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
	return `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
