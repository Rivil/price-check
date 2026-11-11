import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	describeFailure,
	HINT_COPY,
	type FailureHint,
	type FailureReason
} from '#lib/server/alerts/channel.ts';
import {
	channelKinds,
	driverFor,
	listChannels,
	loadChannelConfig,
	removeChannel,
	saveChannel,
	setEnabled,
	UNKNOWN_KIND_MESSAGE,
	type Routing
} from '#lib/server/alerts/channels.ts';
import { alertsKey } from '#lib/server/alerts/crypto.ts';
import { db } from '#lib/server/db/index.ts';

// One card per channel type (decision channels_per_type). The ntfy topic link is
// shown to its owner on this page only (decision topic_url_secrecy); credentials
// never leave the server — the page learns only whether one is saved (c-7). No
// result here carries a typed or saved credential, nor a topic inside a message.

/** What the page sees of one saved channel; null when that type has none. */
export type ChannelCard = {
	enabled: boolean;
	priceDrops: boolean;
	checkFailures: boolean;
	/** Saved settings this server cannot decrypt: they must be entered again. */
	unreadable?: true;
	[field: string]: string | boolean | null | undefined;
};

const SAVE_FIRST = 'Save this channel first.';

function signedIn(locals: App.Locals) {
	const user = locals.user;
	if (!user) error(401, 'Sign in first');
	return user;
}

/** The submitted channel type, or null when it is missing or not a registered type. */
function kindOf(data: FormData): string | null {
	const kind = data.get('kind');
	return typeof kind === 'string' && driverFor(kind) !== undefined ? kind : null;
}

export const load: PageServerLoad = async ({ locals }) => {
	const user = signedIn(locals);
	const saved = await listChannels(db, alertsKey(), user.id);
	const channels: Record<string, ChannelCard | null> = {};
	for (const kind of channelKinds()) {
		const view = saved[kind];
		if (view === undefined) {
			channels[kind] = null;
			continue;
		}
		const flags = {
			enabled: view.enabled,
			priceDrops: view.priceDrops,
			checkFailures: view.checkFailures
		};
		channels[kind] = view.unreadable ? { ...flags, unreadable: true } : { ...view.view, ...flags };
	}
	// What a new card of each type starts ticked, from its driver (not hard-coded on
	// the page), and the login email the recipient of a new email card — Resend or
	// SMTP — starts as (decision recipient_default).
	const defaults: Record<string, Routing> = {};
	for (const kind of channelKinds()) {
		const kinds = driverFor(kind)!.defaultKinds;
		defaults[kind] = {
			priceDrops: kinds.includes('price_drop'),
			checkFailures: kinds.includes('check_failed')
		};
	}
	return { channels, defaults, loginEmail: user.email };
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const user = signedIn(locals);
		const data = await request.formData();
		const kind = kindOf(data);
		if (kind === null) return fail(400, { message: UNKNOWN_KIND_MESSAGE });
		// Every text field is handed to the driver; secrets are never echoed back.
		const form: Record<string, string | undefined> = {};
		for (const [name, value] of data) {
			if (typeof value === 'string') form[name] = value;
		}
		const saved = await saveChannel(db, alertsKey(), user.id, kind, form, {
			priceDrops: data.has('price_drops'),
			checkFailures: data.has('check_failures')
		});
		if (!saved.ok) return fail(400, { kind, message: saved.message });
		return { saved: kind };
	},

	enable: async ({ request, locals }) => toggle(request, locals, true),
	disable: async ({ request, locals }) => toggle(request, locals, false),

	remove: async ({ request, locals }) => {
		const user = signedIn(locals);
		const kind = kindOf(await request.formData());
		if (kind === null) return fail(400, { message: UNKNOWN_KIND_MESSAGE });
		await removeChannel(db, user.id, kind);
		return { removed: kind };
	},

	// A test goes out whatever the channel's enabled state and alert kinds.
	test: async ({ request, locals }) => {
		const user = signedIn(locals);
		const data = await request.formData();
		const kind = kindOf(data);
		if (kind === null) return fail(400, { message: UNKNOWN_KIND_MESSAGE });
		const config = await loadChannelConfig(db, alertsKey(), user.id, kind);
		if (config === null) return fail(400, { testKind: kind, testMessage: SAVE_FIRST });

		let failed: { reason: FailureReason; hint?: FailureHint } | null;
		try {
			const result = await driverFor(kind)!.send(
				config,
				{
					kind: 'test',
					title: 'Amazon price check',
					message: 'Test alert: your price alerts will arrive here.'
				},
				{ fetch: (input, init) => globalThis.fetch(input, init) }
			);
			failed = result.ok ? null : result;
		} catch {
			// Drivers never throw; if one does, its text could name a credential.
			failed = { reason: 'unreachable' };
		}
		if (failed !== null) {
			// A hint is a fixed key from the driver; only its fixed copy reaches the page.
			const hint = failed.hint === undefined ? '' : ` ${HINT_COPY[failed.hint]}`;
			return fail(502, {
				testKind: kind,
				testMessage: `Not delivered: ${describeFailure(failed.reason)}.${hint}`
			});
		}
		return { tested: kind };
	}
};

async function toggle(request: Request, locals: App.Locals, enabled: boolean) {
	const user = signedIn(locals);
	const kind = kindOf(await request.formData());
	if (kind === null) return fail(400, { message: UNKNOWN_KIND_MESSAGE });
	if (!(await setEnabled(db, user.id, kind, enabled))) {
		return fail(400, { kind, message: SAVE_FIRST });
	}
	return enabled ? { enabled: kind } : { disabled: kind };
}
