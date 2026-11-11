import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { liveAfterFailure, liveAfterSuccess } from '#lib/server/alerts/live.ts';
import { checkNow, failureHistory, priceHistory } from '#lib/server/checks.ts';
import { db } from '#lib/server/db/index.ts';
import { checkUrl } from '#lib/server/shops/index.ts';
import { deleteWatch, getWatch, setTarget } from '#lib/server/watches.ts';
import { chartInput, priceStats, timeline } from '#lib/watch-history.ts';
import { toWatchView } from '#lib/watch-view.ts';

// Another user's watch is indistinguishable from a missing one: every path 404s.
// The server hook already redirects signed-out requests to /login.

export const load: PageServerLoad = async ({ params, locals }) => {
	const user = locals.user;
	if (!user) error(401, 'Sign in first');
	const watch = await getWatch(db, user.id, params.id);
	if (!watch) error(404, 'No such watch');
	const now = new Date();
	const [history, failures] = await Promise.all([
		priceHistory(db, user.id, watch.id),
		failureHistory(db, user.id, watch.id)
	]);
	return {
		watch: toWatchView(watch),
		timeline: timeline(history, failures),
		stats: priceStats(history),
		// No chart until a check succeeds, however many have failed (c-8).
		chart: history.length === 0 ? null : chartInput(history, failures, watch.targetPence, now),
		now: now.getTime()
	};
};

export const actions: Actions = {
	target: async ({ request, params, locals }) => {
		const user = locals.user;
		if (!user) error(401, 'Sign in first');
		const target = String((await request.formData()).get('target') ?? '');

		const result = await setTarget(db, user.id, params.id, target);
		if (result.kind === 'not_found') error(404, 'No such watch');
		if (result.kind === 'invalid') return fail(400, { message: result.message, target });
		return { saved: true };
	},

	/** 'Check now': one live check through the shared client, refused within the cooldown. */
	check: async ({ params, locals }) => {
		const user = locals.user;
		if (!user) error(401, 'Sign in first');
		const outcome = await checkNow(db, user.id, params.id, {
			check: (url) => checkUrl(url),
			afterSuccess: liveAfterSuccess(db),
			afterFailure: liveAfterFailure(db)
		});
		if (outcome.kind === 'not_found') error(404, 'No such watch');
		if (outcome.kind === 'cooldown') return fail(429, { checkMessage: outcome.message });
		return { checked: outcome.result.ok };
	},

	delete: async ({ params, locals }) => {
		const user = locals.user;
		if (!user) error(401, 'Sign in first');
		if (!(await deleteWatch(db, user.id, params.id))) error(404, 'No such watch');
		redirect(303, '/');
	}
};
