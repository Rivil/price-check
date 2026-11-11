// The ntfy channel driver: POST a notification to a user's ntfy topic. ntfy's
// JSON publishing is used rather than headers, because product titles carry ™, —
// and £, which a fetch header cannot hold.
//
// The topic URL is a secret (decision topic_url_secrecy): nothing returned from
// here, error text included, ever contains it.

import type { ChannelDriver, DriverDeps, RoutedAlertKind, SendResult } from './channel.ts';

export const SEND_TIMEOUT_MS = 10_000;

/** ntfy's own topic name rule. */
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

export type ParsedTopic =
	{ ok: true; url: string; server: string; topic: string } | { ok: false; message: string };

const INVALID =
	'Enter your ntfy topic link, like https://ntfy.sh/your-topic (https, topic letters, digits, - or _)';

/** 'https://ntfy.sh/my-topic' -> server 'https://ntfy.sh/', topic 'my-topic'; self-hosted base paths are kept. */
export function parseTopicUrl(input: string): ParsedTopic {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return { ok: false, message: INVALID };
	}
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
		return { ok: false, message: INVALID };
	}
	if (url.search !== '' || url.hash !== '') return { ok: false, message: INVALID };
	const segments = url.pathname.split('/').filter((s) => s !== '');
	const topic = segments.at(-1);
	if (topic === undefined || !TOPIC.test(topic)) return { ok: false, message: INVALID };
	const base = segments.slice(0, -1).join('/');
	const server = `${url.origin}/${base === '' ? '' : `${base}/`}`;
	return { ok: true, url: `${server}${topic}`, server, topic };
}

/** `ntfy token add` prints tk_ plus 29 letters and digits; a little slack either way. */
const TOKEN = /^tk_[A-Za-z0-9]{20,64}$/;

export type ParsedToken = { ok: true; token: string | null } | { ok: false; message: string };

/**
 * Optional access token for a server that refuses anonymous publishes. Blank means
 * none. The pattern also keeps anything that is not a plain token out of a header.
 */
export function parseToken(input: string): ParsedToken {
	const token = input.trim();
	if (token === '') return { ok: true, token: null };
	if (!TOKEN.test(token)) {
		return {
			ok: false,
			message: 'Enter an ntfy access token like tk_… (from `ntfy token add`), or leave it empty'
		};
	}
	return { ok: true, token };
}

/** ntfy's own scale: 5 is urgent (a long vibration burst), 2 is low (no sound or vibration). */
export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

/** Price drops are urgent, failed checks low (c-9); a test alert keeps ntfy's default. */
export const NTFY_PRIORITY: Readonly<Record<RoutedAlertKind, NtfyPriority>> = {
	price_drop: 5,
	check_failed: 2
};

/** priority is sent only when set; without it ntfy uses its default (3). */
export type Notification = {
	title: string;
	message: string;
	click?: string;
	priority?: NtfyPriority;
};

export type { SendResult };

export type SendDeps = DriverDeps & {
	/** Sent as `Authorization: Bearer`; a credential, so never part of a result. */
	token?: string | null;
};

/**
 * Never throws, and the result carries a reason and an HTTP status only: the topic
 * and token cannot leak through it. A redirect is never followed (the token must not
 * reach another host) and counts as refused.
 */
export async function sendNtfy(
	topicUrl: string,
	note: Notification,
	{ fetch, timeoutMs = SEND_TIMEOUT_MS, token = null }: SendDeps
): Promise<SendResult> {
	const parsed = parseTopicUrl(topicUrl);
	if (!parsed.ok) return { ok: false, reason: 'refused' };

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Settles on its own, so a fetch that ignores the abort still cannot hang the send.
	const timedOut = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(null);
		}, timeoutMs);
	});
	try {
		const response = await Promise.race([
			fetch(parsed.server, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(token === null ? {} : { authorization: `Bearer ${token}` })
				},
				body: JSON.stringify({
					topic: parsed.topic,
					title: note.title,
					message: note.message,
					...(note.click === undefined ? {} : { click: note.click }),
					...(note.priority === undefined ? {} : { priority: note.priority })
				}),
				redirect: 'manual',
				signal: controller.signal
			}),
			timedOut
		]);
		if (response === null) return { ok: false, reason: 'timeout' };
		if (response.ok) return { ok: true };
		if (response.status === 401 || response.status === 403) {
			return { ok: false, reason: 'bad_credentials', status: response.status };
		}
		return { ok: false, reason: 'refused', status: response.status };
	} catch {
		// The thrown error's text can name the host or the topic: none of it is kept.
		return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'unreachable' };
	} finally {
		clearTimeout(timer);
	}
}

/** A saved ntfy channel: the topic link and, for a private server, an access token. */
export type NtfyConfig = { url: string; token: string | null };

export const ntfyDriver: ChannelDriver<NtfyConfig> = {
	kind: 'ntfy',
	defaultKinds: ['price_drop', 'check_failed'],

	parseConfig(form, previous) {
		const topic = parseTopicUrl(form.topic ?? '');
		if (!topic.ok) return topic;
		const token = parseToken(form.token ?? '');
		if (!token.ok) return token;
		return { ok: true, config: { url: topic.url, token: token.token ?? previous?.token ?? null } };
	},

	// The topic link is shown to its owner (decision topic_url_secrecy); the token never is.
	view: (config) => ({ topic: config.url, tokenSet: config.token !== null }),

	send(config, alert, deps) {
		return sendNtfy(
			config.url,
			{
				title: alert.title,
				message: alert.message,
				...(alert.click === undefined ? {} : { click: alert.click }),
				...(alert.kind === 'test' ? {} : { priority: NTFY_PRIORITY[alert.kind] })
			},
			{ ...deps, token: config.token }
		);
	}
};
