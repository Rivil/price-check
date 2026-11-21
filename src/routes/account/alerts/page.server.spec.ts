import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { isActionFailure } from '@sveltejs/kit';
import { HINT_COPY, type ChannelDriver, type ChannelKind } from '#lib/server/alerts/channel.ts';
import {
	NO_KINDS_MESSAGE,
	UNKNOWN_KIND_MESSAGE,
	channelKinds,
	channelsFor,
	ensureChannel,
	loadChannelConfig,
	registerDriver,
	saveChannel,
	setEnabled,
	type AnyDriver
} from '#lib/server/alerts/channels.ts';
import { setAlertsKey } from '#lib/server/alerts/crypto.ts';
import { installDesktop } from '#lib/server/alerts/desktop.ts';
import { NEW_ORIGIN_TOKEN_MESSAGE, SEND_TIMEOUT_MS } from '#lib/server/alerts/ntfy.ts';
import { API_KEY_MESSAGE, RECIPIENT_MESSAGE, SENDER_MESSAGE } from '#lib/server/alerts/resend.ts';
import {
	HOST_MESSAGE,
	NEW_DESTINATION_PASSWORD_MESSAGE,
	PASSWORD_MESSAGE,
	PORT_MESSAGE,
	RECIPIENT_MESSAGE as SMTP_RECIPIENT_MESSAGE,
	SENDER_MESSAGE as SMTP_SENDER_MESSAGE,
	USERNAME_MESSAGE,
	smtpDriver,
	type SmtpConfig
} from '#lib/server/alerts/smtp.ts';
import { startSmtpServer, type FakeSmtpServer } from '#lib/server/testing/smtp-server.ts';
import { notifyChannel, priceDropDelivery, watch } from '#lib/server/db/schema.ts';
import type { DesktopNotice, DesktopNotifier } from '#lib/server/notify-bridge.ts';
import { createTestDb, type TestDb } from '#lib/server/testing/test-db.ts';

const KEY = randomBytes(32);
const TOKEN = 'tk_abcdefghijklmnopqrstuvwxyz012'; // token-shaped, not a real one
const TOKEN_2 = 'tk_zyxwvutsrqponmlkjihgfedcba987';

// The route's db is a migrated temp SQLite; global fetch is stubbed, so the test
// send never reaches a real ntfy server.
const state = vi.hoisted(() => ({ t: null as TestDb | null }));
vi.mock('#lib/server/db/index.ts', () => ({
	get db() {
		return state.t!.db;
	}
}));

const { load, actions } = await import('./+page.server.ts');

type Event = Parameters<typeof load>[0];

/** A request with no session: locals is empty, as it is with no sign-in at all. */
function event(form?: Record<string, string>): Event {
	return {
		locals: {},
		request: new Request('http://localhost/account/alerts', {
			method: 'POST',
			body: new URLSearchParams(form ?? {})
		})
	} as unknown as Event;
}

/** The ntfy save form as the page posts it: both alert kinds ticked unless overridden. */
const ntfyForm = (fields: Record<string, string>, kinds = { drops: true, failures: true }) => ({
	kind: 'ntfy',
	...(kinds.drops ? { price_drops: 'on' } : {}),
	...(kinds.failures ? { check_failures: 'on' } : {}),
	...fields
});

/** An action failure as plain {status, data}, so toEqual also catches extra keys. */
const failure = (result: unknown) =>
	isActionFailure(result) ? { status: result.status, data: result.data } : result;

const db = () => state.t!.db;
const save = (topic: string, token = '') => saveChannel(db(), KEY, 'ntfy', { topic, token });

/** What a new card of each type starts ticked, from each driver's defaults. */
const DEFAULTS = {
	ntfy: { priceDrops: true, checkFailures: true },
	resend: { priceDrops: true, checkFailures: false },
	smtp: { priceDrops: true, checkFailures: false }
};

/** The whole of what load returns, given the channel cards. */
const page = (channels: Record<string, unknown>) => ({ channels, defaults: DEFAULTS });

beforeEach(async () => {
	setAlertsKey(KEY);
	state.t = await createTestDb();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	state.t!.dispose();
});

