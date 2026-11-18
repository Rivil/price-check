import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	DATABASE_URL: { description: 'The database connection string.' },
	ORIGIN: {
		description:
			'The app origin (base URL), e.g. `http://127.0.0.1:3000`. Optional — unset, adapter-node derives an https origin from the Host header, so a server on plain http must set it.',
		schema: (value: string | undefined) => value
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
	}
});
