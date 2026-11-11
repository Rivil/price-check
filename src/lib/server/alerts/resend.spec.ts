import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { HINT_COPY, type Alert, type DriverDeps, type SendResult } from './channel.ts';
import { channelKinds } from './channels.ts';
import {
	API_KEY_MESSAGE,
	RECIPIENT_MESSAGE,
	RESEND_ENDPOINT,
	SENDER_MESSAGE,
	resendDriver,
	type ResendConfig
} from './resend.ts';

// Every fetch here is a stub: nothing reaches api.resend.com.

// Shaped like a Resend key; not a real one.
const KEY = 're_AbCdEf12_3456789GhIjKlMnOpQrStUv';
const KEY_2 = 're_ZyXw9876_secondKeyValue000';
const CONFIG: ResendConfig = { apiKey: KEY, from: 's@example.com', to: 'r@example.com' };
const DROP: Alert = {
	kind: 'price_drop',
	title: 'Price drop: Acme Kettle™ — now £19.99',
	message: 'Price £19.99 is at or below your £20.00 target',
	click: 'https://www.amazon.co.uk/dp/B0ABC12345'
};
const TEST_ALERT: Alert = { kind: 'test', title: 'Test alert', message: 'It works.' };

function stubFetch(answer: () => Promise<Response> | Response) {
	return vi.fn<DriverDeps['fetch']>(async () => answer());
}

/** A Resend error response in its documented shape. */
function resendError(statusCode: number, name: string, message: string) {
	return () =>
		new Response(JSON.stringify({ statusCode, name, message }), {
			status: statusCode,
			headers: { 'content-type': 'application/json' }
		});
}

function send(fetch: DriverDeps['fetch'], extra: Partial<DriverDeps> = {}, alert = DROP) {
	return resendDriver.send(CONFIG, alert, { fetch, ...extra });
}