describe('account alerts page', () => {
	it('no sign-in', async () => {
		// Empty locals on a fresh install: three empty cards, no 401, no login email.
		const loaded = await load({ locals: {} } as unknown as Event);
		expect(loaded).toEqual({
			channels: { ntfy: null, resend: null, smtp: null },
			defaults: DEFAULTS
		});
		expect(loaded).not.toHaveProperty('loginEmail');

		// Every action runs with no session too.
		expect(await actions.save!(event(ntfyForm({ topic: 'https://ntfy.sh/no-session' })))).toEqual({
			saved: 'ntfy'
		});
		expect(await actions.disable!(event({ kind: 'ntfy' }))).toEqual({ disabled: 'ntfy' });
		expect(await actions.enable!(event({ kind: 'ntfy' }))).toEqual({ enabled: 'ntfy' });
		expect(await actions.remove!(event({ kind: 'ntfy' }))).toEqual({ removed: 'ntfy' });
		expect(await db().select().from(notifyChannel)).toEqual([]);
	});

	it('load', async () => {
		expect(await load(event())).toEqual(page({ ntfy: null, resend: null, smtp: null }));

		await save('https://ntfy.sh/alice-own', TOKEN);
		const loaded = await load(event());
		expect(loaded).toEqual(
			page({
				ntfy: {
					topic: 'https://ntfy.sh/alice-own',
					tokenSet: true,
					enabled: true,
					priceDrops: true,
					checkFailures: true
				},
				resend: null,
				smtp: null
			})
		);
	});

	it('save', async () => {
		expect(
			await actions.save!(
				event(ntfyForm({ topic: 'https://ntfy.sh/alice-own' }, { drops: true, failures: false }))
			)
		).toEqual({ saved: 'ntfy' });
		expect(await load(event())).toMatchObject({
			channels: {
				ntfy: { priceDrops: true, checkFailures: false, tokenSet: false },
				resend: null,
				smtp: null
			}
		});

		// Neither kind ticked: refused, nothing changed.
		const none = await actions.save!(
			event(ntfyForm({ topic: 'https://ntfy.sh/other' }, { drops: false, failures: false }))
		);
		expect(none).toMatchObject({
			status: 400,
			data: { kind: 'ntfy', message: expect.any(String) }
		});
		expect(await loadChannelConfig(db(), KEY, 'ntfy')).toEqual({
			url: 'https://ntfy.sh/alice-own',
			token: null
		});

		// An invalid topic is refused with the parser's message.
		const invalid = await actions.save!(event(ntfyForm({ topic: 'http://ntfy.sh/plain' })));
		expect(isActionFailure(invalid)).toBe(true);
		expect(invalid).toMatchObject({
			status: 400,
			data: { kind: 'ntfy', message: expect.stringContaining('ntfy topic link') }
		});

		// Both kinds ticked come back ticked (c-2).
		expect(await actions.save!(event(ntfyForm({ topic: 'https://ntfy.sh/alice-own' })))).toEqual({
			saved: 'ntfy'
		});
		expect(await load(event())).toMatchObject({
			channels: { ntfy: { priceDrops: true, checkFailures: true }, resend: null, smtp: null }
		});
	});

	it('send test', async () => {
		await save('https://ntfy.sh/alice-test', TOKEN);
		const fetch = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
		vi.stubGlobal('fetch', fetch);

		fetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
		expect(await actions.test!(event({ kind: 'ntfy' }))).toEqual({ tested: 'ntfy' });
		const [target, init] = fetch.mock.calls[0];
		expect(target).toBe('https://ntfy.sh/');
		// A test carries no priority: ntfy's default.
		expect(JSON.parse(String(init.body))).toEqual({
			topic: 'alice-test',
			title: 'Amazon price check',
			message: 'Test alert: your price alerts will arrive here.'
		});
		expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });

		for (const [respond, words] of [
			[() => fetch.mockResolvedValueOnce(new Response('', { status: 401 })), 'bad credentials'],
			[() => fetch.mockResolvedValueOnce(new Response('', { status: 500 })), 'refused'],
			[() => fetch.mockRejectedValueOnce(new TypeError('fetch failed')), 'unreachable']
		] as const) {
			respond();
			const result = await actions.test!(event({ kind: 'ntfy' }));
			expect(isActionFailure(result), words).toBe(true);
			expect(result, words).toEqual(
				expect.objectContaining({
					status: 502,
					data: { testKind: 'ntfy', testMessage: `Not delivered: ${words}.` }
				})
			);
		}

		// Never settles: the send's own timer reports a timeout.
		vi.useFakeTimers();
		fetch.mockImplementationOnce(() => new Promise<Response>(() => {}));
		const pending = actions.test!(event({ kind: 'ntfy' }));
		// The send arms its timer before calling fetch; wait for that (db reads are real I/O).
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
		await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
		expect(await pending).toEqual(
			expect.objectContaining({
				status: 502,
				data: { testKind: 'ntfy', testMessage: 'Not delivered: timeout.' }
			})
		);
	});

	it('test unsaved', async () => {
		const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetch);

		expect(await actions.test!(event({ kind: 'ntfy' }))).toEqual(
			expect.objectContaining({
				status: 400,
				data: { testKind: 'ntfy', testMessage: 'Save this channel first.' }
			})
		);
		// A saved channel of another kind is not this one.
		await saveChannel(db(), KEY, 'resend', {
			api_key: 're_AbCdEf12_3456789GhIjKlMnOpQrStUv',
			from: 'alerts@example.test',
			to: 'alice@example.test'
		});
		expect(await actions.test!(event({ kind: 'ntfy' }))).toMatchObject({ status: 400 });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('test disabled', async () => {
		const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetch);
		await save('https://ntfy.sh/alice-test');
		await setEnabled(db(), 'ntfy', false);

		expect(await actions.test!(event({ kind: 'ntfy' }))).toEqual({ tested: 'ntfy' });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('no echo', async () => {
		// Saved through the form; the page learns only that one exists.
		expect(
			await actions.save!(event(ntfyForm({ topic: 'https://ntfy.sh/alice-own', token: TOKEN })))
		).toEqual({ saved: 'ntfy' });
		const loaded = await load(event());
		expect(JSON.stringify(loaded)).not.toContain(TOKEN);

		// A failed save (bad token typed over a saved one) echoes neither token.
		const bad = await actions.save!(
			event(ntfyForm({ topic: 'https://ntfy.sh/alice-own', token: 'tk_short' }))
		);
		expect(bad).toMatchObject({
			status: 400,
			data: { message: expect.stringContaining('access token') }
		});
		for (const secret of ['tk_short', TOKEN, 'alice-own'])
			expect(JSON.stringify(bad)).not.toContain(secret);
		expect(await loadChannelConfig(db(), KEY, 'ntfy')).toEqual({
			url: 'https://ntfy.sh/alice-own',
			token: TOKEN
		});

		// Blank keeps it.
		await actions.save!(event(ntfyForm({ topic: 'https://ntfy.sh/alice-own', token: '' })));
		expect(await loadChannelConfig(db(), KEY, 'ntfy')).toMatchObject({ token: TOKEN });

		// A failed test whose thrown error carries both secrets reports neither.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError(`fetch failed https://ntfy.sh/alice-own ${TOKEN}`);
			})
		);
		const failed = await actions.test!(event({ kind: 'ntfy' }));
		expect(failed).toMatchObject({ status: 502 });
		for (const secret of ['alice-own', TOKEN]) expect(JSON.stringify(failed)).not.toContain(secret);

		for (const result of [
			await actions.enable!(event({ kind: 'ntfy' })),
			await actions.disable!(event({ kind: 'ntfy' })),
			await actions.remove!(event({ kind: 'ntfy' }))
		]) {
			for (const secret of ['alice-own', TOKEN])
				expect(JSON.stringify(result)).not.toContain(secret);
		}
	});

	it('toggle', async () => {
		await save('https://ntfy.sh/alice-own', TOKEN);

		expect(await actions.disable!(event({ kind: 'ntfy' }))).toEqual({ disabled: 'ntfy' });
		expect(await load(event())).toEqual(
			page({
				ntfy: {
					topic: 'https://ntfy.sh/alice-own',
					tokenSet: true,
					enabled: false,
					priceDrops: true,
					checkFailures: true
				},
				resend: null,
				smtp: null
			})
		);

		expect(await actions.enable!(event({ kind: 'ntfy' }))).toEqual({ enabled: 'ntfy' });
		expect(await load(event())).toMatchObject({
			channels: {
				ntfy: { enabled: true, topic: 'https://ntfy.sh/alice-own', tokenSet: true },
				resend: null,
				smtp: null
			}
		});

		// Nothing saved of that kind: nothing to toggle.
		expect(failure(await actions.disable!(event({ kind: 'resend' })))).toEqual({
			status: 400,
			data: { kind: 'resend', message: 'Save this channel first.' }
		});
		expect(await db().select().from(notifyChannel)).toHaveLength(1);
	});

	it('remove', async () => {
		await save('https://ntfy.sh/alice-own');
		await saveChannel(db(), KEY, 'resend', {
			api_key: 're_AbCdEf12_3456789GhIjKlMnOpQrStUv',
			from: 'alerts@example.test',
			to: 'inbox@example.test'
		});
		expect(await actions.remove!(event({ kind: 'ntfy' }))).toEqual({ removed: 'ntfy' });
		expect(await load(event())).toMatchObject({ channels: { ntfy: null, smtp: null } });
		// Only that kind goes.
		expect(await loadChannelConfig(db(), KEY, 'resend')).toMatchObject({
			to: 'inbox@example.test'
		});
	});

	it('guards', async () => {
		const forms: Record<string, string>[] = [
			ntfyForm({ topic: 'https://ntfy.sh/x', kind: 'bogus' }),
			{ topic: 'https://ntfy.sh/x', price_drops: 'on' }
		];
		for (const form of forms) {
			for (const action of ['save', 'enable', 'disable', 'remove', 'test'] as const) {
				const result = await actions[action]!(event(form));
				expect(isActionFailure(result), `${action} ${form.kind}`).toBe(true);
				expect(failure(result), `${action} ${form.kind}`).toEqual({
					status: 400,
					data: { message: UNKNOWN_KIND_MESSAGE }
				});
			}
		}
		expect(await db().select().from(notifyChannel)).toEqual([]);

		// A field posted as a file is ignored, not handed to the driver.
		const multipart = new FormData();
		multipart.set('kind', 'ntfy');
		multipart.set('price_drops', 'on');
		multipart.set('topic', new File(['https://ntfy.sh/x'], 'topic.txt'));
		const fileResult = await actions.save!({
			locals: {},
			request: new Request('http://localhost/account/alerts', { method: 'POST', body: multipart })
		} as unknown as Event);
		expect(failure(fileResult)).toEqual({
			status: 400,
			data: { kind: 'ntfy', message: expect.stringContaining('ntfy topic link') }
		});
		expect(await db().select().from(notifyChannel)).toEqual([]);
	});

	it('file token', async () => {
		// A token field posted as a file never reaches the driver: the save goes
		// through on the string topic and the saved token is kept, as if left blank.
		await save('https://ntfy.sh/alice-own', TOKEN);
		const multipart = new FormData();
		multipart.set('kind', 'ntfy');
		multipart.set('price_drops', 'on');
		multipart.set('topic', 'https://ntfy.sh/alice-new');
		multipart.set('token', new File([TOKEN_2], 'token.txt'));
		const result = await actions.save!({
			locals: {},
			request: new Request('http://localhost/account/alerts', { method: 'POST', body: multipart })
		} as unknown as Event);
		expect(result).toEqual({ saved: 'ntfy' });
		expect(await loadChannelConfig(db(), KEY, 'ntfy')).toEqual({
			url: 'https://ntfy.sh/alice-new',
			token: TOKEN
		});
	});

	it('clear token keeps channel', async () => {
		// Enabled or not, ticking Remove access token drops the token and nothing else.
		for (const enabled of [true, false]) {
			await save('https://ntfy.sh/alice-own', TOKEN);
			await setEnabled(db(), 'ntfy', enabled);
			const result = await actions.save!(
				event(ntfyForm({ topic: 'https://ntfy.sh/alice-own', token: '', clear_token: 'on' }))
			);
			expect(result, `enabled ${enabled}`).toEqual({ saved: 'ntfy' });
			expect(await load(event()), `enabled ${enabled}`).toEqual(
				page({
					ntfy: {
						topic: 'https://ntfy.sh/alice-own',
						tokenSet: false,
						enabled,
						priceDrops: true,
						checkFailures: true
					},
					resend: null,
					smtp: null
				})
			);
			expect(await loadChannelConfig(db(), KEY, 'ntfy')).toEqual({
				url: 'https://ntfy.sh/alice-own',
				token: null
			});
		}
	});

	it('new origin refused', async () => {
		// A saved token never follows the topic to another server (c-1): the save is
		// refused in the ntfy card and the stored row is left byte for byte.
		await save('https://ntfy.sh/alice-own', TOKEN);
		const before = await db().select().from(notifyChannel);
		expect(NEW_ORIGIN_TOKEN_MESSAGE).toContain('access token');
		for (const topic of [
			'https://ntfy.example.test/alice-own',
			'https://ntfy.sh:8443/alice-own',
			'https://127.0.0.1:1/alice-own'
		]) {
			const result = await actions.save!(event(ntfyForm({ topic, token: '' })));
			expect(failure(result), topic).toEqual({
				status: 400,
				data: { kind: 'ntfy', message: NEW_ORIGIN_TOKEN_MESSAGE }
			});
			expect(JSON.stringify(result), topic).not.toContain(TOKEN);
		}
		expect(await db().select().from(notifyChannel)).toEqual(before);
		expect(await loadChannelConfig(db(), KEY, 'ntfy')).toEqual({
			url: 'https://ntfy.sh/alice-own',
			token: TOKEN
		});
	});

	it('unreadable', async () => {
		await save('https://ntfy.sh/alice-own', TOKEN);
		// The server now runs with another key: the saved settings cannot be opened.
		setAlertsKey(randomBytes(32));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const loaded = await load(event());
		expect(loaded).toEqual(
			page({
				ntfy: { enabled: true, priceDrops: true, checkFailures: true, unreadable: true },
				resend: null,
				smtp: null
			})
		);
		for (const secret of ['alice-own', TOKEN]) expect(JSON.stringify(loaded)).not.toContain(secret);
	});

	it('throwing driver', async () => {
		// Drivers never throw; if one does, its text names the credential.
		const driver: ChannelDriver<{ secret: string }> = {
			kind: 'boom' as ChannelKind,
			defaultKinds: ['price_drop'],
			parseConfig: (form) => ({ ok: true, config: { secret: form.secret ?? '' } }),
			view: () => ({ secretSet: true }),
			send: async (config) => {
				throw new Error(`send failed ${config.secret} https://ntfy.sh/alice-own`);
			}
		};
		const undo = registerDriver(driver as AnyDriver);
		const logged = (['error', 'warn', 'log', 'info'] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation(() => {})
		);
		try {
			await saveChannel(db(), KEY, 'boom', { secret: TOKEN });
			const result = await actions.test!(event({ kind: 'boom' }));
			expect(failure(result)).toEqual({
				status: 502,
				data: { testKind: 'boom', testMessage: 'Not delivered: unreachable.' }
			});
			for (const spy of logged) expect(spy).not.toHaveBeenCalled();
		} finally {
			undo();
		}
	});
});

