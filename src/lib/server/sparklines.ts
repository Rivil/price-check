// The prices behind the card sparklines, read once for the whole watchlist.
import { gte } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { pricePoint } from './db/schema.ts';
import { SPARKLINE_WINDOW_MS, type SparklinePoint } from '../sparkline.ts';

/** Each watch with a price in the window, mapped to those prices. */
export async function recentPrices(db: Db, now: Date): Promise<Map<string, SparklinePoint[]>> {
	const rows = await db
		.select({
			watchId: pricePoint.watchId,
			pricePence: pricePoint.pricePence,
			checkedAt: pricePoint.checkedAt
		})
		.from(pricePoint)
		.where(gte(pricePoint.checkedAt, new Date(now.getTime() - SPARKLINE_WINDOW_MS)));

	const byWatch = new Map<string, SparklinePoint[]>();
	for (const { watchId, ...point } of rows) {
		const points = byWatch.get(watchId);
		if (points) points.push(point);
		else byWatch.set(watchId, [point]);
	}
	return byWatch;
}
