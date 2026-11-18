// Every form action the app declares, as [route, action]. The CSRF e2e posts to each
// one cross-site (c-6); src/routes/action-endpoints.spec.ts fails when a
// +page.server.ts declares an action missing here, or one here no longer exists.
// Plain data and Node: no $app/*, no Playwright, so the vitest spec can import it.

/** A route as its URL path with Kit's [param] segments, and one action it declares. */
export type ActionEndpoint = readonly [route: string, action: string];

export const ACTION_ENDPOINTS: readonly ActionEndpoint[] = [
	['/', 'add'],
	['/account/alerts', 'save'],
	['/account/alerts', 'enable'],
	['/account/alerts', 'disable'],
	['/account/alerts', 'remove'],
	['/account/alerts', 'test'],
	['/watches/[id]', 'target'],
	['/watches/[id]', 'check'],
	['/watches/[id]', 'delete']
];

/**
 * The URL a form posts to for this endpoint, each [param] filled from `params`.
 * A `default` action posts to the page itself. Throws on a param it has no value
 * for, and on optional or rest params, which no route here uses.
 */
export function actionUrl([route, action]: ActionEndpoint, params: Record<string, string>) {
	const path = route.replace(/\[([^\]]*)\]/g, (_, name: string) => {
		if (!/^\w+$/.test(name)) throw new Error(`actionUrl: unsupported param [${name}] in ${route}`);
		const value = params[name];
		if (value === undefined) throw new Error(`actionUrl: no value for [${name}] in ${route}`);
		return encodeURIComponent(value);
	});
	return action === 'default' ? path : `${path}?/${action}`;
}