// Shaped like a Resend key; not a real one. Global fetch is stubbed throughout, so
// nothing reaches api.resend.com.
const RE_KEY = 're_AbCdEf12_3456789GhIjKlMnOpQrStUv';
const RE_KEY_2 = 're_ZyXw9876_secondKeyValue000';

/** The Resend save form as the page posts it: price drops ticked unless overridden. */
const resendForm = (
	fields: Record<string, string> = {},
	kinds = { drops: true, failures: false }
) => ({
	kind: 'resend',
	...(kinds.drops ? { price_drops: 'on' } : {}),
	...(kinds.failures ? { check_failures: 'on' } : {}),
	api_key: RE_KEY,
	from: 'alerts@example.test',
	to: 'alice@example.test',
	...fields
});

/** A Resend error response in its documented shape. */
const resendError = (statusCode: number, name: string, message: string) =>
	new Response(JSON.stringify({ statusCode, name, message }), {
		status: statusCode,
		headers: { 'content-type': 'application/json' }
	});

function multipartSave(fields: Record<string, string | File>) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	return actions.save!({
		locals: {},
		request: new Request('http://localhost/account/alerts', { method: 'POST', body })
	} as unknown as Event);
}

describe('resend card', () => {
	it('load resend', async () => {
		// Nothing saved: each type's defaults from its driver.
		expect(await load(event())).toEqual(page({ ntfy: null, resend: null, smtp: null }));

		expect(await actions.save!(event(resendForm()))).toEqual({ saved: 'resend' });
		const loaded = await load(event());
		expect(loaded).toEqual(
			page({
				ntfy: null,
				resend: {
					from: 'alerts@example.test',
					to: 'alice@example.test',
					keySet: true,
					enabled: true,
					priceDrops: true,
					checkFailures: false
				},
				smtp: null
			})
		);
		expect(JSON.stringify(loaded)).not.toContain(RE_KEY);
	});

	it('resend save refused', async () => {
		const cases: [Record<string, string>, string, string][] = [
			[{ api_key: '' }, API_KEY_MESSAGE, 'API key'],
			[{ api_key: 're_short' }, API_KEY_MESSAGE, 'API key'],
			[{ api_key: `${RE_KEY} trailing words` }, API_KEY_MESSAGE, 'API key'],
			[{ api_key: 'sk_not_a_resend_key_at_all' }, API_KEY_MESSAGE, 'API key'],
			[{ from: '' }, SENDER_MESSAGE, 'sender'],
			[{ from: 'Alerts <alerts@example.test>' }, SENDER_MESSAGE, 'sender'],
			[{ to: '' }, RECIPIENT_MESSAGE, 'recipient'],
			[{ to: 'a@example.test, b@example.test' }, RECIPIENT_MESSAGE, 'recipient']
		];
		for (const [fields, message, field] of cases) {
			const label = JSON.stringify(fields);
			const result = await actions.save!(event(resendForm(fields)));
			expect(failure(result), label).toEqual({ status: 400, data: { kind: 'resend', message } });
			expect(message, label).toContain(field);
			const typed = fields.api_key || RE_KEY;
			expect(JSON.stringify(result), label).not.toContain(typed);
		}
		expect(await db().select().from(notifyChannel)).toEqual([]);
	});

	it('resend test', async () => {
		const fetch = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
		vi.stubGlobal('fetch', fetch);
		await actions.save!(event(resendForm()));
		await save('https://ntfy.sh/alice-test');

		fetch.mockResolvedValueOnce(new Response('{"id":"x"}', { status: 200 }));
		expect(await actions.test!(event({ kind: 'resend' }))).toEqual({ tested: 'resend' });
		const [target, init] = fetch.mock.calls[0];
		expect(target).toBe('https://api.resend.com/emails');
		expect(init.headers).toMatchObject({ authorization: `Bearer ${RE_KEY}` });

		const domainHint = HINT_COPY.domain_unverified;
		expect(domainHint).toContain('domain is verified');
		for (const [response, kind, testMessage] of [
			[
				resendError(403, 'validation_error', 'The example.test domain is not verified.'),
				'resend',
				`Not delivered: refused. ${domainHint}`
			],
			[
				resendError(401, 'validation_error', 'API key is invalid'),
				'resend',
				'Not delivered: bad credentials.'
			],
			[
				resendError(429, 'rate_limit_exceeded', 'Too many requests.'),
				'resend',
				'Not delivered: refused.'
			],
			// ntfy never carries a hint, whatever its status or body says — not even the
			// 403 validation_error that earns Resend its hint.
			[
				resendError(403, 'validation_error', 'The example.test domain is not verified.'),
				'ntfy',
				'Not delivered: bad credentials.'
			],
			[
				resendError(500, 'validation_error', 'The example.test domain is not verified.'),
				'ntfy',
				'Not delivered: refused.'
			]
		] as const) {
			fetch.mockResolvedValueOnce(response);
			const result = await actions.test!(event({ kind }));
			expect(failure(result), testMessage).toEqual({
				status: 502,
				data: { testKind: kind, testMessage }
			});
			expect(JSON.stringify(result)).not.toContain('example.test domain');
			expect(JSON.stringify(result)).not.toContain(RE_KEY);
		}
	});

	it('file api key', async () => {
		// First save, key posted as a file: no key at all, so refused as missing.
		const fields = {
			kind: 'resend',
			price_drops: 'on',
			from: 'alerts@example.test',
			to: 'alice@example.test'
		};
		const first = await multipartSave({
			...fields,
			api_key: new File([RE_KEY], 'key.txt')
		});
		expect(failure(first)).toEqual({
			status: 400,
			data: { kind: 'resend', message: API_KEY_MESSAGE }
		});
		expect(await db().select().from(notifyChannel)).toEqual([]);

		// Over a saved key: the file is ignored and the saved key kept, as if left blank.
		expect(await actions.save!(event(resendForm()))).toEqual({ saved: 'resend' });
		const later = await multipartSave({
			...fields,
			to: 'other@example.test',
			api_key: new File([RE_KEY_2], 'key.txt')
		});
		expect(later).toEqual({ saved: 'resend' });
		expect(await loadChannelConfig(db(), KEY, 'resend')).toEqual({
			apiKey: RE_KEY,
			from: 'alerts@example.test',
			to: 'other@example.test'
		});
	});
});

