// The install's alert channels (at most one per type — decision channels_per_type),
// with each channel's settings stored as one AES-256-GCM blob (decision
// encryption_key). Secrets are write-only: the page shows whether one is set, never
// its value, and a blank secret on save keeps the saved one (c-7).
//
// No $app imports: the server and tests call this with their own db and key. Log
// lines name the channel kind only — never a topic, token or ciphertext.
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { notifyChannel } from '../db/schema.ts';
import type { ChannelDriver, ConfigForm, ConfigView, RoutedAlertKind } from './channel.ts';
import { channelAad, decryptSecret, encryptSecret } from './crypto.ts';
import { ntfyDriver } from './ntfy.ts';
import { resendDriver } from './resend.ts';
import { smtpDriver } from './smtp.ts';

// ---- driver registry -------------------------------------------------------------

/** A driver whose config shape is opaque to the store; it only ever round-trips JSON. */
export type AnyDriver = ChannelDriver<unknown>;

const drivers = new Map<string, AnyDriver>([
	[ntfyDriver.kind, ntfyDriver as AnyDriver],
	[resendDriver.kind, resendDriver as AnyDriver],
	[smtpDriver.kind, smtpDriver as AnyDriver]
]);

/**
 * Adds a channel type under `kind` (tests and later phases). Returns a function that
 * restores whatever was registered under that kind before.
 */
export function registerDriver(driver: AnyDriver, kind: string = driver.kind): () => void {
	const before = drivers.get(kind);
	drivers.set(kind, driver);
	return () => {
		if (before === undefined) drivers.delete(kind);
		else drivers.set(kind, before);
	};
}

export function driverFor(kind: string): AnyDriver | undefined {
	return drivers.get(kind);
}

/** Registered kinds, in registration order (ntfy, resend, then smtp). */
export function channelKinds(): string[] {
	return [...drivers.keys()];
}

// ---- reading -------------------------------------------------------------------

export type Logger = (message: string) => void;
const defaultLog: Logger = (message) => console.error(message);

function undecryptable(log: Logger, kind: string) {
	log(`[alerts] channel (${kind}) could not be decrypted`);
}

type Row = typeof notifyChannel.$inferSelect;

function openConfig(key: Buffer, row: Row): { ok: true; config: unknown } | { ok: false } {
	if (row.configEnc === null) return { ok: false };
	const opened = decryptSecret(key, row.configEnc, channelAad(row.kind));
	if (!opened.ok) return { ok: false };
	try {
		return { ok: true, config: JSON.parse(opened.plaintext) as unknown };
	} catch {
		return { ok: false };
	}
}

function sealConfig(key: Buffer, kind: string, config: unknown): string {
	return encryptSecret(key, JSON.stringify(config), channelAad(kind));
}

/**
 * What the page sees of one saved channel. `view` is the driver's public fields plus
 * a set/unset flag per secret; `unreadable` (view null) means the saved settings
 * cannot be decrypted with this key (another key, or sealed before 02-single-user),
 * or there are none.
 */
export type ChannelView = {
	enabled: boolean;
	priceDrops: boolean;
	checkFailures: boolean;
	unreadable: boolean;
	view: ConfigView | null;
};

/** The saved channels of registered kinds, keyed by kind. */
export async function listChannels(
	db: Db,
	key: Buffer,
	{ log = defaultLog }: { log?: Logger } = {}
): Promise<Record<string, ChannelView>> {
	const rows = await db.select().from(notifyChannel);
	const views: Record<string, ChannelView> = {};
	for (const row of rows) {
		const driver = drivers.get(row.kind);
		if (driver === undefined) continue;
		const opened = openConfig(key, row);
		if (!opened.ok && row.configEnc !== null) undecryptable(log, row.kind);
		views[row.kind] = {
			enabled: row.enabled,
			priceDrops: row.priceDrops,
			checkFailures: row.checkFailures,
			unreadable: !opened.ok,
			view: opened.ok ? driver.view(opened.config) : null
		};
	}
	return views;
}

export type RoutedChannel = { kind: string; driver: AnyDriver; config: unknown };

