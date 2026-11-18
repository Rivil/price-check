// The watchlist: add (one check, at add time), list, get, change the target,
// delete. The watches belong to the install (decision data_scope), one per product.
// Shop access is injected (identify + check), so nothing here can reach the network
// on its own (r-01).
import { and, desc, eq } from 'drizzle-orm';
import { parsePounds } from '../money.ts';
import type { Db } from './db/client.ts';
import { checkFailure, pricePoint, priceDropDelivery, watch } from './db/schema.ts';
import { unsupported, type Identification } from './shops/registry.ts';
import type { CheckResult, FailureReason } from './shops/types.ts';

export type Watch = typeof watch.$inferSelect;

export type WatchDeps = {
	/** Names the product without a request (ShopRegistry.identify). */
	identify(url: string): Identification;
	/** One live check (ShopRegistry.check bound to the rate-limited client). */
	check(url: string): Promise<CheckResult>;
	now?: () => Date;
	newId?: () => string;
	/** Called once after a successful add check is stored (e.g. to alert); its failure never fails the add. */
	afterSuccess?: (watchId: string) => Promise<unknown>;
};

export type AddInput = { url: string; target: string };

export type AddResult =
	| { ok: true; watch: Watch }
	| { ok: false; field: 'url' | 'target'; message: string; existingId?: string };

export const ALREADY_WATCHED = 'This product is already on your watchlist';
export const URL_REQUIRED = 'Paste an amazon.co.uk product link';

/**
 * Failures that mean the URL itself is wrong: only the user can fix them, so the
 * add is refused (decision add_failure_split). Any other failure is about the
 * page right now, and the watch is kept for a later check to recover.
 */
const REJECTED: ReadonlySet<FailureReason> = new Set<FailureReason>([
	'unsupported',
	'not_found',
	'variant_required'
]);

type ParsedTarget = { ok: true; pence: number | null } | { ok: false; message: string };

/** An empty target means "no target"; anything else must be a valid price. */
export function parseTarget(input: string): ParsedTarget {
	if (input.trim() === '') return { ok: true, pence: null };
	const parsed = parsePounds(input);
	return parsed.ok ? { ok: true, pence: parsed.pence } : parsed;
}

export async function addWatch(db: Db, input: AddInput, deps: WatchDeps): Promise<AddResult> {
	// The target is validated first: a bad one never costs a request.
	const target = parseTarget(input.target);
	if (!target.ok) return { ok: false, field: 'target', message: target.message };

	const url = input.url.trim();
	if (url === '') return { ok: false, field: 'url', message: URL_REQUIRED };

	const identity = deps.identify(url);
	if (identity.kind === 'unsupported') {
		return { ok: false, field: 'url', message: unsupported().message };
	}
	if (identity.kind === 'product') {
		const existing = await findWatched(db, identity.shop, identity.productId);
		if (existing !== null) return already(existing);
	}

	const result = await deps.check(url);
	const checkedAt = (deps.now ?? (() => new Date()))();

	if (result.ok) {
		// A short link is only named by its check, so dedupe again here.
		const existing = await findWatched(db, result.shop, result.productId);
		if (existing !== null) return already(existing);
		const added = await insert(
			db,
			deps,
			{
				shop: result.shop,
				productId: result.productId,
				canonicalUrl: result.canonicalUrl,
				title: result.title,
				imageUrl: result.imageUrl,
				pricePence: result.pricePence,
				targetPence: target.pence,
				lastCheckedAt: checkedAt
			},
			result,
			checkedAt
		);
		if (added.ok) await runAfterSuccess(deps.afterSuccess, added.watch.id);
		return added;
	}

	// A failed check carries no product id, so only an identified URL can be kept
	// (decision identity_before_check): a short link that fails is refused.
	if (REJECTED.has(result.reason) || identity.kind !== 'product') {
		return { ok: false, field: 'url', message: result.message };
	}
	return insert(
		db,
		deps,
		{
			shop: identity.shop,
			productId: identity.productId,
			canonicalUrl: identity.canonicalUrl,
			targetPence: target.pence,
			lastCheckedAt: checkedAt,
			lastCheckReason: result.reason,
			lastCheckMessage: result.message
		},
		result,
		checkedAt
	);
}

/** Every watch, newest first. */
export function listWatches(db: Db): Promise<Watch[]> {
	return db.select().from(watch).orderBy(desc(watch.createdAt), desc(watch.id));
}

