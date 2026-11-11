// Request gate: who may reach what. Pure decision + a handle factory, with no
// $app/* imports so it can be unit-tested without a running SvelteKit server.
import { error, redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';

export const LOGIN_PATH = '/login';
const AUTH_API_PATH = '/api/auth';
const HEALTH_PATH = '/health';

export type AccessDecision =
	{ kind: 'allow' } | { kind: 'redirect'; location: '/login' | '/' } | { kind: 'forbidden' };

export interface AccessInput {
	/** SvelteKit's matched route id (null when nothing matched, i.e. a 404). */
	routeId: string | null;
	pathname: string;
	user: { role?: string | null } | null | undefined;
}

/** True when a better-auth role string grants admin (roles are stored comma-separated). */
export function isAdminRole(role: string | null | undefined): boolean {
	return (role ?? '').split(',').some((r) => r.trim() === 'admin');
}

function isAdminRoute(routeId: string | null) {
	return routeId === '/admin' || (routeId?.startsWith('/admin/') ?? false);
}

export function decideAccess({ routeId, pathname, user }: AccessInput): AccessDecision {
	// better-auth's own endpoints are served by svelteKitHandler, not a route, so match the path.
	if (pathname === AUTH_API_PATH || pathname.startsWith(`${AUTH_API_PATH}/`)) {
		return { kind: 'allow' };
	}

	// The exact pathname counts too, so the gate can never redirect /login to itself
	// (e.g. a 404 at /login would otherwise loop); look-alikes like /loginx don't match.
	const isLogin = routeId === LOGIN_PATH || pathname === LOGIN_PATH;

	if (!user) {
		return isLogin ? { kind: 'allow' } : { kind: 'redirect', location: LOGIN_PATH };
	}
	if (isLogin) return { kind: 'redirect', location: '/' };
	// Route ids are post-match, so encoding, case and trailing slashes can't dodge this.
	if (isAdminRoute(routeId) && !isAdminRole(user.role)) return { kind: 'forbidden' };

	return { kind: 'allow' };
}

type SessionResult = {
	user: NonNullable<App.Locals['user']>;
	session: NonNullable<App.Locals['session']>;
} | null;

/**
 * Loads the session into locals and enforces decideAccess for every request and
 * method — form actions included, which a +layout.server.ts guard would miss.
 */
export function createAccessHandle(
	getSession: (headers: Headers) => Promise<SessionResult>
): Handle {
	return async ({ event, resolve }) => {
		// Before the session load: getSession reads the database when a session cookie is
		// present, so a broken database would be a 500 here instead of the route's 503.
		// Exact pathname only: look-alikes like /healthx stay behind the gate.
		if (event.url.pathname === HEALTH_PATH) return resolve(event);

		const result = await getSession(event.request.headers);
		if (result) {
			event.locals.session = result.session;
			event.locals.user = result.user;
		}

		const decision = decideAccess({
			routeId: event.route.id,
			pathname: event.url.pathname,
			user: event.locals.user
		});

		if (decision.kind === 'redirect') redirect(303, decision.location);
		if (decision.kind === 'forbidden') error(403, 'Forbidden');

		return resolve(event);
	};
}