/** Decrypted configs of the enabled channels that are set to receive `alertKind`. */
export async function channelsFor(
	db: Db,
	key: Buffer,
	alertKind: RoutedAlertKind,
	{ log = defaultLog }: { log?: Logger } = {}
): Promise<RoutedChannel[]> {
	const kindColumn =
		alertKind === 'price_drop' ? notifyChannel.priceDrops : notifyChannel.checkFailures;
	const rows = await db
		.select()
		.from(notifyChannel)
		.where(and(eq(notifyChannel.enabled, true), eq(kindColumn, true)));
	const routed: RoutedChannel[] = [];
	for (const kind of drivers.keys()) {
		const row = rows.find((r) => r.kind === kind);
		if (row === undefined) continue;
		if (row.configEnc === null) {
			log(`[alerts] channel (${kind}) has no settings, skipped`);
			continue;
		}
		const opened = openConfig(key, row);
		if (!opened.ok) {
			undecryptable(log, kind);
			continue;
		}
		routed.push({ kind, driver: drivers.get(kind)!, config: opened.config });
	}
	return routed;
}

/** The decrypted config of one saved channel, or null (none saved, or unreadable). */
export async function loadChannelConfig(db: Db, key: Buffer, kind: string): Promise<unknown> {
	const [row] = await db.select().from(notifyChannel).where(eq(notifyChannel.kind, kind));
	if (row === undefined) return null;
	const opened = openConfig(key, row);
	return opened.ok ? opened.config : null;
}

// ---- writing -------------------------------------------------------------------

export type Routing = { priceDrops: boolean; checkFailures: boolean };

export type SaveResult = { ok: true } | { ok: false; message: string };

export const NO_KINDS_MESSAGE = 'Choose at least one: price drops or failed checks.';
export const UNKNOWN_KIND_MESSAGE = 'Unknown channel type.';

/**
 * Creates or replaces the channel of `kind`. The driver parses the form against the
 * saved config, so a blank secret keeps the saved one. `routing` omitted keeps the
 * saved kinds, or for a new channel uses the driver's defaults; a new channel starts
 * enabled. Any refusal writes nothing.
 */
export async function saveChannel(
	db: Db,
	key: Buffer,
	kind: string,
	form: ConfigForm,
	routing?: Routing
): Promise<SaveResult> {
	const driver = drivers.get(kind);
	if (driver === undefined) return { ok: false, message: UNKNOWN_KIND_MESSAGE };
	if (routing !== undefined && !routing.priceDrops && !routing.checkFailures) {
		return { ok: false, message: NO_KINDS_MESSAGE };
	}

	const [existing] = await db.select().from(notifyChannel).where(eq(notifyChannel.kind, kind));
	const previous = existing === undefined ? null : openConfig(key, existing);
	const parsed = driver.parseConfig(form, previous?.ok ? previous.config : null);
	if (!parsed.ok) return { ok: false, message: parsed.message };

	const kinds: Routing =
		routing ??
		(existing !== undefined
			? { priceDrops: existing.priceDrops, checkFailures: existing.checkFailures }
			: {
					priceDrops: driver.defaultKinds.includes('price_drop'),
					checkFailures: driver.defaultKinds.includes('check_failed')
				});
	const configEnc = sealConfig(key, kind, parsed.config);
	await db
		.insert(notifyChannel)
		.values({ kind, enabled: true, ...kinds, configEnc })
		.onConflictDoUpdate({
			target: notifyChannel.kind,
			set: { ...kinds, configEnc, updatedAt: new Date() }
		});
	return { ok: true };
}

/** Turns a saved channel on or off, keeping its settings; false if there is none. */
export async function setEnabled(db: Db, kind: string, enabled: boolean): Promise<boolean> {
	const updated = await db
		.update(notifyChannel)
		.set({ enabled, updatedAt: new Date() })
		.where(eq(notifyChannel.kind, kind))
		.returning({ kind: notifyChannel.kind });
	return updated.length > 0;
}

/** Deletes the channel; its price-drop delivery rows go with it (FK cascade). */
export async function removeChannel(db: Db, kind: string): Promise<void> {
	await db.delete(notifyChannel).where(eq(notifyChannel.kind, kind));
}
