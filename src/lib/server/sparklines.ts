// The prices behind a user's card sparklines, read once for the whole watchlist.
import { and, eq, gte } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { pricePoint, watch } from './db/schema.ts';
import { SPARKLINE_WINDOW_MS, type SparklinePoint } from '../sparkline.ts';

/** Each of the user's watches with a price in the window, mapped to those prices. */
export async function recentPrices(
	db: Db,
	userId: string,
	now: Date
): Promise<Map<string, SparklinePoint[]>> {
	const rows = await db
		.select({
			watchId: pricePoint.watchId,
			pricePence: pricePoint.pricePence,
			checkedAt: pricePoint.checkedAt
		})
		.from(pricePoint)
		.innerJoin(watch, eq(watch.id, pricePoint.watchId))
		.where(
			and(
				eq(watch.userId, userId),
				gte(pricePoint.checkedAt, new Date(now.getTime() - SPARKLINE_WINDOW_MS))
			)
		);

	const byWatch = new Map<string, SparklinePoint[]>();
	for (const { watchId, ...point } of rows) {
		const points = byWatch.get(watchId);
		if (points) points.push(point);
		else byWatch.set(watchId, [point]);
	}
	return byWatch;
}
