// Test-only control channel for the packaged e2e suites (decision cli_inspect_fuse,
// c-22, c-27). The shipped app has the Node inspector fuse off, so the harness can no
// longer evaluate code in main; instead it drops request files into a directory and
// main answers from a fixed set of commands.
//
// Inactive unless PRICE_CHECK_E2E_CONTROL_DIR names an absolute directory at launch:
// without it nothing here touches the filesystem or starts a timer. It never opens a
// network listener and never evaluates code: a request names one command from a fixed
// set, with exactly that command's fields, or gets {ok:false, error:'unknown command'}.
// Every response is scrubbed of the window's session secret, which appGet uses to
// reach main's own server.
//
// Layout: <dir>/<pid>/req-<n>.json → <dir>/<pid>/res-<n>.json, the response written
// to a temp file and renamed so the harness never reads half a file. Only this
// process's own <pid> directory is polled.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** Test-only: names the control directory. Read once at launch and removed from env. */
export const E2E_CONTROL_ENV = 'PRICE_CHECK_E2E_CONTROL_DIR';

/** How often the request directory is polled. */
export const E2E_CONTROL_POLL_MS = 100;

/** The directory E2E_CONTROL_ENV names, removed from `env`; null unless absolute. */
export function takeE2eControlDir(env: NodeJS.ProcessEnv): string | null {
	const dir = env[E2E_CONTROL_ENV];
	delete env[E2E_CONTROL_ENV];
	return dir !== undefined && dir !== '' && isAbsolute(dir) ? dir : null;
}

/** What `info` reports about the running app. */
export type E2eInfo = {
	version: string;
	isPackaged: boolean;
	userData: string;
	platform: string;
	arch: string;
	origin: string;
	argv: string[];
	execArgv: string[];
};

/** One GET of main's own server, with the session cookie: status and body only. */
export type AppGetResult = { status: number; body: string };

/** The commands, each injected by main (wired in t-22). */
export type E2eControlHandlers = {
	pid(): number;
	info(): E2eInfo | Promise<E2eInfo>;
	quit(): unknown;
	loginItemOff(): unknown;
	updaterStatus(): unknown;
	updaterCheckNow(): unknown;
	updaterRestart(): unknown;
	keyBackend(): unknown;
	/** Requests `path` from main's own server with the session cookie. */
	appGet(path: string): Promise<AppGetResult>;
	/** The window's session secret, scrubbed from every response. */
	sessionSecret(): string;
};

/** The filesystem calls the channel makes (node:fs/promises by default). */
export type ControlFs = {
	mkdir(path: string, options: { recursive: true }): Promise<unknown>;
	readdir(path: string): Promise<string[]>;
	readFile(path: string, encoding: 'utf8'): Promise<string>;
	writeFile(path: string, data: string): Promise<unknown>;
	rename(from: string, to: string): Promise<unknown>;
	rm(path: string, options: { force: true }): Promise<unknown>;
};

export type ControlTimers = {
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
};

export type E2eControlOptions = {
	pid: number;
	fs?: ControlFs;
	timers?: ControlTimers;
	pollMs?: number;
};

export type E2eControl = {
	/** Stops polling; resolves once any request in progress has been answered. */
	stop(): Promise<void>;
	/** Runs one poll now (tests): answers every pending request. */
	poll(): Promise<void>;
};

type Response = { ok: true; result: unknown } | { ok: false; error: string };

/** Commands taking no fields beyond cmd. */
const PLAIN = new Set([
	'pid',
	'info',
	'quit',
	'loginItemOff',
	'updaterStatus',
	'updaterCheckNow',
	'updaterRestart',
	'keyBackend'
]);
/** Commands whose response is written before they run: they end the process. */
const ENDS_PROCESS = new Set(['quit', 'updaterRestart']);

const REQUEST = /^req-(\d{1,9})\.json$/;

const defaultFs: ControlFs = {
	mkdir: (path, options) => mkdir(path, options),
	readdir: (path) => readdir(path),
	readFile: (path, encoding) => readFile(path, encoding),
	writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
	rename: (from, to) => rename(from, to),
	rm: (path, options) => rm(path, options)
};

