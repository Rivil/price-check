// The Resend channel driver: email each alert through the user's own Resend account.
//
// Requests go only to api.resend.com (decision resend_endpoint): the API key must
// never be sent to a host the user chose. The key is write-only — nothing returned
// from here, error text and the service's response text included, ever contains it.

import type {
	ChannelDriver,
	FailureHint,
	FailureReason,
	ParsedConfig,
	SendResult
} from './channel.ts';
import { SEND_TIMEOUT_MS } from './ntfy.ts';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** The display name every alert email is sent under (decision sender_format). */
export const SENDER_NAME = 'Price check';

/** A saved Resend channel: the API key, one plain sender and one plain recipient address. */
export type ResendConfig = { apiKey: string; from: string; to: string };

/**
 * Loose on purpose: re_ and then letters, digits, _ or -. It does not pin Resend's
 * current key length, but keeps spaces, CR/LF and anything else out of a header.
 */
const API_KEY = /^re_[A-Za-z0-9_-]{8,200}$/;

/**
 * One plain address: no display name, no list, no whitespace (so no CR/LF), no
 * quoting or brackets — the sender line is built here, never from user text.
 */
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const MAX_ADDRESS = 254;

// Refusals name the field; none repeats what was typed into the key field.
export const API_KEY_MESSAGE = 'Enter your Resend API key (it starts with re_).';
export const SENDER_MESSAGE =
	'Enter the sender as a plain email address on a domain verified in Resend, like alerts@your-domain.com.';
export const RECIPIENT_MESSAGE =
	'Enter the recipient as a plain email address, like you@example.com.';

function isAddress(value: string): boolean {
	return value.length <= MAX_ADDRESS && ADDRESS.test(value);
}

function parse(
	form: Readonly<Record<string, string | undefined>>,
	previous: ResendConfig | null
): ParsedConfig<ResendConfig> {
	const typedKey = (form.api_key ?? '').trim();
	const apiKey = typedKey === '' ? (previous?.apiKey ?? null) : typedKey;
	if (apiKey === null || !API_KEY.test(apiKey)) return { ok: false, message: API_KEY_MESSAGE };
	const from = (form.from ?? '').trim();
	if (!isAddress(from)) return { ok: false, message: SENDER_MESSAGE };
	const to = (form.to ?? '').trim();
	if (!isAddress(to)) return { ok: false, message: RECIPIENT_MESSAGE };
	return { ok: true, config: { apiKey, from, to } };
}

/** Resend error names that mean the key itself is the problem, whatever the status. */
const KEY_ERRORS = new Set(['missing_api_key', 'restricted_api_key', 'suspended_api_key']);

/** Only Resend's fixed error name is read from a response body; no other text is kept. */
async function errorName(response: Response): Promise<string | null> {
	try {
		const body: unknown = await response.json();
		if (typeof body === 'object' && body !== null && 'name' in body) {
			return typeof body.name === 'string' ? body.name : null;
		}
	} catch {
		// Not JSON: classified by status alone.
	}
	return null;
}

/**
 * Decision resend_error_mapping: status and name together. Any 401 or a key error
 * name is bad credentials; a 403 validation_error (unverified domain, testing-mode
 * recipient) is refused with the domain hint; everything else is refused.
 */
export function classify(
	status: number,
	name: string | null
): { reason: FailureReason; hint?: FailureHint } {
	if (status === 401 || (name !== null && KEY_ERRORS.has(name))) {
		return { reason: 'bad_credentials' };
	}
	if (status === 403 && name === 'validation_error') {
		return { reason: 'refused', hint: 'domain_unverified' };
	}
	return { reason: 'refused' };
}

export const resendDriver: ChannelDriver<ResendConfig> = {
	kind: 'resend',
	defaultKinds: ['price_drop'],

	parseConfig: parse,

	view: (config) => ({ from: config.from, to: config.to, keySet: config.apiKey !== '' }),

	/**
	 * Never throws. A redirect is never followed (the key must not reach another host)
	 * and counts as refused. The timeout covers reading the error body as well.
	 */
	async send(config, alert, { fetch, timeoutMs = SEND_TIMEOUT_MS }) {
		if (!API_KEY.test(config.apiKey) || !isAddress(config.from) || !isAddress(config.to)) {
			return { ok: false, reason: 'refused' };
		}

		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Settles on its own, so a fetch that ignores the abort still cannot hang the send.
		const timedOut = new Promise<null>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(null);
			}, timeoutMs);
		});

		const attempt = async (): Promise<SendResult> => {
			const response = await fetch(RESEND_ENDPOINT, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${config.apiKey}`
				},
				body: JSON.stringify({
					from: `${SENDER_NAME} <${config.from}>`,
					to: [config.to],
					subject: alert.title,
					text: alert.click === undefined ? alert.message : `${alert.message}\n\n${alert.click}`
				}),
				redirect: 'manual',
				signal: controller.signal
			});
			if (response.ok) return { ok: true };
			const { reason, hint } = classify(response.status, await errorName(response));
			return {
				ok: false,
				reason,
				status: response.status,
				...(hint === undefined ? {} : { hint })
			};
		};

		try {
			const result = await Promise.race([attempt(), timedOut]);
			return result ?? { ok: false, reason: 'timeout' };
		} catch {
			// The thrown error's text can carry the key or the response: none of it is kept.
			// Never a timeout: the timer aborts and resolves timedOut in the same tick, so a
			// rejection the abort causes always loses the race to it.
			return { ok: false, reason: 'unreachable' };
		} finally {
			clearTimeout(timer);
		}
	}
};
