import { describe, expect, it } from 'vitest';
import { variables } from './env.ts';

type Validated = { value?: unknown; issues?: unknown };

async function validate(name: keyof typeof variables, value: string | undefined) {
	const schema = (
		variables[name] as { schema?: { '~standard': { validate(v: unknown): unknown } } }
	).schema;
	return (await schema!['~standard'].validate(value)) as Validated;
}

describe('env declarations', () => {
	it('env', async () => {
		expect(Object.keys(variables).sort()).toEqual([
			'ALERTS_ENCRYPTION_KEY',
			'BETTER_AUTH_SECRET',
			'CHECK_INTERVAL_HOURS',
			'DATABASE_URL',
			'ORIGIN',
			'SCHEDULER_DISABLED'
		]);
		for (const [name, config] of Object.entries(variables)) {
			expect((config as { description?: string }).description, name).toMatch(/\w{3,}/);
		}
		expect(variables.CHECK_INTERVAL_HOURS.description).toMatch(/1 to 168.*6/);
		expect(variables.SCHEDULER_DISABLED.description).toMatch(/Set to 1/);

		// Optional, passed through untouched: the scheduler parses and validates them.
		for (const name of ['CHECK_INTERVAL_HOURS', 'SCHEDULER_DISABLED'] as const) {
			expect(await validate(name, '1'), name).toEqual({ value: '1' });
			expect(await validate(name, '24'), name).toEqual({ value: '24' });
			expect(await validate(name, undefined), name).toEqual({ value: undefined });
		}

		// Passed through here and validated at startup (hooks.server init), so the
		// image build and the static CI job need no placeholder key.
		expect(variables.ALERTS_ENCRYPTION_KEY.description).toMatch(/encrypt/);
		expect(variables.ALERTS_ENCRYPTION_KEY.description).toMatch(/openssl rand -base64 32/);
		expect(await validate('ALERTS_ENCRYPTION_KEY', undefined)).toEqual({ value: undefined });
		expect(await validate('ALERTS_ENCRYPTION_KEY', 'not-a-key')).toEqual({ value: 'not-a-key' });
	});
});
