import net from 'node:net';
import { simpleParser } from 'mailparser';
import { createTransport } from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	NON_SMTP_GREETING,
	SMTP_TEST_CA,
	SMTP_TEST_HOST,
	startNonSmtpListener,
	startSmtpServer,
	type FakeSmtpServer,
	type NonSmtpListener,
	type SmtpServerOptions
} from './smtp-server.ts';

// Every connection here goes to the in-process fake server on 127.0.0.1.

const USER = 'alice@example.com';
const PASS = 'app-password-0123';
const MAIL = {
	from: 'Price check <s@example.com>',
	to: 'r@example.com',
	subject: 'Price drop: Kettle £19.99',
	text: 'Price £19.99 is at or below your £20.00 target'
};

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
	await Promise.all(open.splice(0).map((s) => s.close()));
});

async function server(options: SmtpServerOptions = {}) {
	const s = await startSmtpServer(options);
	open.push(s);
	return s;
}

async function nonSmtp() {
	const s = await startNonSmtpListener();
	open.push(s);
	return s;
}

/** A send the way the SMTP channel makes one: verified TLS, implicit on the implicit server, required STARTTLS otherwise. */
function send(s: FakeSmtpServer, extra: SMTPTransportOptions = {}) {
	const implicit = s.transport === 'implicit';
	return createTransport({
		host: s.host,
		port: s.port,
		secure: implicit,
		requireTLS: !implicit,
		auth: { user: USER, pass: PASS },
		tls: { ca: SMTP_TEST_CA, rejectUnauthorized: true },
		connectionTimeout: 3000,
		greetingTimeout: 3000,
		socketTimeout: 3000,
		...extra
	}).sendMail(MAIL);
}

/** Resolves once the server has seen the connection from this client port close. */
async function closedOnServer(
	s: FakeSmtpServer | NonSmtpListener,
	port: number | undefined,
	label: string
) {
	await vi.waitFor(() => {
		const record = s.connections.find((c) => c.remotePort === port);
		expect(record, `${label}: ${JSON.stringify(s.connections)} vs ${port}`).toEqual({
			remotePort: port,
			closed: true
		});
	});
}

function connect(port: number) {
	return new Promise<net.Socket>((resolve, reject) => {
		const socket = net.connect(port, SMTP_TEST_HOST, () => resolve(socket));
		socket.once('error', reject);
	});
}