// The SMTP card talks only to the in-process fake server on 127.0.0.1 (or a closed
// local port); nothing reaches a live mail host.
const SMTP_PASS = 'app-pass-Xq7Rk2Lm9Wz4';
const SMTP_PASS_2 = 'second-pass-Hb3Nd8Tc1';

/** The SMTP save form as the page posts it: price drops ticked unless overridden. */
const smtpForm = (
	fields: Record<string, string> = {},
	kinds = { drops: true, failures: false }
) => ({
	kind: 'smtp',
	...(kinds.drops ? { price_drops: 'on' } : {}),
	...(kinds.failures ? { check_failures: 'on' } : {}),
	host: 'smtp.example.test',
	port: '587',
	username: 'alice-login',
	password: SMTP_PASS,
	from: 'alerts@example.test',
	to: 'alice@example.test',
	...fields
});

describe('smtp card', () => {
	const servers: FakeSmtpServer[] = [];
	let undo: (() => void) | null = null;

	/** The real SMTP driver, trusting only the fake server's test CA in addition. */
	function trustFakeCa(ca: string) {
		const trusting: ChannelDriver<SmtpConfig> = {
			...smtpDriver,
			send: (config, alert, deps) => smtpDriver.send(config, alert, { ...deps, tlsCa: ca })
		};
		undo = registerDriver(trusting as AnyDriver);
	}

	async function server(options: Parameters<typeof startSmtpServer>[0] = {}) {
		const started = await startSmtpServer(options);
		servers.push(started);
		return started;
	}

	afterEach(async () => {
		undo?.();
		undo = null;
		await Promise.all(servers.splice(0).map((s) => s.close()));
	});

	it('load smtp', async () => {
		// Nothing saved: price drops only for a new SMTP card.
		const empty = await load(event());
		expect(empty).toEqual(page({ ntfy: null, resend: null, smtp: null }));
		expect(empty).toMatchObject({
			defaults: { smtp: { priceDrops: true, checkFailures: false } }
		});

		expect(await actions.save!(event(smtpForm()))).toEqual({ saved: 'smtp' });
		const loaded = await load(event());
		expect(loaded).toEqual(
			page({
				ntfy: null,
				resend: null,
				smtp: {
					host: 'smtp.example.test',
					port: '587',
					username: 'alice-login',
					from: 'alerts@example.test',
					to: 'alice@example.test',
					passwordSet: true,
					enabled: true,
					priceDrops: true,
					checkFailures: false
				}
			})
		);
		expect(JSON.stringify(loaded)).not.toContain(SMTP_PASS);
	});

	it('smtp save refused', async () => {
		const cases: [Record<string, string>, string, string][] = [
			[{ host: '' }, HOST_MESSAGE, 'host'],
			[{ host: 'smtp://smtp.example.test' }, HOST_MESSAGE, 'host'],
			[{ host: 'smtp.example.test\r\nRCPT TO:<x@y.z>' }, HOST_MESSAGE, 'host'],
			[{ port: '' }, PORT_MESSAGE, 'port'],
			[{ port: '0' }, PORT_MESSAGE, 'port'],
			[{ port: '65536' }, PORT_MESSAGE, 'port'],
			[{ port: '587x' }, PORT_MESSAGE, 'port'],
			[{ username: '' }, USERNAME_MESSAGE, 'username'],
			[{ password: '' }, PASSWORD_MESSAGE, 'password'],
			[{ password: `${SMTP_PASS}\r\nQUIT` }, PASSWORD_MESSAGE, 'password'],
			[{ from: '' }, SMTP_SENDER_MESSAGE, 'sender'],
			[{ from: 'Alerts <alerts@example.test>' }, SMTP_SENDER_MESSAGE, 'sender'],
			[{ to: '' }, SMTP_RECIPIENT_MESSAGE, 'recipient'],
			[{ to: 'a@example.test, b@example.test' }, SMTP_RECIPIENT_MESSAGE, 'recipient']
		];
		for (const [fields, message, field] of cases) {
			const label = JSON.stringify(fields);
			const result = await actions.save!(event(smtpForm(fields)));
			expect(failure(result), label).toEqual({ status: 400, data: { kind: 'smtp', message } });
			expect(message, label).toContain(field);
			expect(JSON.stringify(result), label).not.toContain(SMTP_PASS);
		}
		expect(await db().select().from(notifyChannel)).toEqual([]);
	});

	it('new destination refused', async () => {
		// A saved password never follows the login to another host, port or username
		// (c-1): refused in the SMTP card, and the stored row is left byte for byte.
		expect(await actions.save!(event(smtpForm()))).toEqual({ saved: 'smtp' });
		const before = await db().select().from(notifyChannel);
		expect(NEW_DESTINATION_PASSWORD_MESSAGE).toContain('password');
		const moves: Record<string, string>[] = [
			{ host: 'smtp.other.example.test' },
			{ port: '465' },
			{ username: 'bob-login' }
		];
		for (const fields of moves) {
			const label = JSON.stringify(fields);
			const result = await actions.save!(event(smtpForm({ ...fields, password: '' })));
			expect(failure(result), label).toEqual({
				status: 400,
				data: { kind: 'smtp', message: NEW_DESTINATION_PASSWORD_MESSAGE }
			});
			expect(JSON.stringify(result), label).not.toContain(SMTP_PASS);
		}
		expect(await db().select().from(notifyChannel)).toEqual(before);

		// The same destination with a blank password still saves, keeping the password.
		expect(
			await actions.save!(event(smtpForm({ password: '', to: 'other@example.test' })))
		).toEqual({ saved: 'smtp' });
		expect(await loadChannelConfig(db(), KEY, 'smtp')).toMatchObject({
			host: 'smtp.example.test',
			password: SMTP_PASS,
			to: 'other@example.test'
		});
	});

	it('smtp test', async () => {
		const ok = await server();
		trustFakeCa(ok.ca);
		const saveAt = (port: number) =>
			actions.save!(event(smtpForm({ host: '127.0.0.1', port: String(port) })));

		// starttls, trusted cert, accepting: the test email is delivered.
		expect(await saveAt(ok.port)).toEqual({ saved: 'smtp' });
		expect(await actions.test!(event({ kind: 'smtp' }))).toEqual({ tested: 'smtp' });
		expect(ok.messages).toHaveLength(1);
		expect(ok.auths.at(-1)).toMatchObject({ username: 'alice-login', password: SMTP_PASS });

		// Login rejected: bad credentials plus the app-password hint, and no server text.
		const appHint = HINT_COPY.app_password;
		expect(appHint).toContain('app password');
		ok.setMode('auth_reject', { authRejectText: `Bad login for ${SMTP_PASS}` });
		const rejected = await actions.test!(event({ kind: 'smtp' }));
		expect(failure(rejected)).toEqual({
			status: 502,
			data: { testKind: 'smtp', testMessage: `Not delivered: bad credentials. ${appHint}` }
		});
		expect(JSON.stringify(rejected)).not.toContain(SMTP_PASS);
		expect(JSON.stringify(rejected)).not.toContain('Bad login');

		// No STARTTLS offered: refused, no hint, and the password never sent.
		const plain = await server({ transport: 'no_starttls' });
		expect(await saveAt(plain.port)).toEqual({ saved: 'smtp' });
		expect(failure(await actions.test!(event({ kind: 'smtp' })))).toEqual({
			status: 502,
			data: { testKind: 'smtp', testMessage: 'Not delivered: refused.' }
		});
		expect(plain.auths).toEqual([]);

		// Nothing listening on the port: unreachable.
		const closed = await server();
		const closedPort = closed.port;
		await closed.close();
		expect(await saveAt(closedPort)).toEqual({ saved: 'smtp' });
		expect(failure(await actions.test!(event({ kind: 'smtp' })))).toEqual({
			status: 502,
			data: { testKind: 'smtp', testMessage: 'Not delivered: unreachable.' }
		});
	});

	it('file password', async () => {
		// First save, password posted as a file: no password at all, so refused as missing.
		const fields: Record<string, string> = smtpForm();
		delete fields.password;
		const first = await multipartSave({
			...fields,
			password: new File([SMTP_PASS], 'password.txt')
		});
		expect(failure(first)).toEqual({
			status: 400,
			data: { kind: 'smtp', message: PASSWORD_MESSAGE }
		});
		expect(await db().select().from(notifyChannel)).toEqual([]);

		// Over a saved password: the file is ignored and the saved one kept, as if left blank.
		expect(await actions.save!(event(smtpForm()))).toEqual({ saved: 'smtp' });
		const later = await multipartSave({
			...fields,
			to: 'other@example.test',
			password: new File([SMTP_PASS_2], 'password.txt')
		});
		expect(later).toEqual({ saved: 'smtp' });
		expect(await loadChannelConfig(db(), KEY, 'smtp')).toEqual({
			host: 'smtp.example.test',
			port: 587,
			username: 'alice-login',
			password: SMTP_PASS,
			from: 'alerts@example.test',
			to: 'other@example.test'
		});
	});
});

