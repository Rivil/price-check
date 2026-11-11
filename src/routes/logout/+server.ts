import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { auth } from '#lib/server/auth.ts';

// POST only: a GET (link prefetch, crawler, <img src>) must never sign anyone out.
export const POST: RequestHandler = async ({ request }) => {
	// Deletes the session row server-side; sveltekitCookies clears the cookie.
	await auth.api.signOut({ headers: request.headers });
	redirect(303, '/login');
};
