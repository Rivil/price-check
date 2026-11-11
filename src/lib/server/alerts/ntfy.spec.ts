import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { describeFailure, type Alert, type FailureReason, type SendResult } from './channel.ts';
import {
	SEND_TIMEOUT_MS,
	ntfyDriver,
	parseToken,
	parseTopicUrl,
	sendNtfy,
	type SendDeps
} from './ntfy.ts';

// Every fetch here is a stub: nothing reaches a real ntfy server.

describe('parseTopicUrl', () => {
	it('topic url', () => {
		for (const [input, server, topic] of [
			['https://ntfy.sh/alice-alerts_1', 'https://ntfy.sh/', 'alice-alerts_1'],
			['  https://ntfy.sh/abc  ', 'https://ntfy.sh/', 'abc'],
			['https://ntfy.sh/abc/', 'https://ntfy.sh/', 'abc'],
			['https://push.example.org/ntfy/home', 'https://push.example.org/ntfy/', 'home'],
			['https://push.example.org:8443/a/b/topic', 'https://push.example.org:8443/a/b/', 'topic']
		]) {
			expect(parseTopicUrl(input), input).toEqual({
				ok: true,
				url: `${server}${topic}`,
				server,
				topic
			});
		}
		for (const input of [
			'',
			'ntfy.sh/abc',
			'http://ntfy.sh/abc',
			'https://ntfy.sh',
			'https://ntfy.sh/',
			'https://user:pw@ntfy.sh/abc',
			'https://user@ntfy.sh/abc',
			'https://:pw@ntfy.sh/abc',
			'https://ntfy.sh/abc?auth=x',
			'https://ntfy.sh/abc#x',
			'https://ntfy.sh/has%20space',
			'https://ntfy.sh/emoji-🙂',
			`https://ntfy.sh/${'a'.repeat(65)}`,
			'not a url'
		]) {
			const result = parseTopicUrl(input);
			expect(result.ok, input).toBe(false);
			expect(result).toMatchObject({
				message: expect.stringContaining('https://ntfy.sh/your-topic')
			});
		}
		expect(parseTopicUrl(`https://ntfy.sh/${'a'.repeat(64)}`).ok).toBe(true);
	});
});

const TOPIC_URL = 'https://ntfy.sh/secret-topic-123';

function stubFetch(answer: () => Promise<Response> | Response) {
	return vi.fn<SendDeps['fetch']>(async () => answer());
}

// The shape `ntfy token add` prints: tk_ and 29 letters/digits. Not a real token.
const TOKEN = 'tk_abcdefghijklmnopqrstuvwxyz012';

describe('parseToken', () => {
	it('token', () => {
		expect(parseToken('')).toEqual({ ok: true, token: null });
		expect(parseToken('   ')).toEqual({ ok: true, token: null });
		expect(parseToken(`  ${TOKEN}  `)).toEqual({ ok: true, token: TOKEN });
		expect(parseToken(`tk_${'a'.repeat(20)}`)).toEqual({ ok: true, token: `tk_${'a'.repeat(20)}` });
		expect(parseToken(`tk_${'a'.repeat(64)}`)).toEqual({ ok: true, token: `tk_${'a'.repeat(64)}` });

		for (const bad of [
			'abcdefghijklmnopqrstuvwxyz012', // no tk_ prefix
			`tk_${'a'.repeat(19)}`, // too short
			`tk_${'a'.repeat(65)}`, // too long
			`${TOKEN}\r\nx-evil: 1`, // never into a header
			'tk_abcdefghij klmnopqrstuvwxyz',
			'Bearer tk_abcdefghijklmnopqrstuvwxyz012'
		]) {
			expect(parseToken(bad), bad).toEqual({
				ok: false,
				message: 'Enter an ntfy access token like tk_… (from `ntfy token add`), or leave it empty'
			});
		}
	});
});

const NOTE = { title: 't', message: 'm' };

/** The JSON body of the nth fetch call. */
function body(fetch: ReturnType<typeof stubFetch>, n = 0) {
	return JSON.parse(String(fetch.mock.calls[n][1].body));
}