const defaultTimers: ControlTimers = {
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

type Parsed =
	| { cmd: 'appGet'; path: string }
	| { cmd: Exclude<keyof E2eControlHandlers, 'appGet' | 'sessionSecret'> }
	| null;

/** The request as a known command with exactly its fields, or null. */
function parseRequest(text: string): Parsed {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// Not JSON: answered as an unknown command, like any other bad request.
		return null;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const fields = Object.keys(value);
	const cmd = (value as { cmd?: unknown }).cmd;
	if (typeof cmd !== 'string') return null;
	if (PLAIN.has(cmd)) {
		return fields.length === 1 ? ({ cmd } as Parsed) : null;
	}
	if (cmd === 'appGet') {
		const path = (value as { path?: unknown }).path;
		const exact = fields.length === 2 && fields.includes('path');
		return exact && typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
			? { cmd, path }
			: null;
	}
	return null;
}

/** The response as JSON, with every occurrence of the session secret removed. */
function serialise(response: Response, secret: string, cmd: string): string {
	let json: string;
	try {
		json = JSON.stringify(response) ?? JSON.stringify({ ok: true, result: null });
	} catch {
		// A result JSON cannot hold (a BigInt, a cycle): say so rather than answer nothing.
		json = JSON.stringify({ ok: false, error: `${cmd} result not serialisable` });
	}
	return secret === '' ? json : json.split(secret).join('[redacted]');
}

/** A fixed line on stderr: never an error's text, which could carry the secret. */
function report(line: string): void {
	console.error(`[e2e-control] ${line}`);
}

/** Runs one command; a handler that throws gives a fixed error, never its text. */
async function run(parsed: NonNullable<Parsed>, handlers: E2eControlHandlers): Promise<Response> {
	try {
		if (parsed.cmd === 'appGet') {
			const { status, body } = await handlers.appGet(parsed.path);
			return { ok: true, result: { status, body } };
		}
		return { ok: true, result: (await handlers[parsed.cmd]()) ?? null };
	} catch {
		// The error's text could carry anything, the cookie included: report the fact only.
		return { ok: false, error: `${parsed.cmd} failed` };
	}
}

/**
 * Starts answering requests under <dir>/<pid>/. Call only with a directory from
 * takeE2eControlDir; startE2eControlFromEnv does both.
 */
export function startE2eControl(
	dir: string,
	handlers: E2eControlHandlers,
	{ pid, fs = defaultFs, timers = defaultTimers, pollMs = E2E_CONTROL_POLL_MS }: E2eControlOptions
): E2eControl {
	const own = join(dir, String(pid));
	let ready: Promise<unknown> | null = null;
	let running: Promise<void> | null = null;
	let stopped = false;

	async function answer(n: string): Promise<void> {
		const request = join(own, `req-${n}.json`);
		const text = await fs.readFile(request, 'utf8');
		await fs.rm(request, { force: true });
		// The request is consumed from here: every path below writes a response, or
		// reports why it could not, so the harness never just times out in silence.
		try {
			await respond(n, parseRequest(text));
		} catch {
			report(`could not write the response to request ${n}`);
		}
	}

	async function respond(n: string, parsed: Parsed): Promise<void> {
		let secret: string | null;
		try {
			secret = handlers.sessionSecret();
		} catch {
			secret = null;
		}
		const cmd = parsed?.cmd ?? 'unknown';
		const write = async (response: Response) => {
			const temp = join(own, `.res-${n}.json.tmp`);
			await fs.writeFile(temp, serialise(response, secret ?? '', cmd));
			await fs.rename(temp, join(own, `res-${n}.json`));
		};
		if (secret === null) {
			// Without the secret nothing can be redacted, so no handler runs.
			await write({ ok: false, error: 'session secret unavailable' });
			return;
		}
		if (parsed === null) {
			await write({ ok: false, error: 'unknown command' });
			return;
		}
		if (ENDS_PROCESS.has(parsed.cmd)) {
			await write({ ok: true, result: null });
			// Acknowledged before it runs, since it ends the process: a failure can no
			// longer go in the response, so it goes to stderr (the output capture).
			const outcome = await run(parsed, handlers);
			if (!outcome.ok) report(`${parsed.cmd} failed after it was acknowledged`);
			return;
		}
		await write(await run(parsed, handlers));
	}

	async function pollOnce(): Promise<void> {
		ready ??= fs.mkdir(own, { recursive: true });
		await ready;
		const pending = (await fs.readdir(own))
			.map((name) => REQUEST.exec(name)?.[1])
			.filter((n): n is string => n !== undefined)
			.sort((a, b) => Number(a) - Number(b));
		for (const n of pending) {
			if (stopped) return;
			try {
				await answer(n);
			} catch {
				// Only reading or consuming the request lands here (answer() handles the
				// rest): a request that vanished is the harness's to retry, and the
				// channel keeps serving the others.
			}
		}
	}

	function tick(): Promise<void> {
		if (running === null) {
			running = pollOnce()
				.catch(() => {
					// The directory may not exist yet or be mid-cleanup; the next tick retries.
				})
				.finally(() => {
					running = null;
				});
		}
		return running;
	}

	const handle = timers.setInterval(() => void tick(), pollMs);

	return {
		poll: tick,
		async stop() {
			stopped = true;
			timers.clearInterval(handle);
			await running;
		}
	};
}

/**
 * The launch-time entry main calls: takes the directory from `env` and starts the
 * channel, or returns null and does nothing at all when the variable is unset.
 */
export function startE2eControlFromEnv(
	env: NodeJS.ProcessEnv,
	handlers: E2eControlHandlers,
	options: E2eControlOptions
): E2eControl | null {
	const dir = takeE2eControlDir(env);
	return dir === null ? null : startE2eControl(dir, handlers, options);
}