// The desktop card runs over a fake notifier: nothing here touches Electron or the
// OS. Global fetch is stubbed, so a desktop test that wrongly reached for it is caught.
describe('desktop card', () => {
	type Show = DesktopNotifier['show'];
	let show: Mock<Show>;
	let undo: (() => void) | null = null;

	const KEPT_MESSAGE = "The desktop channel can't be removed; disable it instead.";
	const SEEDED = { enabled: true, priceDrops: true, checkFailures: false };

	/** The notice passed to the nth show. */
	const notice = (n = 0): DesktopNotice => show.mock.calls[n][0];

	/** The desktop row's flags, or undefined when there is none. */
	async function desktopRow() {
		const rows = await db().select().from(notifyChannel);
		const row = rows.find((r) => r.kind === 'desktop');
		return (
			row && {
				enabled: row.enabled,
				priceDrops: row.priceDrops,
				checkFailures: row.checkFailures
			}
		);
	}

	const routed = async () =>
		(await channelsFor(db(), KEY, 'price_drop')).map((channel) => channel.kind);

	beforeEach(async () => {
		show = vi.fn<Show>(async () => ({ ok: true }));
		undo = await installDesktop(db(), KEY, { show }, { watchExists: async () => true });
	});
	afterEach(() => {
		undo?.();
		undo = null;
		// No cross-test leak: the rest of this file runs with no desktop driver.
		expect(channelKinds()).not.toContain('desktop');
	});

	it('load desktop', async () => {
		const loaded = await load(event());
		expect(loaded).toEqual({
			channels: { ntfy: null, resend: null, smtp: null, desktop: SEEDED },
			defaults: { ...DEFAULTS, desktop: { priceDrops: true, checkFailures: false } }
		});
		expect(loaded).not.toHaveProperty(['channels', 'desktop', 'unreadable']);
	});

	it('remove refused', async () => {
		await save('https://ntfy.sh/alice-own');
		await db().insert(watch).values({
			id: 'w1',
			shop: 'amazon-uk',
			productId: 'B000000001',
			canonicalUrl: 'https://www.amazon.co.uk/dp/B000000001'
		});
		await db()
			.insert(priceDropDelivery)
			.values([
				{ watchId: 'w1', kind: 'desktop', targetPence: 1000 },
				{ watchId: 'w1', kind: 'ntfy', targetPence: 1000 }
			]);
		const deliveries = async () =>
			(await db().select().from(priceDropDelivery)).map((row) => row.kind).sort();

		expect(failure(await actions.remove!(event({ kind: 'desktop' })))).toEqual({
			status: 400,
			data: { kind: 'desktop', message: KEPT_MESSAGE }
		});
		expect(await desktopRow()).toEqual(SEEDED);
		expect(await loadChannelConfig(db(), KEY, 'desktop')).toEqual({});
		expect(await deliveries()).toEqual(['desktop', 'ntfy']);

		// Other kinds are still removable, and take only their own rows with them.
		expect(await actions.remove!(event({ kind: 'ntfy' }))).toEqual({ removed: 'ntfy' });
		expect((await db().select().from(notifyChannel)).map((row) => row.kind)).toEqual(['desktop']);
		expect(await deliveries()).toEqual(['desktop']);
	});

	it('save desktop', async () => {
		expect(await actions.save!(event({ kind: 'desktop', check_failures: 'on' }))).toEqual({
			saved: 'desktop'
		});
		const failuresOnly = { enabled: true, priceDrops: false, checkFailures: true };
		expect(await desktopRow()).toEqual(failuresOnly);
		expect(await load(event())).toMatchObject({ channels: { desktop: failuresOnly } });

		// Neither kind ticked: refused, nothing changed.
		expect(failure(await actions.save!(event({ kind: 'desktop' })))).toEqual({
			status: 400,
			data: { kind: 'desktop', message: NO_KINDS_MESSAGE }
		});
		expect(await desktopRow()).toEqual(failuresOnly);
		expect(await loadChannelConfig(db(), KEY, 'desktop')).toEqual({});
	});

	it('disable desktop', async () => {
		expect(await routed()).toEqual(['desktop']);

		expect(await actions.disable!(event({ kind: 'desktop' }))).toEqual({ disabled: 'desktop' });
		expect(await desktopRow()).toEqual({ ...SEEDED, enabled: false });
		expect(await routed()).toEqual([]);

		expect(await actions.enable!(event({ kind: 'desktop' }))).toEqual({ enabled: 'desktop' });
		expect(await routed()).toEqual(['desktop']);
	});

	it('test desktop', async () => {
		const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetch);

		expect(await actions.test!(event({ kind: 'desktop' }))).toEqual({ tested: 'desktop' });
		expect(show).toHaveBeenCalledOnce();
		expect(await notice().clickPath()).toBe('/account/alerts');

		show.mockResolvedValueOnce({ ok: false, reason: 'unsupported' });
		expect(failure(await actions.test!(event({ kind: 'desktop' })))).toEqual({
			status: 502,
			data: { testKind: 'desktop', testMessage: 'Not delivered: notifications not supported.' }
		});
		expect(show).toHaveBeenCalledTimes(2);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('test disabled desktop', async () => {
		await actions.disable!(event({ kind: 'desktop' }));

		expect(await actions.test!(event({ kind: 'desktop' }))).toEqual({ tested: 'desktop' });
		expect(show).toHaveBeenCalledOnce();
	});
});

describe('no desktop driver', () => {
	it('no desktop key', async () => {
		// Even a stored desktop row stays off the page while no notifier is published.
		await ensureChannel(db(), KEY, 'desktop', { priceDrops: true, checkFailures: false });
		expect(channelKinds()).not.toContain('desktop');

		const loaded = await load(event());
		expect(loaded).not.toHaveProperty(['channels', 'desktop']);
		expect(loaded).not.toHaveProperty(['defaults', 'desktop']);
		expect(loaded).toEqual(page({ ntfy: null, resend: null, smtp: null }));
	});
});
