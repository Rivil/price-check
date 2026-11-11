import { ORIGIN, BETTER_AUTH_SECRET } from '$app/env/private';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { db } from '#lib/server/db/index.ts';
import { createAuth } from '#lib/server/auth-factory.ts';

export const auth = createAuth({
	db,
	baseURL: ORIGIN,
	secret: BETTER_AUTH_SECRET,
	plugins: [
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
