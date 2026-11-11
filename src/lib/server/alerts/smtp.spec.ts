import net, { type AddressInfo } from 'node:net';
import { simpleParser } from 'mailparser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SMTP_TEST_CA,
	startNonSmtpListener,
	startSmtpServer,
	type SmtpServerOptions
} from '../testing/smtp-server.ts';
import { HINT_COPY, type Alert, type DriverDeps, type SendResult } from './channel.ts';
import { channelKinds } from './channels.ts';
import {
	HOST_MESSAGE,
	IMPLICIT_TLS_PORT,
	PASSWORD_MESSAGE,
	PORT_MESSAGE,
	RECIPIENT_MESSAGE,
	SENDER_MESSAGE,
	USERNAME_MESSAGE,
	classify,
	smtpDriver,
	type SmtpConfig
} from './smtp.ts';

// Every connection here goes to the in-process fake server on 127.0.0.1 (or to a
// closed local port, or a name under .invalid that never resolves): no live mail host.

const USER = 'alice@example.com';
// Shaped like a Gmail app password; not a real one.
const PASS = 'abcd efgh ijkl mnop';
const PASS_2 = 'second-password-0123';
const CONFIG: SmtpConfig = {
	host: '127.0.0.1',
	port: 587,
	username: USER,
	password: PASS,
	from: 's@example.com',
	to: 'r@example.com'
};
const DROP: Alert = {
	kind: 'price_drop',
	title: 'Price drop: Acme Kettle™ — now £19.99',
	message: 'Price £19.99 is at or below your £20.00 target',
	click: 'https://www.amazon.co.uk/dp/B0ABC12345'
};
const TEST_ALERT: Alert = { kind: 'test', title: 'Test alert', message: 'It works.' };

const noFetch: DriverDeps['fetch'] = () => Promise.reject(new Error('SMTP never fetches'));

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
	await Promise.all(open.splice(0).map((s) => s.close()));
});

async function server(options: SmtpServerOptions = {}) {
	const s = await startSmtpServer(options);
	open.push(s);
	return s;
}

/** A 127.0.0.1 port nothing listens on: bound once, then closed. */
async function closedPort() {
	const listener = net.createServer();
	await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
	const { port } = listener.address() as AddressInfo;
	await new Promise<void>((resolve) => listener.close(() => resolve()));
	return port;
}

/**
 * A raw 127.0.0.1 TCP listener (not SMTP-server), each connection handed to `onSocket`.
 * Records whether each client connection has closed; close() destroys whatever is left.
 */
async function rawListener(onSocket: (socket: net.Socket) => void) {
	const sockets: net.Socket[] = [];
	const closed: boolean[] = [];
	const listener = net.createServer((socket) => {
		const index = sockets.push(socket) - 1;
		closed[index] = false;
		socket.on('error', () => {});
		socket.on('close', () => {
			closed[index] = true;
		});
		onSocket(socket);
	});
	await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
	const handle = {
		port: (listener.address() as AddressInfo).port,
		closed,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				listener.close(() => resolve());
			})
	};
	open.push(handle);
	return handle;
}

/** Sends through the driver trusting the fake server's CA, the socket pointed at `port`. */
function send(
	port: number,
	config: Partial<SmtpConfig> = {},
	alert: Alert = DROP,
	extra: Partial<DriverDeps> = {}
) {
	return smtpDriver.send({ ...CONFIG, ...config }, alert, {
		fetch: noFetch,
		tlsCa: SMTP_TEST_CA,
		connectPort: port,
		timeoutMs: 5000,
		...extra
	});
}

