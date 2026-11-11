// The SMTP channel driver: email each alert through the user's own mail server
// (e.g. Gmail with an app password), logged in with their username and password.
//
// TLS is never optional (decision tls_policy): port 465 speaks TLS from the first byte,
// any other port must upgrade with STARTTLS, and the server's certificate is always
// verified, so the password never travels in clear or to an unverified peer. The
// password is write-only — nothing returned from here, error and server text
// included, ever contains it.

import net from 'node:net';
import type { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import type {
	ChannelDriver,
	FailureHint,
	FailureReason,
	ParsedConfig,
	SendResult
} from './channel.ts';
import { SEND_TIMEOUT_MS } from './ntfy.ts';
import { SENDER_NAME } from './resend.ts';

/** A saved SMTP channel: the server, the login, one plain sender and one plain recipient. */
export type SmtpConfig = {
	host: string;
	port: number;
	username: string;
	password: string;
	from: string;
	to: string;
};

/** The one port that speaks TLS from the first byte; every other port must STARTTLS. */
export const IMPLICIT_TLS_PORT = 465;

/**
 * A DNS name: dot-separated labels of letters, digits and inner hyphens. No scheme,
 * port, path, whitespace or CR/LF can get through. IP addresses are checked apart.
 * Any name is allowed, LAN ones included (decision host_policy).
 */
const HOSTNAME =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const MAX_HOST = 253;

/** Same rules as the Resend sender and recipient: one plain address, nothing to inject. */
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const MAX_ADDRESS = 254;

/** Control characters (Unicode Cc: NUL, CR, LF, DEL and the rest): none may reach an AUTH line. */
const CONTROL = /\p{Cc}/u;
const MAX_USERNAME = 256;
const MAX_PASSWORD = 1024;

// Refusals name the field; none repeats what was typed into the password field.
export const HOST_MESSAGE =
	'Enter the SMTP server host as a host name or IP address, like smtp.gmail.com.';
export const PORT_MESSAGE = 'Enter the SMTP port as a whole number from 1 to 65535, like 587.';
export const USERNAME_MESSAGE = 'Enter the username you log in to the SMTP server with.';
export const PASSWORD_MESSAGE = 'Enter the password you log in to the SMTP server with.';
export const SENDER_MESSAGE =
	'Enter the sender as a plain email address your SMTP server may send from, like alerts@your-domain.com.';
export const RECIPIENT_MESSAGE =
	'Enter the recipient as a plain email address, like you@example.com.';

function isHost(value: string): boolean {
	return value.length <= MAX_HOST && (net.isIP(value) !== 0 || HOSTNAME.test(value));
}

function isPort(value: number): boolean {
	return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isUsername(value: string): boolean {
	return value !== '' && value.length <= MAX_USERNAME && !CONTROL.test(value);
}

function isPassword(value: string): boolean {
	return value !== '' && value.length <= MAX_PASSWORD && !CONTROL.test(value);
}

function isAddress(value: string): boolean {
	return value.length <= MAX_ADDRESS && ADDRESS.test(value);
}

/** Digits only (so no sign, exponent, fraction or trailing text), then the 1-65535 range. */
function parsePort(value: string): number | null {
	if (!/^[0-9]{1,5}$/.test(value)) return null;
	const port = Number(value);
	return isPort(port) ? port : null;
}

function parse(
	form: Readonly<Record<string, string | undefined>>,
	previous: SmtpConfig | null
): ParsedConfig<SmtpConfig> {
	const host = (form.host ?? '').trim();
	if (!isHost(host)) return { ok: false, message: HOST_MESSAGE };
	const port = parsePort((form.port ?? '').trim());
	if (port === null) return { ok: false, message: PORT_MESSAGE };
	const username = (form.username ?? '').trim();
	if (!isUsername(username)) return { ok: false, message: USERNAME_MESSAGE };
	// Write-only: blank keeps the saved password; blank with none saved is missing.
	const typed = (form.password ?? '').trim();
	const password = typed === '' ? (previous?.password ?? '') : typed;
	if (!isPassword(password)) return { ok: false, message: PASSWORD_MESSAGE };
	const from = (form.from ?? '').trim();
	if (!isAddress(from)) return { ok: false, message: SENDER_MESSAGE };
	const to = (form.to ?? '').trim();
	if (!isAddress(to)) return { ok: false, message: RECIPIENT_MESSAGE };
	return { ok: true, config: { host, port, username, password, from, to } };
}

function isValid(config: SmtpConfig): boolean {
	return (
		isHost(config.host) &&
		isPort(config.port) &&
		isUsername(config.username) &&
		isPassword(config.password) &&
		isAddress(config.from) &&
		isAddress(config.to)
	);
}

// ---- classification ------------------------------------------------------------

/** Rejections of the login itself: 535 bad credentials, 534 "use an app password / web login". */
const AUTH_REJECTED = new Set([534, 535]);

/** System calls whose failure means the server could not be reached at all. */
const CONNECT_SYSCALLS = new Set(['connect', 'getaddrinfo']);

function stringField(err: object, key: string): string | undefined {
	const value: unknown = (err as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : undefined;
}

function numberField(err: object, key: string): number | undefined {
	const value: unknown = (err as Record<string, unknown>)[key];
	return typeof value === 'number' ? value : undefined;
}

/**
 * Decision smtp_error_mapping, from nodemailer's error fields alone: code, responseCode,
 * command and the system call. err.message and err.response carry the server's own
 * text — which can echo the login — and are never read.
 *
 * nodemailer gives every socket error, a refused connection and a failed certificate
 * check alike, the code ESOCKET. Only a system error carries a syscall: a refused or
 * unroutable connect has 'connect', a failed name lookup 'getaddrinfo'; a TLS failure
 * (unverified certificate, a peer that does not speak TLS) has none, so it stays refused.
 */
export function classify(err: unknown): { reason: FailureReason; hint?: FailureHint } {
	if (typeof err !== 'object' || err === null) return { reason: 'refused' };
	const code = stringField(err, 'code');
	// Every nodemailer timer (connect, greeting, TLS upgrade, socket idle) reports ETIMEDOUT.
	if (code === 'ETIMEDOUT') return { reason: 'timeout' };
	if (code === 'EDNS') return { reason: 'unreachable' };
	if (code === 'EAUTH') {
		const responseCode = numberField(err, 'responseCode') ?? 0;
		const command = stringField(err, 'command') ?? '';
		if (AUTH_REJECTED.has(responseCode) && command.startsWith('AUTH')) {
			return { reason: 'bad_credentials', hint: 'app_password' };
		}
		// 454, no usable mechanism and the like: the server would not take a login now.
		return { reason: 'refused' };
	}
	if (code === 'ESOCKET' || code === 'ECONNECTION') {
		const syscall = stringField(err, 'syscall');
		if (syscall !== undefined && CONNECT_SYSCALLS.has(syscall)) return { reason: 'unreachable' };
	}
	// ETLS (no STARTTLS), a failed certificate check, EENVELOPE / EMESSAGE (sender,
	// recipient or data rejected), EPROTOCOL (not an SMTP greeting) and anything else.
	return { reason: 'refused' };
}

// ---- sending -------------------------------------------------------------------

function body(alert: { message: string; click?: string }): string {
	return alert.click === undefined ? alert.message : `${alert.message}\n\n${alert.click}`;
}

/** Settles once, with the first outcome: an error from any stage, or the message accepted. */
function deliver(
	connection: SMTPConnection,
	config: SmtpConfig,
	message: Readable,
	resolve: (result: SendResult) => void
) {
	const fail = (err: unknown) => resolve({ ok: false, ...classify(err) });
	// Kept on for good: an 'error' with no listener would crash the process, and a late
	// one after the send has settled is simply dropped.
	connection.on('error', fail);
	connection.connect((err) => {
		if (err) return fail(err);
		// Always log in (decision auth_required), advertised AUTH or not: a server that
		// cannot take the login refuses it rather than getting the message unauthenticated.
		connection.login({ user: config.username, pass: config.password }, (err) => {
			if (err) return fail(err);
			connection.send({ from: config.from, to: [config.to] }, message, (err) => {
				if (err) return fail(err);
				resolve({ ok: true });
			});
		});
	});
}

export const smtpDriver: ChannelDriver<SmtpConfig> = {
	kind: 'smtp',
	defaultKinds: ['price_drop'],

	parseConfig: parse,

	view: (config) => ({
		host: config.host,
		port: String(config.port),
		username: config.username,
		from: config.from,
		to: config.to,
		passwordSet: config.password !== ''
	}),

	/**
	 * Never throws. One connection per send, no pool and no logger. The TLS mode
	 * follows the saved port; deps.connectPort (tests only) changes where the socket
	 * goes, never the mode. When the overall timeout wins, the socket is destroyed
	 * there and then, so a send that was only slow can't still deliver after 'timeout'
	 * was returned and the next check sends again.
	 */
	async send(config, alert, { timeoutMs = SEND_TIMEOUT_MS, tlsCa, connectPort }) {
		if (!isValid(config)) return { ok: false, reason: 'refused' };

		const implicit = config.port === IMPLICIT_TLS_PORT;
		// Handed to nodemailer unconnected, so this module holds the raw socket to destroy.
		const socket = new net.Socket();
		let connection: SMTPConnection | undefined;
		let message: Readable | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let result: SendResult = { ok: false, reason: 'refused' };
		try {
			const live = new SMTPConnection({
				host: config.host,
				port: connectPort ?? config.port,
				secure: implicit,
				requireTLS: !implicit,
				tls: { rejectUnauthorized: true, ...(tlsCa === undefined ? {} : { ca: tlsCa }) },
				socket,
				connectionTimeout: timeoutMs,
				greetingTimeout: timeoutMs,
				socketTimeout: timeoutMs,
				dnsTimeout: timeoutMs,
				logger: false
			});
			connection = live;
			const mail = new MailComposer({
				from: `${SENDER_NAME} <${config.from}>`,
				to: config.to,
				subject: alert.title,
				text: body(alert),
				disableFileAccess: true,
				disableUrlAccess: true
			})
				.compile()
				.createReadStream();
			message = mail;
			const sent = new Promise<SendResult>((resolve) => deliver(live, config, mail, resolve));
			const timedOut = new Promise<SendResult>((resolve) => {
				timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
			});
			result = await Promise.race([sent, timedOut]);
		} catch {
			// The thrown error's text can carry the server's reply: none of it is kept.
			result = { ok: false, reason: 'refused' };
		} finally {
			clearTimeout(timer);
			connection?.close();
			// A failed or timed-out send leaves nothing half-open behind it.
			if (!result.ok) {
				socket.destroy();
				message?.destroy();
			}
		}
		return result;
	}
};