describe('fake smtp server', () => {
	it('delivers', async () => {
		const s = await server();
		expect([s.transport, s.cert]).toEqual(['starttls', 'trusted']);

		const info = await send(s);

		expect(info.accepted).toEqual(['r@example.com']);
		expect(s.auths).toEqual([{ username: USER, password: PASS }]);
		expect(s.messages).toHaveLength(1);
		const [message] = s.messages;
		expect(message.from).toBe('s@example.com');
		expect(message.to).toEqual(['r@example.com']);
		expect(message.auth).toEqual({ username: USER, password: PASS });
		expect(message.secure).toBe(true);
		const parsed = await simpleParser(message.raw);
		expect(parsed.subject).toBe(MAIL.subject);
		expect(parsed.text?.trim()).toBe(MAIL.text);
		expect(parsed.from?.value).toEqual([{ name: 'Price check', address: 's@example.com' }]);

		// The 465 path delivers the same way.
		const implicit = await server({ transport: 'implicit' });
		await send(implicit);
		expect(implicit.auths).toEqual([{ username: USER, password: PASS }]);
		expect(implicit.messages.map((m) => [m.from, m.to, m.secure])).toEqual([
			['s@example.com', ['r@example.com'], true]
		]);
	});

	it('tls refusals', async () => {
		// Each refusal is paired with a laxer client that gets through, so the
		// refusal is the TLS check's doing and nothing else's.
		const plain = await server({ transport: 'no_starttls' });
		await expect(send(plain)).rejects.toMatchObject({ code: 'ETLS' });
		expect(plain.auths).toEqual([]);
		expect(plain.messages).toEqual([]);
		await send(plain, { requireTLS: false });
		expect(plain.messages.map((m) => m.secure)).toEqual([false]);

		const starttls = await server({ cert: 'untrusted' });
		await expect(send(starttls)).rejects.toThrow();
		expect(starttls.auths).toEqual([]);
		expect(starttls.messages).toEqual([]);
		await send(starttls, { tls: { rejectUnauthorized: false } });
		expect(starttls.messages).toHaveLength(1);

		const implicit = await server({ transport: 'implicit', cert: 'untrusted' });
		await expect(send(implicit)).rejects.toThrow();
		expect(implicit.auths).toEqual([]);
		expect(implicit.messages).toEqual([]);
		await send(implicit, { tls: { rejectUnauthorized: false } });
		expect(implicit.messages).toHaveLength(1);
	});

	it('failure modes', async () => {
		const rejectText = 'Login refused for this mailbox';
		const authReject = await server({ mode: 'auth_reject', authRejectText: rejectText });
		const rejected = await send(authReject).catch((err: unknown) => err);
		expect(rejected).toMatchObject({ code: 'EAUTH', responseCode: 535 });
		expect((rejected as { response: string }).response).toBe(`535 ${rejectText}`);
		expect(authReject.auths).toEqual([{ username: USER, password: PASS }]);
		expect(authReject.messages).toEqual([]);

		const unavailable = await server({ mode: 'auth_unavailable' });
		await expect(send(unavailable)).rejects.toMatchObject({ code: 'EAUTH', responseCode: 454 });
		expect(unavailable.messages).toEqual([]);

		const rcpt = await server({ mode: 'rcpt_reject' });
		await expect(send(rcpt)).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 });
		expect(rcpt.messages).toEqual([]);

		const silent = await server({ mode: 'silent' });
		const started = Date.now();
		await expect(send(silent, { greetingTimeout: 200 })).rejects.toMatchObject({
			code: 'ETIMEDOUT'
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(silent.connections).toHaveLength(1);
		expect(silent.auths).toEqual([]);
	});

	it('mode switch', async () => {
		const s = await server();

		s.setMode('rcpt_reject');
		await expect(send(s)).rejects.toMatchObject({ responseCode: 550 });
		expect(s.messages).toEqual([]);

		s.setMode('ok');
		await send(s);
		expect(s.messages).toHaveLength(1);
		expect(s.connections).toHaveLength(2);

		s.setMode('auth_reject', { authRejectText: 'second text' });
		await expect(send(s)).rejects.toMatchObject({ response: '535 second text' });
		expect(s.messages).toHaveLength(1);
	});

	it('lifecycle', async () => {
		for (const transport of ['starttls', 'implicit', 'no_starttls'] as const) {
			const s = await server({ transport });
			expect(s.host).toBe('127.0.0.1');
			expect(s.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port: s.port });
			expect(s.listening).toBe(true);

			const client = await connect(s.port);
			await vi.waitFor(() => expect(s.connections).toHaveLength(1));
			const port = client.localPort;
			expect(s.connections[0]).toEqual({ remotePort: port, closed: false });
			client.destroy();
			await closedOnServer(s, port, transport);

			await s.close();
			expect(s.listening).toBe(false);
			await expect(connect(s.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
		}

		// A silent session still holding its greeting doesn't keep close() waiting.
		const silent = await server({ mode: 'silent' });
		const held = await connect(silent.port);
		const heldPort = held.localPort;
		held.on('error', () => {});
		// Read, so the server's FIN after its 421 is seen and the client side ends too.
		held.resume();
		await vi.waitFor(() => expect(silent.connections).toHaveLength(1));
		await silent.close();
		expect(silent.listening).toBe(false);
		await closedOnServer(silent, heldPort, 'silent');

		const other = await nonSmtp();
		expect(other.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
		const client = await connect(other.port);
		const greeting = await new Promise<string>((resolve) =>
			client.once('data', (chunk) => resolve(chunk.toString()))
		);
		expect(greeting).toBe(NON_SMTP_GREETING);
		expect(greeting.startsWith('220')).toBe(false);
		const otherPort = client.localPort;
		client.destroy();
		await closedOnServer(other, otherPort, 'non-smtp');
		await other.close();
		expect(other.listening).toBe(false);
		await expect(connect(other.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
	});
});
