// Test-only: an in-process SMTP server on 127.0.0.1 for exercising the SMTP alert
// channel without a live mail host. Its TLS certificates are test fixtures signed by
// a CA that only these tests trust (see fixtures/README.md).
import { readFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerSession } from 'smtp-server';

export const SMTP_TEST_HOST = '127.0.0.1';

/** How the server speaks TLS: STARTTLS on a plain socket (587), TLS from the first byte (465), or no TLS offered. */
export type SmtpTransport = 'starttls' | 'implicit' | 'no_starttls';
/** trusted: signed by SMTP_TEST_CA. untrusted: self-signed, chained to nothing a client trusts. */
export type SmtpCert = 'trusted' | 'untrusted';
/** What the server does with a client, switchable at runtime with setMode(). */
export type SmtpMode = 'ok' | 'auth_reject' | 'auth_unavailable' | 'rcpt_reject' | 'silent';

export const DEFAULT_AUTH_REJECT_TEXT = 'Authentication credentials invalid';

function fixture(name: string) {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** The test CA: pass it as the client's trusted CA so a 'trusted' server verifies. */
export const SMTP_TEST_CA = fixture('smtp-test-ca.pem');

const CERTS: Record<SmtpCert, { key: string; cert: string }> = {
	trusted: { key: fixture('smtp-test-localhost.key'), cert: fixture('smtp-test-localhost.pem') },
	untrusted: { key: fixture('smtp-test-untrusted.key'), cert: fixture('smtp-test-untrusted.pem') }
};

// Pending sessions get a 421 this long after close(); they are all test clients.
const CLOSE_TIMEOUT_MS = 100;

export interface RecordedAuth {
	username: string;
	password: string;
}

export interface RecordedMessage {
	from: string;
	to: string[];
	/** The login the session authenticated with. */
	auth: RecordedAuth | undefined;
	/** Whether the session was on TLS (implicit or upgraded by STARTTLS) when the message came in. */
	secure: boolean;
	/** The message exactly as the client sent it after DATA. */
	raw: Buffer;
}

export interface RecordedConnection {
	/** The client's port, i.e. the local port of the client's socket. */
	remotePort: number;
	closed: boolean;
}

export interface SmtpServerOptions {
	transport?: SmtpTransport;
	cert?: SmtpCert;
	mode?: SmtpMode;
	/** Reply text of the 535 sent in auth_reject mode. */
	authRejectText?: string;
}

export interface FakeSmtpServer {
	readonly host: typeof SMTP_TEST_HOST;
	readonly port: number;
	readonly transport: SmtpTransport;
	readonly cert: SmtpCert;
	/** SMTP_TEST_CA, for DriverDeps.tlsCa. */
	readonly ca: string;
	/** Every AUTH attempt that reached the server, accepted or not. */
	readonly auths: RecordedAuth[];
	readonly messages: RecordedMessage[];
	/** Every TCP connection accepted, in order. */
	readonly connections: RecordedConnection[];
	/** Errors the server raised, e.g. a client aborting the TLS handshake. */
	readonly errors: Error[];
	readonly listening: boolean;
	address(): AddressInfo;
	/** Changes behaviour for the next command (silent: the next connection) on the same port. */
	setMode(mode: SmtpMode, options?: { authRejectText?: string }): void;
	close(): Promise<void>;
}

function smtpError(responseCode: number, message: string) {
	return Object.assign(new Error(message), { responseCode });
}

function listen(server: net.Server) {
	return new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, SMTP_TEST_HOST, () => {
			server.off('error', reject);
			resolve();
		});
	});
}

function trackConnections(server: net.Server) {
	const connections: RecordedConnection[] = [];
	server.on('connection', (socket: net.Socket) => {
		const record: RecordedConnection = { remotePort: socket.remotePort ?? 0, closed: false };
		connections.push(record);
		socket.once('close', () => {
			record.closed = true;
		});
	});
	return connections;
}

