import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	DATABASE_URL: { description: 'The database connection string.' },
	ORIGIN: {
		description: 'The app origin (base URL), e.g. `http://localhost:5173`.'
	},
	CHECK_INTERVAL_HOURS: {
		description:
			'Hours between scheduled re-checks of each watch, a whole number from 1 to 168. Defaults to 6.',
		schema: (value: string | undefined) => value
	},
	SCHEDULER_DISABLED: {
		description: 'Set to 1 to stop the server re-checking watches (used by the e2e tests).',
		schema: (value: string | undefined) => value
	},
	ALERTS_ENCRYPTION_KEY: {
		description:
			'Key that encrypts alert channel credentials at rest: base64 of 32 random bytes, from `openssl rand -base64 32`. Required — the server refuses to start without it.',
		schema: (value: string | undefined) => value
	},
	BETTER_AUTH_SECRET: {
		description:
			'Secret used to sign tokens. For production use 32 characters generated with high entropy. See [Better Auth installation](https://www.better-auth.com/docs/installation).'
	}
});