describe('resend send', () => {
	afterEach(() => vi.useRealTimers());

	it('wire', async () => {
		const fetch = stubFetch(() => new Response('{"id":"x"}', { status: 200 }));

		expect(await send(fetch)).toEqual({ ok: true });
		expect(fetch).toHaveBeenCalledOnce();
		const [target, init] = fetch.mock.calls[0];
		expect(target).toBe('https://api.resend.com/emails');
		expect(RESEND_ENDPOINT).toBe('https://api.resend.com/emails');
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({
			'content-type': 'application/json',
			authorization: `Bearer ${KEY}`
		});
		expect(init.redirect).toBe('manual');
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(String(init.body))).toEqual({
			from: 'Price check <s@example.com>',
			to: ['r@example.com'],
			subject: DROP.title,
			text: `${DROP.message}\n\nhttps://www.amazon.co.uk/dp/B0ABC12345`
		});

		// A test alert has no link: the text is the message alone.
		await send(fetch, {}, TEST_ALERT);
		expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toEqual({
			from: 'Price check <s@example.com>',
			to: ['r@example.com'],
			subject: 'Test alert',
			text: 'It works.'
		});
	});

	it('classify', async () => {
		const bad: SendResult = { ok: false, reason: 'bad_credentials' };
		const refused: SendResult = { ok: false, reason: 'refused' };
		const cases: [string, () => Response, SendResult][] = [
			['201', () => new Response('{"id":"x"}', { status: 201 }), { ok: true }],
			[
				'401 missing_api_key',
				resendError(401, 'missing_api_key', 'Missing API key in the authorization header.'),
				{ ...bad, status: 401 }
			],
			[
				'401 validation_error',
				resendError(401, 'validation_error', 'API key is invalid'),
				{ ...bad, status: 401 }
			],
			[
				'401 restricted_api_key',
				resendError(401, 'restricted_api_key', 'This API key is restricted to only send emails.'),
				{ ...bad, status: 401 }
			],
			[
				'403 restricted_api_key',
				resendError(403, 'restricted_api_key', 'This API key is restricted to only send emails.'),
				{ ...bad, status: 403 }
			],
			[
				'403 suspended_api_key',
				resendError(403, 'suspended_api_key', 'This API key has been suspended.'),
				{ ...bad, status: 403 }
			],
			[
				'401 not JSON',
				() => new Response('Unauthorized', { status: 401 }),
				{ ...bad, status: 401 }
			],
			[
				'403 validation_error domain',
				resendError(403, 'validation_error', 'The example.com domain is not verified.'),
				{ ...refused, status: 403, hint: 'domain_unverified' }
			],
			[
				'403 validation_error testing recipient',
				resendError(
					403,
					'validation_error',
					'You can only send testing emails to your own email address.'
				),
				{ ...refused, status: 403, hint: 'domain_unverified' }
			],
			[
				'422 validation_error',
				resendError(422, 'validation_error', 'Invalid `to` field.'),
				{ ...refused, status: 422 }
			],
			[
				'422 missing_required_field',
				resendError(422, 'missing_required_field', 'Missing `to` field.'),
				{ ...refused, status: 422 }
			],
			[
				'429 rate_limit_exceeded',
				resendError(429, 'rate_limit_exceeded', 'Too many requests.'),
				{ ...refused, status: 429 }
			],
			[
				'429 daily_quota_exceeded',
				resendError(429, 'daily_quota_exceeded', 'You have reached your daily email quota.'),
				{ ...refused, status: 429 }
			],
			[
				'500 application_error',
				resendError(500, 'application_error', 'An unexpected error occurred.'),
				{ ...refused, status: 500 }
			],
			[
				'403 not JSON',
				() => new Response('Forbidden', { status: 403 }),
				{ ...refused, status: 403 }
			]
		];
		for (const [name, reply, expected] of cases) {
			expect(await send(stubFetch(reply)), name).toEqual(expected);
		}
	});

	it('transport', async () => {
		expect(await send(stubFetch(() => Promise.reject(new TypeError('fetch failed'))))).toEqual({
			ok: false,
			reason: 'unreachable'
		});
		expect(await send(stubFetch(() => Promise.reject('a plain string')))).toEqual({
			ok: false,
			reason: 'unreachable'
		});

		// A fetch that never settles, not even on abort, still ends as a timeout.
		const hung = vi.fn<DriverDeps['fetch']>(() => new Promise<Response>(() => {}));
		expect(await send(hung, { timeoutMs: 5 })).toEqual({ ok: false, reason: 'timeout' });
		expect(hung.mock.calls[0][1].signal?.aborted).toBe(true);

		// A send that answers at once leaves no timeout timer behind.
		vi.useFakeTimers();
		expect(await send(stubFetch(() => new Response('{"id":"x"}', { status: 200 })))).toEqual({
			ok: true
		});
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();

		// Behaves like a real fetch: follows the redirect unless told not to.
		const redirecting: Mock<DriverDeps['fetch']> = vi.fn(async (url, init) => {
			if (url !== RESEND_ENDPOINT) return new Response('{"id":"x"}', { status: 200 });
			if (init.redirect === 'manual') {
				return new Response(null, {
					status: 302,
					headers: { location: 'https://elsewhere.example/' }
				});
			}
			return redirecting('https://elsewhere.example/', init);
		});
		expect(await send(redirecting)).toEqual({ ok: false, reason: 'refused', status: 302 });
		expect(redirecting.mock.calls.map(([url]) => url)).toEqual([RESEND_ENDPOINT]);
	});

	it('no text in results', async () => {
		const leaky = `request failed with ${KEY} for s@example.com`;
		const results = [
			await send(stubFetch(() => Promise.reject(new TypeError(leaky)))),
			await send(stubFetch(resendError(401, 'validation_error', leaky))),
			await send(stubFetch(resendError(403, 'validation_error', leaky)))
		];
		expect(results).toEqual([
			{ ok: false, reason: 'unreachable' },
			{ ok: false, reason: 'bad_credentials', status: 401 },
			{ ok: false, reason: 'refused', status: 403, hint: 'domain_unverified' }
		]);
		for (const result of results) {
			expect(JSON.stringify(result)).not.toContain(KEY);
			expect(JSON.stringify(result)).not.toContain('request failed');
		}
	});

	it('saved config that no longer parses is refused unsent', async () => {
		const fetch = stubFetch(() => new Response('{}', { status: 200 }));
		for (const config of [
			{ ...CONFIG, apiKey: `${KEY}\r\nx-evil: 1` },
			{ ...CONFIG, from: 'Alice <a@x.com>' },
			{ ...CONFIG, to: 'a@x.com, b@y.com' }
		]) {
			expect(await resendDriver.send(config, DROP, { fetch })).toEqual({
				ok: false,
				reason: 'refused'
			});
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('resend config', () => {
	const form = (fields: Record<string, string | undefined>) => ({
		api_key: KEY,
		from: 's@example.com',
		to: 'r@example.com',
		...fields
	});

	it('parse', () => {
		expect(resendDriver.parseConfig(form({}), null)).toEqual({ ok: true, config: CONFIG });
		expect(
			resendDriver.parseConfig(
				form({ api_key: `  ${KEY}  `, from: ' s@example.com ', to: ' r@example.com ' }),
				null
			)
		).toEqual({ ok: true, config: CONFIG });
		expect(resendDriver.parseConfig(form({ api_key: 're_abc-DEF_12345678' }), null)).toMatchObject({
			ok: true
		});

		// 254 characters is the longest address either field takes.
		const longest = `${'a'.repeat(248)}@x.com`;
		expect(longest).toHaveLength(254);
		expect(resendDriver.parseConfig(form({ from: longest, to: longest }), null)).toEqual({
			ok: true,
			config: { ...CONFIG, from: longest, to: longest }
		});
		expect(resendDriver.parseConfig(form({ from: `a${longest}` }), null)).toEqual({
			ok: false,
			message: SENDER_MESSAGE
		});
		expect(resendDriver.parseConfig(form({ to: `a${longest}` }), null)).toEqual({
			ok: false,
			message: RECIPIENT_MESSAGE
		});

		const typedKeys = [
			'abcdefghijklmnop', // no re_ prefix
			're_short',
			`re_${'a'.repeat(201)}`,
			`${KEY}\r\nx-evil: 1`,
			're_has space inside1',
			`Bearer ${KEY}`
		];
		const cases: [Record<string, string | undefined>, string][] = [
			[{ api_key: undefined }, API_KEY_MESSAGE],
			[{ api_key: '' }, API_KEY_MESSAGE],
			[{ api_key: '   ' }, API_KEY_MESSAGE],
			...typedKeys.map((key): [Record<string, string>, string] => [
				{ api_key: key },
				API_KEY_MESSAGE
			]),
			[{ from: undefined }, SENDER_MESSAGE],
			[{ from: '' }, SENDER_MESSAGE],
			[{ from: 'not-an-address' }, SENDER_MESSAGE],
			[{ from: 'Alice <a@x.com>' }, SENDER_MESSAGE],
			[{ from: 'a@x.com, b@y.com' }, SENDER_MESSAGE],
			[{ from: 'a@x.com\r\nBcc: e@evil.example' }, SENDER_MESSAGE],
			[{ from: `${'a'.repeat(250)}@x.com` }, SENDER_MESSAGE],
			[{ to: undefined }, RECIPIENT_MESSAGE],
			[{ to: '' }, RECIPIENT_MESSAGE],
			[{ to: 'r@localhost' }, RECIPIENT_MESSAGE],
			[{ to: 'Alice <a@x.com>' }, RECIPIENT_MESSAGE],
			[{ to: 'a@x.com, b@y.com' }, RECIPIENT_MESSAGE],
			[{ to: 'a@x.com;b@y.com' }, RECIPIENT_MESSAGE]
		];
		for (const [fields, message] of cases) {
			const label = JSON.stringify(fields);
			const result = resendDriver.parseConfig(form(fields), null);
			expect(result, label).toEqual({ ok: false, message });
			if (fields.api_key) expect(JSON.stringify(result), label).not.toContain(fields.api_key);
		}

		// Each refusal names its field.
		expect(API_KEY_MESSAGE).toContain('API key');
		expect(SENDER_MESSAGE).toContain('sender');
		expect(RECIPIENT_MESSAGE).toContain('recipient');

		// A bad sender or recipient never echoes the typed key either.
		for (const fields of [{ from: 'nope' }, { to: 'nope' }]) {
			expect(JSON.stringify(resendDriver.parseConfig(form(fields), null))).not.toContain(KEY);
		}
	});

	it('write-only key', () => {
		// Blank keeps the saved key; a new one replaces it.
		expect(resendDriver.parseConfig(form({ api_key: '' }), CONFIG)).toEqual({
			ok: true,
			config: CONFIG
		});
		expect(
			resendDriver.parseConfig(form({ api_key: undefined, to: 'other@example.com' }), CONFIG)
		).toEqual({ ok: true, config: { ...CONFIG, to: 'other@example.com' } });
		expect(resendDriver.parseConfig(form({ api_key: KEY_2 }), CONFIG)).toEqual({
			ok: true,
			config: { ...CONFIG, apiKey: KEY_2 }
		});
		// Blank with nothing saved: refused as missing.
		expect(resendDriver.parseConfig(form({ api_key: '' }), null)).toEqual({
			ok: false,
			message: API_KEY_MESSAGE
		});

		const view = resendDriver.view(CONFIG);
		expect(view).toEqual({ from: 's@example.com', to: 'r@example.com', keySet: true });
		expect(JSON.stringify(view)).not.toContain(KEY);
	});

	it('driver', () => {
		expect(resendDriver.kind).toBe('resend');
		expect(resendDriver.defaultKinds).toEqual(['price_drop']);
		expect(HINT_COPY.domain_unverified).toBe("Check the sender's domain is verified in Resend.");
		expect(channelKinds()).toEqual(['ntfy', 'resend', 'smtp']);
	});
});
