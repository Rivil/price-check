import { describe, expect, it } from 'vitest';

// Every non-test source file under src/routes and src/lib, as raw text. Test files
// are excluded because they legitimately name the sign-up endpoint to assert it is
// rejected (this file included).
const sources = import.meta.glob<string>(
	[
		'/src/routes/**/*.{ts,js,svelte}',
		'/src/lib/**/*.{ts,js,svelte}',
		'!**/*.spec.ts',
		'!**/*.e2e.ts'
	],
	{ query: '?raw', import: 'default', eager: true }
);

// Deliberately no bare /register/i: a later service-worker registration must not trip it.
const SIGN_UP_PATTERNS: { pattern: RegExp; fixture: string }[] = [
	{ pattern: /signUpEmail/, fixture: 'await auth.api.signUpEmail({ body })' },
	{ pattern: /\bsignUp\./, fixture: 'await authClient.signUp.email({ email, password, name })' },
	{ pattern: /\/sign-up\//, fixture: "fetch('/api/auth/sign-up/email', { method: 'POST' })" }
];

function offenders(files: Record<string, string>) {
	return Object.entries(files).flatMap(([path, text]) =>
		SIGN_UP_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
			({ pattern }) => `${path} matches ${pattern}`
		)
	);
}

describe('no public sign-up', () => {
	it('scans real sources', () => {
		const keys = Object.keys(sources);

		expect(keys).toContain('/src/routes/+layout.svelte');
		expect(keys).toContain('/src/lib/server/auth-factory.ts');
	});

	it('patterns match their fixtures', () => {
		for (const { pattern, fixture } of SIGN_UP_PATTERNS) {
			expect(pattern.test(fixture), `${pattern} should match ${fixture}`).toBe(true);
		}
		expect(offenders({ '/src/routes/bad.ts': SIGN_UP_PATTERNS[1].fixture })).toEqual([
			'/src/routes/bad.ts matches /\\bsignUp\\./'
		]);
	});

	it('no sign-up calls', () => {
		expect(offenders(sources)).toEqual([]);
	});

	it('tests excluded', () => {
		const testKeys = Object.keys(sources).filter((k) => /\.(spec|e2e)\.ts$/.test(k));

		expect(testKeys).toEqual([]);
	});

	it('no demo routes', () => {
		const demoKeys = Object.keys(sources).filter((k) => k.startsWith('/src/routes/demo/'));

		expect(demoKeys).toEqual([]);
	});
});