describe('smtp send', () => {
	it('wire', async () => {
		const s = await server();

		expect(await send(s.port)).toEqual({ ok: true });
		expect(s.auths).toEqual([{ username: USER, password: PASS }]);
		expect(s.messages).toHaveLength(1);
		const [message] = s.messages;
		expect(message.auth).toEqual({ username: USER, password: PASS });
		expect(message.secure).toBe(true);
		expect(message.from).toBe('s@example.com');
		expect(message.to).toEqual(['r@example.com']);

		const parsed = await simpleParser(message.raw);
		expect(parsed.from?.value).toEqual([{ name: 'Price check', address: 's@example.com' }]);
		expect(parsed.to).toMatchObject({ value: [{ address: 'r@example.com', name: '' }] });
		expect(parsed.subject).toBe(DROP.title);
		// mailparser ends a decoded text part with one line break of its own.
		expect(parsed.text).toBe(`${DROP.message}\n\nhttps://www.amazon.co.uk/dp/B0ABC12345\n`);
		// One plain-text part and nothing else: no HTML, no multipart, no attachment.
		expect(parsed.html).toBe(false);
		expect(parsed.attachments).toEqual([]);
		expect(parsed.headers.get('content-type')).toMatchObject({ value: 'text/plain' });
		expect(message.raw.toString('latin1')).not.toMatch(/multipart|text\/html/i);

		// A test alert has no link: the text is the message alone.
		expect(await send(s.port, {}, TEST_ALERT)).toEqual({ ok: true });
		const test = await simpleParser(s.messages[1].raw);
		expect(test.subject).toBe('Test alert');
		expect(test.text).toBe('It works.\n');
		expect(test.html).toBe(false);
	});

	it('tls by port', async () => {
		// The saved port picks the mode; connectPort only moves the socket.
		const implicit = await server({ transport: 'implicit' });
		const starttls = await server();

		expect(await send(implicit.port, { port: IMPLICIT_TLS_PORT })).toEqual({
			ok: true
		});
		expect(implicit.messages.map((m) => m.secure)).toEqual([true]);
		// 465 against a server that greets in clear: TLS from the first byte fails.
		expect(await send(starttls.port, { port: IMPLICIT_TLS_PORT })).toMatchObject({
			ok: false
		});
		expect(starttls.auths).toEqual([]);
		expect(starttls.messages).toEqual([]);

		// 587 (and any port but 465) upgrades with STARTTLS before logging in.
		expect(await send(starttls.port, { port: 587 })).toEqual({ ok: true });
		expect(await send(starttls.port, { port: 2525 })).toEqual({ ok: true });
		expect(starttls.messages.map((m) => m.secure)).toEqual([true, true]);
		// 587 against the implicit server: no plaintext greeting to STARTTLS from.
		expect(await send(implicit.port, { port: 587 }, DROP, { timeoutMs: 300 })).toMatchObject({
			ok: false
		});
		expect(implicit.messages).toHaveLength(1);
	});

	it('classify', async () => {
		const refused: SendResult = { ok: false, reason: 'refused' };
		const unreachable: SendResult = { ok: false, reason: 'unreachable' };

		const authReject = await server({ mode: 'auth_reject' });
		expect(await send(authReject.port)).toEqual({
			ok: false,
			reason: 'bad_credentials',
			hint: 'app_password'
		});
		expect(authReject.auths).toEqual([{ username: USER, password: PASS }]);

		const unavailable = await server({ mode: 'auth_unavailable' });
		expect(await send(unavailable.port)).toEqual(refused);
		expect(unavailable.auths).toHaveLength(1);

		const rcpt = await server({ mode: 'rcpt_reject' });
		expect(await send(rcpt.port)).toEqual(refused);
		expect(rcpt.messages).toEqual([]);

		// TLS refusals, on both port paths, all before the login is sent.
		const tlsCases: [string, SmtpServerOptions, number][] = [
			['no STARTTLS', { transport: 'no_starttls' }, 587],
			['untrusted over STARTTLS', { cert: 'untrusted' }, 587],
			['untrusted over implicit TLS', { transport: 'implicit', cert: 'untrusted' }, 465]
		];
		for (const [label, options, port] of tlsCases) {
			const s = await server(options);
			expect(await send(s.port, { port }), label).toEqual(refused);
			expect(s.auths, label).toEqual([]);
			expect(s.messages, label).toEqual([]);
		}

		const other = await startNonSmtpListener();
		open.push(other);
		expect(await send(other.port), 'non-SMTP greeting').toEqual(refused);

		const closed = await closedPort();
		expect(await send(closed, { port: 587 }), 'closed 587').toEqual(unreachable);
		expect(await send(closed, { port: 465 }), 'closed 465').toEqual(unreachable);
		expect(
			await smtpDriver.send({ ...CONFIG, host: 'smtp.price-check.invalid' }, DROP, {
				fetch: noFetch,
				timeoutMs: 8000
			}),
			'.invalid host'
		).toEqual(unreachable);

		const silent = await server({ mode: 'silent' });
		const started = Date.now();
		expect(await send(silent.port, {}, DROP, { timeoutMs: 200 })).toEqual({
			ok: false,
			reason: 'timeout'
		});
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('classify fields', () => {
		// Only code, responseCode, command and syscall are read; message and response never.
		const text = { message: '535 bad password', response: '535 5.7.8 bad password' };
		const cases: [unknown, ReturnType<typeof classify>][] = [
			[{ ...text, code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }, bad()],
			[{ code: 'EAUTH', responseCode: 534, command: 'AUTH LOGIN' }, bad()],
			[{ code: 'EAUTH', responseCode: 454, command: 'AUTH PLAIN' }, { reason: 'refused' }],
			[{ code: 'EAUTH', responseCode: 535, command: 'API' }, { reason: 'refused' }],
			[{ code: 'EAUTH', command: 'API' }, { reason: 'refused' }],
			[{ code: 'EENVELOPE', responseCode: 535, command: 'RCPT TO' }, { reason: 'refused' }],
			[{ code: 'ETIMEDOUT' }, { reason: 'timeout' }],
			[{ code: 'EDNS', syscall: 'queryA' }, { reason: 'unreachable' }],
			[{ code: 'ESOCKET', syscall: 'connect', errno: -111 }, { reason: 'unreachable' }],
			[{ code: 'ESOCKET', syscall: 'getaddrinfo' }, { reason: 'unreachable' }],
			[{ code: 'ECONNECTION', syscall: 'connect' }, { reason: 'unreachable' }],
			[{ code: 'ESOCKET', syscall: 'read' }, { reason: 'refused' }],
			[{ code: 'ESOCKET', originalCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, { reason: 'refused' }],
			[{ code: 'ETLS', responseCode: 500, command: 'STARTTLS' }, { reason: 'refused' }],
			[{ code: 'EPROTOCOL', command: 'CONN' }, { reason: 'refused' }],
			[{ code: 'EMESSAGE', responseCode: 552, command: 'DATA' }, { reason: 'refused' }],
			[{ ...text, code: 'ECONNREFUSED connect' }, { reason: 'refused' }],
			[{ code: 535, responseCode: '535', syscall: 1 }, { reason: 'refused' }],
			[null, { reason: 'refused' }],
			['ETIMEDOUT', { reason: 'refused' }]
		];
		for (const [err, expected] of cases) {
			expect(classify(err), JSON.stringify(err)).toEqual(expected);
		}

		function bad(): ReturnType<typeof classify> {
			return { reason: 'bad_credentials', hint: 'app_password' };
		}
	});

	it('classify robustness', () => {
		// Whatever is thrown, classify answers and never throws itself.
		const cases: [unknown, ReturnType<typeof classify>][] = [
			[undefined, { reason: 'refused' }],
			[null, { reason: 'refused' }],
			['ESOCKET', { reason: 'refused' }],
			[42, { reason: 'refused' }],
			// A field of the wrong type counts as missing.
			[{ code: 'EAUTH', responseCode: 535, command: 42 }, { reason: 'refused' }],
			[{ code: 'EAUTH', responseCode: 535, command: ['AUTH PLAIN'] }, { reason: 'refused' }],
			// A connect syscall only means unreachable on a socket or connection error.
			[{ code: 'EPROTOCOL', syscall: 'connect' }, { reason: 'refused' }],
			[{ code: 'ETLS', syscall: 'getaddrinfo' }, { reason: 'refused' }],
			[{ syscall: 'connect' }, { reason: 'refused' }]
		];
		for (const [err, expected] of cases) {
			const label = err === undefined ? 'undefined' : JSON.stringify(err);
			expect(() => classify(err), label).not.toThrow();
			expect(classify(err), label).toEqual(expected);
		}
	});

	it('timeout closes', async () => {
		const silent = await server({ mode: 'silent' });
		expect(await send(silent.port, {}, DROP, { timeoutMs: 150 })).toEqual({
			ok: false,
			reason: 'timeout'
		});
		expect(silent.connections).toHaveLength(1);
		// Closed by the client at once, not left to the server's own close().
		await vi.waitFor(() => expect(silent.connections[0].closed).toBe(true), { timeout: 1000 });
		expect(silent.listening).toBe(true);

		// Late nothing: the server switching to ok afterwards gets no message.
		silent.setMode('ok');
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(silent.messages).toEqual([]);
		expect(silent.auths).toEqual([]);
	});

	it('overall deadline', async () => {
		// Greets, then answers EHLO with continuation lines that never end. The data keeps
		// nodemailer's idle socket timer from firing and the greeting already arrived, so
		// only the send's own deadline can end this, and its cleanup closes the socket.
		const trickle = await rawListener((socket) => {
			socket.write('220 trickle ESMTP\r\n');
			socket.once('data', () => {
				const tick = setInterval(() => {
					if (!socket.destroyed) socket.write('250-still thinking\r\n');
				}, 25);
				socket.on('close', () => clearInterval(tick));
			});
		});

		const started = Date.now();
		const guard = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000));
		const result = await Promise.race([send(trickle.port, {}, DROP, { timeoutMs: 300 }), guard]);
		expect(result).toEqual({ ok: false, reason: 'timeout' });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(trickle.closed).toHaveLength(1);
		await vi.waitFor(() => expect(trickle.closed[0]).toBe(true), { timeout: 1000 });
	});

	it('closed before greeting', async () => {
		// Accepts the connection and hangs up without a word: refused, and at once.
		const hangup = await rawListener((socket) => socket.end());
		const started = Date.now();
		expect(await send(hangup.port, {}, DROP, { timeoutMs: 3000 })).toEqual({
			ok: false,
			reason: 'refused'
		});
		expect(Date.now() - started).toBeLessThan(1000);
		expect(hangup.closed).toHaveLength(1);
	});

	it('no text in results', async () => {
		const replyText = `Login refused for ${PASS} as ${USER}`;
		const s = await server({ mode: 'auth_reject', authRejectText: replyText });
		const results = [await send(s.port)];
		s.setMode('rcpt_reject');
		results.push(await send(s.port));
		s.setMode('auth_unavailable');
		results.push(await send(s.port));
		results.push(await send(s.port, { port: 465 }));

		expect(results).toEqual([
			{ ok: false, reason: 'bad_credentials', hint: 'app_password' },
			{ ok: false, reason: 'refused' },
			{ ok: false, reason: 'refused' },
			{ ok: false, reason: 'refused' }
		]);
		for (const result of results) {
			for (const secret of [PASS, 'Login refused', USER, '535', 'Mailbox unavailable']) {
				expect(JSON.stringify(result)).not.toContain(secret);
			}
		}
	});

	it('saved config that no longer parses is refused unsent', async () => {
		const s = await server();
		for (const config of [
			{ host: '127.0.0.1\r\nRCPT TO:<e@evil.example>' },
			{ port: 0 },
			{ port: 65536 },
			{ username: `${USER}\r\nQUIT` },
			{ password: '' },
			{ from: 'Alice <a@x.com>' },
			{ to: 'a@x.com, b@y.com' }
		]) {
			expect(await send(s.port, config), JSON.stringify(config)).toEqual({
				ok: false,
				reason: 'refused'
			});
		}
		expect(s.connections).toEqual([]);
	});
});

describe('smtp config', () => {
	const form = (fields: Record<string, string | undefined>) => ({
		host: '127.0.0.1',
		port: '587',
		username: USER,
		password: PASS,
		from: 's@example.com',
		to: 'r@example.com',
		...fields
	});

	it('parse', () => {
		expect(smtpDriver.parseConfig(form({}), null)).toEqual({ ok: true, config: CONFIG });
		expect(
			smtpDriver.parseConfig(
				form({
					host: ' smtp.gmail.com ',
					port: ' 465 ',
					username: ` ${USER} `,
					password: ` ${PASS} `,
					from: ' s@example.com ',
					to: ' r@example.com '
				}),
				null
			)
		).toEqual({ ok: true, config: { ...CONFIG, host: 'smtp.gmail.com', port: 465 } });

		// Any host, LAN and private ones included (decision host_policy); any port 1-65535.
		const accepted: Record<string, string>[] = [
			{ host: 'localhost' },
			{ host: 'mail' },
			{ host: '192.168.1.10' },
			{ host: '10.0.0.1' },
			{ host: '::1' },
			{ host: 'fd00::25' },
			{ host: 'smtp.example.co.uk.' },
			{ host: 'mx-1.mail.example.com' },
			{ port: '1' },
			{ port: '25' },
			{ port: '2525' },
			{ port: '65535' }
		];
		for (const fields of accepted) {
			expect(smtpDriver.parseConfig(form(fields), null), JSON.stringify(fields)).toMatchObject({
				ok: true
			});
		}

		const longest = `${'a'.repeat(248)}@x.com`;
		expect(smtpDriver.parseConfig(form({ from: longest, to: longest }), null)).toMatchObject({
			ok: true,
			config: { from: longest, to: longest }
		});

		const typedPasswords = [`${PASS}\r\nQUIT`, 'pass\nword', 'pass\u0000word', 'x'.repeat(1025)];
		const cases: [Record<string, string | undefined>, string][] = [
			[{ host: undefined }, HOST_MESSAGE],
			[{ host: '' }, HOST_MESSAGE],
			[{ host: '   ' }, HOST_MESSAGE],
			[{ host: 'smtp://smtp.gmail.com' }, HOST_MESSAGE],
			[{ host: 'smtp.gmail.com:587' }, HOST_MESSAGE],
			[{ host: 'smtp.gmail.com/x' }, HOST_MESSAGE],
			[{ host: 'smtp gmail.com' }, HOST_MESSAGE],
			[{ host: 'smtp.gmail.com\r\nx' }, HOST_MESSAGE],
			[{ host: 'smtp.gmail.com\nx' }, HOST_MESSAGE],
			[{ host: 'user@smtp.gmail.com' }, HOST_MESSAGE],
			[{ host: '-smtp.example.com' }, HOST_MESSAGE],
			[{ host: 'smtp..example.com' }, HOST_MESSAGE],
			[{ host: '[::1]' }, HOST_MESSAGE],
			[{ host: `${'a'.repeat(63)}.`.repeat(4) + 'com' }, HOST_MESSAGE],
			[{ host: `${'a'.repeat(64)}.com` }, HOST_MESSAGE],
			[{ port: undefined }, PORT_MESSAGE],
			[{ port: '' }, PORT_MESSAGE],
			[{ port: '   ' }, PORT_MESSAGE],
			[{ port: '0' }, PORT_MESSAGE],
			[{ port: '65536' }, PORT_MESSAGE],
			[{ port: '99999' }, PORT_MESSAGE],
			[{ port: '100000' }, PORT_MESSAGE],
			[{ port: '587x' }, PORT_MESSAGE],
			[{ port: '-587' }, PORT_MESSAGE],
			[{ port: '+587' }, PORT_MESSAGE],
			[{ port: '587.0' }, PORT_MESSAGE],
			[{ port: '5e2' }, PORT_MESSAGE],
			[{ port: '0x24b' }, PORT_MESSAGE],
			[{ port: '5 87' }, PORT_MESSAGE],
			[{ username: undefined }, USERNAME_MESSAGE],
			[{ username: '' }, USERNAME_MESSAGE],
			[{ username: '  ' }, USERNAME_MESSAGE],
			[{ username: `${USER}\r\nQUIT` }, USERNAME_MESSAGE],
			[{ username: 'a\u0000b' }, USERNAME_MESSAGE],
			[{ username: 'u'.repeat(257) }, USERNAME_MESSAGE],
			[{ password: undefined }, PASSWORD_MESSAGE],
			[{ password: '' }, PASSWORD_MESSAGE],
			[{ password: '   ' }, PASSWORD_MESSAGE],
			...typedPasswords.map((password): [Record<string, string>, string] => [
				{ password },
				PASSWORD_MESSAGE
			]),
			[{ from: undefined }, SENDER_MESSAGE],
			[{ from: '' }, SENDER_MESSAGE],
			[{ from: 'not-an-address' }, SENDER_MESSAGE],
			[{ from: 'Alice <a@x.com>' }, SENDER_MESSAGE],
			[{ from: 'a@x.com, b@y.com' }, SENDER_MESSAGE],
			[{ from: 'a@x.com\r\nBcc: e@evil.example' }, SENDER_MESSAGE],
			[{ from: `a${longest}` }, SENDER_MESSAGE],
			[{ to: undefined }, RECIPIENT_MESSAGE],
			[{ to: '' }, RECIPIENT_MESSAGE],
			[{ to: 'r@localhost' }, RECIPIENT_MESSAGE],
			[{ to: 'Alice <a@x.com>' }, RECIPIENT_MESSAGE],
			[{ to: 'a@x.com, b@y.com' }, RECIPIENT_MESSAGE],
			[{ to: 'a@x.com;b@y.com' }, RECIPIENT_MESSAGE],
			[{ to: `a${longest}` }, RECIPIENT_MESSAGE]
		];
		for (const [fields, message] of cases) {
			const label = JSON.stringify(fields);
			const result = smtpDriver.parseConfig(form(fields), null);
			expect(result, label).toEqual({ ok: false, message });
			// No refusal repeats a typed password, whichever field it names.
			const typed = form(fields).password;
			if (typed !== undefined && typed.trim() !== '') {
				expect(JSON.stringify(result), label).not.toContain(typed.trim());
			}
		}

		// Each refusal names its field.
		expect(HOST_MESSAGE).toContain('host');
		expect(PORT_MESSAGE).toContain('port');
		expect(USERNAME_MESSAGE).toContain('username');
		expect(PASSWORD_MESSAGE).toContain('password');
		expect(SENDER_MESSAGE).toContain('sender');
		expect(RECIPIENT_MESSAGE).toContain('recipient');
		for (const message of [HOST_MESSAGE, PORT_MESSAGE, USERNAME_MESSAGE, SENDER_MESSAGE]) {
			expect(message).not.toContain('password');
		}
	});

	it('parse bounds', () => {
		// Exactly at each limit is accepted; one character over is refused.
		const label = (n: number) => 'a'.repeat(n);
		const host253 = [label(63), label(63), label(63), label(61)].join('.');
		const host254 = [label(63), label(63), label(63), label(62)].join('.');
		expect(host253).toHaveLength(253);
		expect(host254).toHaveLength(254);
		const username256 = 'u'.repeat(256);
		const password1024 = 'p'.repeat(1024);

		expect(smtpDriver.parseConfig(form({ host: host253 }), null)).toMatchObject({
			ok: true,
			config: { host: host253 }
		});
		expect(smtpDriver.parseConfig(form({ username: username256 }), null)).toMatchObject({
			ok: true,
			config: { username: username256 }
		});
		expect(smtpDriver.parseConfig(form({ password: password1024 }), null)).toMatchObject({
			ok: true,
			config: { password: password1024 }
		});
		expect(smtpDriver.parseConfig(form({ host: host254 }), null)).toEqual({
			ok: false,
			message: HOST_MESSAGE
		});
		expect(smtpDriver.parseConfig(form({ username: `${username256}u` }), null)).toEqual({
			ok: false,
			message: USERNAME_MESSAGE
		});
		expect(smtpDriver.parseConfig(form({ password: `${password1024}p` }), null)).toEqual({
			ok: false,
			message: PASSWORD_MESSAGE
		});

		// Single-letter DNS labels, first and later.
		for (const host of ['a', 'x.example.com', 'mail.x.io', 'a.b.c']) {
			expect(smtpDriver.parseConfig(form({ host }), null), host).toMatchObject({
				ok: true,
				config: { host }
			});
		}
	});

	it('write-only password', () => {
		// Blank keeps the saved password; a new one replaces it.
		expect(smtpDriver.parseConfig(form({ password: '' }), CONFIG)).toEqual({
			ok: true,
			config: CONFIG
		});
		expect(
			smtpDriver.parseConfig(form({ password: undefined, to: 'other@example.com' }), CONFIG)
		).toEqual({ ok: true, config: { ...CONFIG, to: 'other@example.com' } });
		expect(smtpDriver.parseConfig(form({ password: '  ' }), CONFIG)).toEqual({
			ok: true,
			config: CONFIG
		});
		expect(smtpDriver.parseConfig(form({ password: PASS_2 }), CONFIG)).toEqual({
			ok: true,
			config: { ...CONFIG, password: PASS_2 }
		});
		// Blank with nothing saved: refused as missing.
		expect(smtpDriver.parseConfig(form({ password: '' }), null)).toEqual({
			ok: false,
			message: PASSWORD_MESSAGE
		});
		// A refusal of another field with a password saved never echoes it either.
		expect(JSON.stringify(smtpDriver.parseConfig(form({ host: 'x y' }), CONFIG))).not.toContain(
			PASS
		);

		const view = smtpDriver.view(CONFIG);
		expect(view).toEqual({
			host: '127.0.0.1',
			port: '587',
			username: USER,
			from: 's@example.com',
			to: 'r@example.com',
			passwordSet: true
		});
		expect(JSON.stringify(view)).not.toContain(PASS);
		expect(smtpDriver.view({ ...CONFIG, password: '' })).toMatchObject({ passwordSet: false });
	});

	it('driver', () => {
		expect(smtpDriver.kind).toBe('smtp');
		expect(smtpDriver.defaultKinds).toEqual(['price_drop']);
		expect(HINT_COPY.app_password).toBe(
			'Gmail and most providers need an app password, not your account password.'
		);
		expect(IMPLICIT_TLS_PORT).toBe(465);
		expect(channelKinds()).toEqual(['ntfy', 'resend', 'smtp']);
	});
});