/** The watch with this id, or null. */
export async function getWatch(db: Db, id: string): Promise<Watch | null> {
	const [row] = await db.select().from(watch).where(eq(watch.id, id));
	return row ?? null;
}

export type SetTargetResult =
	| { kind: 'updated'; targetPence: number | null }
	| { kind: 'invalid'; message: string }
	| { kind: 'not_found' };

/** Changes (or, with an empty input, clears) a watch's target. */
export async function setTarget(db: Db, id: string, input: string): Promise<SetTargetResult> {
	const target = parseTarget(input);
	if (!target.ok) return { kind: 'invalid', message: target.message };
	const own = await getWatch(db, id);
	if (own === null) return { kind: 'not_found' };
	// A real change re-arms the price-drop alert on every channel (its delivery rows
	// go); re-saving the same target leaves them, so one drop never alerts twice.
	const changed = own.targetPence !== target.pence;
	await db.update(watch).set({ targetPence: target.pence }).where(eq(watch.id, id));
	if (changed) await db.delete(priceDropDelivery).where(eq(priceDropDelivery.watchId, id));
	return { kind: 'updated', targetPence: target.pence };
}

/** Runs an afterSuccess hook; whatever it does, the check it follows has succeeded. */
export async function runAfterSuccess(
	hook: ((watchId: string) => Promise<unknown>) | undefined,
	watchId: string
): Promise<void> {
	if (hook === undefined) return;
	try {
		await hook(watchId);
	} catch (error) {
		// Only the error's type: a hook's error text could carry anything, an ntfy topic
		// included, and topics are never logged (decision topic_is_secret).
		console.error(
			`[checks] after-success hook for watch ${watchId} failed (${error instanceof Error ? error.name : 'error'})`
		);
	}
}

/** Deletes a watch; false when there is no such watch. */
export async function deleteWatch(db: Db, id: string): Promise<boolean> {
	const deleted = await db.delete(watch).where(eq(watch.id, id)).returning({ id: watch.id });
	return deleted.length > 0;
}

async function findWatched(db: Db, shop: string, productId: string): Promise<Watch | null> {
	const [row] = await db
		.select()
		.from(watch)
		.where(and(eq(watch.shop, shop), eq(watch.productId, productId)));
	return row ?? null;
}

function already(existing: Watch): AddResult {
	return { ok: false, field: 'url', message: ALREADY_WATCHED, existingId: existing.id };
}

async function insert(
	db: Db,
	deps: WatchDeps,
	fields: Omit<typeof watch.$inferInsert, 'id'>,
	result: CheckResult,
	checkedAt: Date
): Promise<AddResult> {
	// The id is drawn only once an insert is certain: a duplicate never costs one.
	const values = { ...fields, id: (deps.newId ?? (() => crypto.randomUUID()))() };
	try {
		// The add's own check is the watch's first history entry (scheduled-checks c-5),
		// a price or a failure: the two land together or not at all. A batch, not an
		// interactive transaction: libsql runs a batch on its shared connection in one
		// go, so two adds at once queue up, where a second transaction would open a
		// connection of its own and fail with SQLITE_BUSY.
		const first = { id: crypto.randomUUID(), watchId: values.id, checkedAt };
		const history = result.ok
			? db.insert(pricePoint).values({ ...first, pricePence: result.pricePence })
			: db
					.insert(checkFailure)
					.values({ ...first, reason: result.reason, message: result.message });
		const [[row]] = await db.batch([db.insert(watch).values(values).returning(), history]);
		return { ok: true, watch: row };
	} catch (error) {
		// Two adds of the same product racing past the lookup: the product's unique
		// index decides, and the loser is told it is already watched. Any other
		// failure (an id collision included) is not a race and propagates.
		if (!isProductRace(error)) throw error;
		const existing = await findWatched(db, values.shop, values.productId);
		if (existing === null) throw error;
		return already(existing);
	}
}

/** SQLite's message for the watch_product_uq index, anywhere in the cause chain. */
const PRODUCT_RACE = /UNIQUE constraint failed: watch\.shop, watch\.product_id/;

function isProductRace(error: unknown): boolean {
	for (let e: unknown = error; e instanceof Error; e = e.cause) {
		if (PRODUCT_RACE.test(e.message)) return true;
	}
	return false;
}
