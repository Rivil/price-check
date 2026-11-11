// The one better-auth configuration. No $app/* imports: the SvelteKit wrapper
// (auth.ts), the test harness and the admin:create CLI all build on this.
import { betterAuth } from 'better-auth/minimal';
import type { BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins/admin';
import type { Db } from './db/client.ts';

/** Single source for the password minimum. Admin createUser enforces none, so callers check this. */
export const MIN_PASSWORD_LENGTH = 8;

const DAY_SECONDS = 60 * 60 * 24;
export const SESSION_EXPIRES_IN_SECONDS = 30 * DAY_SECONDS;
export const SESSION_UPDATE_AGE_SECONDS = DAY_SECONDS;

export interface CreateAuthOptions<P extends BetterAuthPlugin[]> {
	db: Db;
	baseURL?: string;
	secret?: string;
	/** Extra plugins appended after the admin plugin (sveltekitCookies must be last). */
	plugins?: P;
}

export function createAuth<const P extends BetterAuthPlugin[] = []>({
	db,
	baseURL,
	secret,
	plugins
}: CreateAuthOptions<P>) {
	return betterAuth({
		baseURL,
		secret,
		database: drizzleAdapter(db, { provider: 'sqlite' }),
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			minPasswordLength: MIN_PASSWORD_LENGTH
		},
		session: {
			expiresIn: SESSION_EXPIRES_IN_SECONDS,
			updateAge: SESSION_UPDATE_AGE_SECONDS,
			// Off on purpose: a cached session cookie would outlive an admin revoke (c-7).
			cookieCache: { enabled: false }
		},
		plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] }), ...((plugins ?? []) as P)]
	});
}

export type Auth = ReturnType<typeof createAuth>;
