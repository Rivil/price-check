import { fail } from '@sveltejs/kit';
import { CHECK_INTERVAL_HOURS } from '$app/env/private';
import type { Actions, PageServerLoad } from './$types';
import { formatPence } from '#lib/money.ts';
import { liveAfterSuccess } from '#lib/server/alerts/live.ts';
import { checkIntervalFromEnv } from '#lib/server/checks.ts';
import { db } from '#lib/server/db/index.ts';
import { checkUrl, defaultRegistry } from '#lib/server/shops/index.ts';
import { recentPrices } from '#lib/server/sparklines.ts';
import { addWatch, listWatches, type WatchDeps } from '#lib/server/watches.ts';
import { sparkline, type SparklinePoint } from '#lib/sparkline.ts';
import { checkStatus, toWatchView } from '#lib/watch-view.ts';

/** The live shop: offline identify, then one check through the shared rate-limited client. */
const shop: WatchDeps = {
	identify: (url) => defaultRegistry.identify(url),
	check: (url) => checkUrl(url),
	// A new watch already at or below its target alerts straight away.
	afterSuccess: (watchId) => liveAfterSuccess(db)(watchId)
};

/** The sparkline's accessible name. It leaves out the title, which the card already says. */
function sparklineLabel(points: SparklinePoint[]): string {
	const prices = points.map((point) => point.pricePence);
	const low = formatPence(Math.min(...prices));
	const high = formatPence(Math.max(...prices));
	return `30-day prices, lowest ${low}, highest ${high}`;
}

export const load: PageServerLoad = async () => {
	const now = new Date();
	const intervalMs = checkIntervalFromEnv({ CHECK_INTERVAL_HOURS });
	const [watches, recent] = await Promise.all([listWatches(db), recentPrices(db, now)]);
	return {
		watches: watches.map((row) => {
			const points = recent.get(row.id) ?? [];
			return {
				...toWatchView(row),
				status: checkStatus(row, now, intervalMs),
				sparkline: sparkline(points, now),
				sparklineLabel: points.length === 0 ? null : sparklineLabel(points)
			};
		})
	};
};

export const actions: Actions = {
	add: async ({ request }) => {
		const data = await request.formData();
		const url = String(data.get('url') ?? '');
		const target = String(data.get('target') ?? '');

		const result = await addWatch(db, { url, target }, shop);
		if (!result.ok) {
			return fail(400, { field: result.field, message: result.message, url, target });
		}
		return { added: result.watch.title ?? result.watch.canonicalUrl };
	}
};