/** Starts a fake SMTP server on 127.0.0.1 at an ephemeral port. Always close() it. */
export async function startSmtpServer(options: SmtpServerOptions = {}): Promise<FakeSmtpServer> {
	const transport = options.transport ?? 'starttls';
	const cert = options.cert ?? 'trusted';
	let mode = options.mode ?? 'ok';
	let authRejectText = options.authRejectText ?? DEFAULT_AUTH_REJECT_TEXT;
	const auths: RecordedAuth[] = [];
	const messages: RecordedMessage[] = [];
	const errors: Error[] = [];

	const server = new SMTPServer({
		...CERTS[cert],
		secure: transport === 'implicit',
		// With STARTTLS disabled smtp-server accepts AUTH in clear, so a refusal of this
		// server can only come from the client insisting on TLS.
		disabledCommands: transport === 'no_starttls' ? ['STARTTLS'] : [],
		name: 'localhost',
		authMethods: ['PLAIN', 'LOGIN'],
		disableReverseLookup: true,
		logger: false,
		closeTimeout: CLOSE_TIMEOUT_MS,
		onConnect(_session, callback) {
			// silent: hold the session before the 220 greeting, forever.
			if (mode !== 'silent') callback();
		},
		onAuth(auth, _session, callback) {
			const login = { username: auth.username ?? '', password: auth.password ?? '' };
			auths.push(login);
			if (mode === 'auth_reject') return callback(smtpError(535, authRejectText));
			if (mode === 'auth_unavailable') {
				return callback(smtpError(454, 'Temporary authentication failure'));
			}
			callback(null, { user: login });
		},
		onRcptTo(_address, _session, callback) {
			if (mode === 'rcpt_reject') return callback(smtpError(550, 'Mailbox unavailable'));
			callback();
		},
		onData(stream, session: SMTPServerSession, callback) {
			const chunks: Buffer[] = [];
			stream.on('data', (chunk: Buffer) => chunks.push(chunk));
			stream.on('end', () => {
				const { mailFrom, rcptTo } = session.envelope;
				messages.push({
					from: mailFrom ? mailFrom.address : '',
					to: rcptTo.map((rcpt) => rcpt.address),
					auth: session.user as RecordedAuth | undefined,
					secure: session.secure,
					raw: Buffer.concat(chunks)
				});
				callback();
			});
		}
	});
	// An unhandled 'error' would crash the test process; failed handshakes land here.
	server.on('error', (err) => errors.push(err));
	const connections = trackConnections(server.server);
	await listen(server.server);
	const addr = server.server.address() as AddressInfo;

	return {
		host: SMTP_TEST_HOST,
		port: addr.port,
		transport,
		cert,
		ca: SMTP_TEST_CA,
		auths,
		messages,
		connections,
		errors,
		get listening() {
			return server.server.listening;
		},
		address: () => addr,
		setMode(next, opts = {}) {
			mode = next;
			if (opts.authRejectText !== undefined) authRejectText = opts.authRejectText;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

/** What the non-SMTP listener greets with: an SSH banner, not a 220. */
export const NON_SMTP_GREETING = 'SSH-2.0-OpenSSH_9.6\r\n';

export interface NonSmtpListener {
	readonly host: typeof SMTP_TEST_HOST;
	readonly port: number;
	readonly connections: RecordedConnection[];
	readonly listening: boolean;
	address(): AddressInfo;
	close(): Promise<void>;
}

/**
 * A plain-TCP listener on 127.0.0.1 that greets every connection with a non-SMTP
 * banner and keeps the socket open, for the 'not an SMTP server' case.
 */
export async function startNonSmtpListener(): Promise<NonSmtpListener> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.write(NON_SMTP_GREETING);
	});
	const connections = trackConnections(server);
	await listen(server);
	const addr = server.address() as AddressInfo;

	return {
		host: SMTP_TEST_HOST,
		port: addr.port,
		connections,
		get listening() {
			return server.listening;
		},
		address: () => addr,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
			})
	};
}