describe('sendNtfy', () => {
	afterEach(() => vi.useRealTimers());

	it('send', async () => {
		const fetch = stubFetch(() => new Response('{}', { status: 200 }));
		const note = {
			title: 'Acme Kettle™ — now £19.99',
			message: 'Price £19.99 is at or below your £20.00 target',
			click: 'https://www.amazon.co.uk/dp/B0ABC12345'
		};

		expect(await sendNtfy(TOPIC_URL, note, { fetch })).toEqual({ ok: true });

		expect(fetch).toHaveBeenCalledOnce();
		const [target, init] = fetch.mock.calls[0];
		expect(target).toBe('https://ntfy.sh/');
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({ 'content-type': 'application/json' });
		expect(body(fetch)).toEqual({ topic: 'secret-topic-123', ...note });
		expect(init.signal).toBeInstanceOf(AbortSignal);

		// No click and no priority: the keys are left out, not sent empty.
		await sendNtfy(TOPIC_URL, NOTE, { fetch });
		expect(body(fetch, 1)).toEqual({ topic: 'secret-topic-123', title: 't', message: 'm' });

		await sendNtfy(TOPIC_URL, { ...NOTE, priority: 4 }, { fetch });
		expect(body(fetch, 2)).toEqual({
			topic: 'secret-topic-123',
			title: 't',
			message: 'm',
			priority: 4
		});
	});

	it('auth header', async () => {
		const fetch = stubFetch(() => new Response('{}', { status: 200 }));

		expect(await sendNtfy(TOPIC_URL, NOTE, { fetch, token: TOKEN })).toEqual({ ok: true });
		expect(fetch.mock.calls[0][1].headers).toEqual({
			'content-type': 'application/json',
			authorization: `Bearer ${TOKEN}`
		});

		// No token, or an explicit null: no authorization header at all.
		await sendNtfy(TOPIC_URL, NOTE, { fetch });
		await sendNtfy(TOPIC_URL, NOTE, { fetch, token: null });
		for (const n of [1, 2]) {
			expect(fetch.mock.calls[n][1].headers).toEqual({ 'content-type': 'application/json' });
		}

		// The driver sends the saved config's token, and none when there is none.
		const alert: Alert = { kind: 'test', ...NOTE };
		await ntfyDriver.send({ url: TOPIC_URL, token: TOKEN }, alert, { fetch });
		await ntfyDriver.send({ url: TOPIC_URL, token: null }, alert, { fetch });
		expect(fetch.mock.calls[3][1].headers).toEqual({
			'content-type': 'application/json',
			authorization: `Bearer ${TOKEN}`
		});
		expect(fetch.mock.calls[4][1].headers).toEqual({ 'content-type': 'application/json' });
	});

	it('classify', async () => {
		const answer = (status: number) => () => new Response(null, { status });
		const cases: [string, () => Promise<Response> | Response, SendResult][] = [
			['200', answer(200), { ok: true }],
			['204', answer(204), { ok: true }],
			['401', answer(401), { ok: false, reason: 'bad_credentials', status: 401 }],
			['403', answer(403), { ok: false, reason: 'bad_credentials', status: 403 }],
			['400', answer(400), { ok: false, reason: 'refused', status: 400 }],
			['404', answer(404), { ok: false, reason: 'refused', status: 404 }],
			['429', answer(429), { ok: false, reason: 'refused', status: 429 }],
			['500', answer(500), { ok: false, reason: 'refused', status: 500 }],
			[
				'rejected',
				() => Promise.reject(new TypeError('fetch failed')),
				{ ok: false, reason: 'unreachable' }
			],
			['non-Error', () => Promise.reject('a plain string'), { ok: false, reason: 'unreachable' }]
		];
		for (const [name, reply, expected] of cases) {
			expect(await sendNtfy(TOPIC_URL, NOTE, { fetch: stubFetch(reply) }), name).toEqual(expected);
		}

		// A fetch that never settles, not even on abort, still ends as a timeout.
		const hung = vi.fn<SendDeps['fetch']>(() => new Promise<Response>(() => {}));
		expect(await sendNtfy(TOPIC_URL, NOTE, { fetch: hung, timeoutMs: 5 })).toEqual({
			ok: false,
			reason: 'timeout'
		});
		expect(hung.mock.calls[0][1].signal?.aborted).toBe(true);
	});

	it('redirect', async () => {
		// Behaves like a real fetch: follows the redirect unless told not to.
		const fetch: Mock<SendDeps['fetch']> = vi.fn(async (url, init) => {
			if (url !== 'https://ntfy.sh/') return new Response('{}', { status: 200 });
			if (init.redirect === 'manual') {
				return new Response(null, {
					status: 302,
					headers: { location: 'https://elsewhere.example/' }
				});
			}
			return fetch('https://elsewhere.example/', init);
		});

		const result = await sendNtfy(TOPIC_URL, NOTE, { fetch, token: TOKEN });

		expect(result).toEqual({ ok: false, reason: 'refused', status: 302 });
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://ntfy.sh/']);
	});

	it('no text in results', async () => {
		const leaky = `fetch failed ${TOPIC_URL} ${TOKEN}`;
		const results = [
			await sendNtfy(TOPIC_URL, NOTE, {
				fetch: stubFetch(() => Promise.reject(new TypeError(leaky))),
				token: TOKEN
			}),
			await sendNtfy(TOPIC_URL, NOTE, {
				fetch: stubFetch(() => new Response(leaky, { status: 403 })),
				token: TOKEN
			}),
			await ntfyDriver.send(
				{ url: TOPIC_URL, token: TOKEN },
				{ kind: 'price_drop', ...NOTE },
				{ fetch: stubFetch(() => Promise.reject(new TypeError(leaky))) }
			)
		];
		expect(results).toEqual([
			{ ok: false, reason: 'unreachable' },
			{ ok: false, reason: 'bad_credentials', status: 403 },
			{ ok: false, reason: 'unreachable' }
		]);
		for (const result of results) {
			expect(JSON.stringify(result)).not.toContain('secret-topic');
			expect(JSON.stringify(result)).not.toContain(TOKEN);
		}
	});

	it('bad topic', async () => {
		const fetch = stubFetch(() => new Response('{}', { status: 200 }));

		expect(await sendNtfy('http://ntfy.sh/secret-topic-123', NOTE, { fetch })).toEqual({
			ok: false,
			reason: 'refused'
		});
		expect(
			await ntfyDriver.send({ url: 'not a url', token: null }, { kind: 'test', ...NOTE }, { fetch })
		).toEqual({ ok: false, reason: 'refused' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('timeout', async () => {
		vi.useFakeTimers();
		expect(SEND_TIMEOUT_MS).toBe(10_000);
		const fetch = vi.fn<SendDeps['fetch']>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		);
		let settled: unknown = 'pending';
		const pending = sendNtfy(TOPIC_URL, NOTE, { fetch }).then((r) => {
			settled = r;
		});

		await vi.advanceTimersByTimeAsync(9_999);
		expect(settled).toBe('pending');
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(settled).toEqual({ ok: false, reason: 'timeout' });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('timer cleanup', async () => {
		vi.useFakeTimers();
		await sendNtfy(TOPIC_URL, NOTE, { fetch: stubFetch(() => new Response()) });
		await sendNtfy(TOPIC_URL, NOTE, {
			fetch: stubFetch(() => {
				throw new Error('x');
			})
		});
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('ntfyDriver', () => {
	const ALERT = {
		title: 'Price drop: Acme Kettle',
		message: 'Acme Kettle is now £15.00, at or below your £20.00 target.',
		click: 'https://www.amazon.co.uk/dp/B0ABC12345'
	};

	it('contract', () => {
		expect(ntfyDriver.kind).toBe('ntfy');
		expect(ntfyDriver.defaultKinds).toEqual(['price_drop', 'check_failed']);
	});

	it('priority', async () => {
		const fetch = stubFetch(() => new Response('{}', { status: 200 }));
		const config = { url: TOPIC_URL, token: null };

		expect(await ntfyDriver.send(config, { kind: 'price_drop', ...ALERT }, { fetch })).toEqual({
			ok: true
		});
		await ntfyDriver.send(config, { kind: 'check_failed', ...ALERT }, { fetch });
		await ntfyDriver.send(config, { kind: 'test', title: 't', message: 'm' }, { fetch });

		expect(body(fetch, 0)).toEqual({ topic: 'secret-topic-123', ...ALERT, priority: 5 });
		expect(body(fetch, 1)).toEqual({ topic: 'secret-topic-123', ...ALERT, priority: 2 });
		expect(body(fetch, 2)).toEqual({ topic: 'secret-topic-123', title: 't', message: 'm' });
		expect(body(fetch, 2)).not.toHaveProperty('priority');
	});

	it('timeout passes through', async () => {
		const hung = vi.fn<SendDeps['fetch']>(() => new Promise<Response>(() => {}));
		expect(
			await ntfyDriver.send(
				{ url: TOPIC_URL, token: null },
				{ kind: 'test', ...NOTE },
				{ fetch: hung, timeoutMs: 5 }
			)
		).toEqual({ ok: false, reason: 'timeout' });
	});

	it('write-only token', () => {
		const NEW_TOKEN = 'tk_zyxwvutsrqponmlkjihgfedcba987';
		const previous = { url: 'https://ntfy.sh/old-topic', token: TOKEN };

		// Blank or missing: the saved token is kept, even when the topic changes.
		for (const token of ['', '   ', undefined]) {
			expect(ntfyDriver.parseConfig({ topic: TOPIC_URL, token }, previous), String(token)).toEqual({
				ok: true,
				config: { url: TOPIC_URL, token: TOKEN }
			});
		}
		expect(ntfyDriver.parseConfig({ topic: TOPIC_URL, token: '' }, null)).toEqual({
			ok: true,
			config: { url: TOPIC_URL, token: null }
		});

		// A new token replaces it.
		expect(ntfyDriver.parseConfig({ topic: TOPIC_URL, token: NEW_TOKEN }, previous)).toEqual({
			ok: true,
			config: { url: TOPIC_URL, token: NEW_TOKEN }
		});

		// An invalid one is refused outright, and not echoed back.
		const typed = 'tk_short-secret-value';
		const refused = ntfyDriver.parseConfig({ topic: TOPIC_URL, token: typed }, previous);
		expect(refused).toEqual({
			ok: false,
			message: 'Enter an ntfy access token like tk_… (from `ntfy token add`), or leave it empty'
		});
		expect(JSON.stringify(refused)).not.toContain(typed);

		// So is an invalid or missing topic, with the topic parser's message.
		for (const topic of ['http://ntfy.sh/x', undefined]) {
			expect(ntfyDriver.parseConfig({ topic, token: NEW_TOKEN }, previous)).toEqual({
				ok: false,
				message: (parseTopicUrl('') as { message: string }).message
			});
		}
	});

	it('view', () => {
		const shown = ntfyDriver.view({ url: TOPIC_URL, token: TOKEN });
		expect(shown).toEqual({ topic: TOPIC_URL, tokenSet: true });
		expect(JSON.stringify(shown)).not.toContain(TOKEN);
		expect(ntfyDriver.view({ url: TOPIC_URL, token: null })).toEqual({
			topic: TOPIC_URL,
			tokenSet: false
		});
	});
});

describe('describeFailure', () => {
	it('labels', () => {
		const labels: Record<FailureReason, string> = {
			bad_credentials: 'bad credentials',
			refused: 'refused',
			unreachable: 'unreachable',
			timeout: 'timeout'
		};
		for (const [reason, label] of Object.entries(labels)) {
			expect(describeFailure(reason as FailureReason)).toBe(label);
		}
	});
});
