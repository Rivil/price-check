// Starts the production server (`node build`, adapter-node) as a child process on
// its own port and database file, for specs that need a real server lifecycle —
// a restart on the same DB, an env with a variable unset. Plain Node: no $app/*.
//
// The child's env is built from an allowlist, never a process.env spread: a spec
// must state every variable the server sees, so "starts without X" means X is
// really absent (c-2), whatever the developer's shell or CI exports.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The only variables taken from this process: enough to run node on every OS. */
const INHERITED = ['PATH', 'SystemRoot', 'HOME'] as const;

/**
 * adapter-node's drain on SIGTERM, in seconds (its default is 30). A connection a
 * client still holds open — a page left on the server, a preconnected socket —
 * keeps the drain waiting that long, past a 30s test timeout.
 */
export const E2E_SHUTDOWN_TIMEOUT = '1';

/**
 * How long stop() waits after SIGTERM before SIGKILL, for a child whose drain runs
 * longer (a caller-set SHUTDOWN_TIMEOUT, a hung handler). Above the 1s drain, so a
 * server with the default env always gets its graceful shutdown.
 */
export const STOP_GRACE_MS = 3_000;

export type NodeServerOptions = {
	port: number;
	/** SQLite file the server opens (DATABASE_URL=file:<dbFile>). */
	dbFile: string;
	/** Every other variable the server gets, e.g. ALERTS_ENCRYPTION_KEY. */
	env?: Record<string, string>;
	/** Script to run, relative to the repo root. Specs probing this helper override it. */
	entry?: string;
	/** How long to wait for /health to answer 200. */
	timeoutMs?: number;
};

export type NodeServer = {
	url: string;
	/**
	 * SIGTERM, then SIGKILL past STOP_GRACE_MS; resolves only once the server has
	 * exited (its DB file is released).
	 */
	stop(): Promise<void>;
};

/** The env the child gets: the allowlist, the server's own settings, then `env`. */
export function nodeServerEnv({
	port,
	dbFile,
	env = {}
}: Pick<NodeServerOptions, 'port' | 'dbFile' | 'env'>): Record<string, string> {
	const inherited: Record<string, string> = {};
	for (const name of INHERITED) {
		const value = process.env[name];
		if (value !== undefined) inherited[name] = value;
	}
	return {
		...inherited,
		HOST: '127.0.0.1',
		PORT: String(port),
		DATABASE_URL: `file:${resolve(dbFile)}`,
		// A spawned server must never re-check watches: that would be a live fetch (r-01).
		SCHEDULER_DISABLED: '1',
		SHUTDOWN_TIMEOUT: E2E_SHUTDOWN_TIMEOUT,
		...env
	};
}

/** A TCP port that was free a moment ago. */
export function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const probe = createServer();
		probe.once('error', fail);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() =>
				typeof address === 'object' && address !== null
					? done(address.port)
					: fail(new Error('node-server: no port assigned'))
			);
		});
	});
}

/**
 * Spawns the server and waits until GET /health answers 200. Rejects at once if
 * the entry script is missing (run `pnpm build` first), and if the server exits or
 * stays unhealthy past `timeoutMs`, with the tail of its output.
 */
export async function startNodeServer({
	port,
	dbFile,
	env,
	entry = 'build/index.js',
	timeoutMs = 30_000
}: NodeServerOptions): Promise<NodeServer> {
	const script = resolve(REPO_ROOT, entry);
	if (!existsSync(script)) {
		throw new Error(`node-server: ${entry} is missing; run pnpm build first`);
	}
	return launch({
		args: [script],
		env: nodeServerEnv({ port, dbFile, env }),
		port,
		label: entry,
		timeoutMs
	});
}

/** Vite's own CLI script, run with this node: no shell, no .bin shim (Windows). */
const VITE_BIN = 'node_modules/vite/bin/vite.js';

export type DevServerOptions = Omit<NodeServerOptions, 'entry'>;

/**
 * Starts `vite dev` on 127.0.0.1:<port> (strictPort, so a taken port fails rather
 * than moving) with the same allowlisted env as `node build` — its own database,
 * the scheduler off (r-01) — and waits until GET /health answers 200. The first
 * request compiles the app, so the default wait is longer than startNodeServer's.
 */
export async function startDevServer({
	port,
	dbFile,
	env,
	timeoutMs = 90_000
}: DevServerOptions): Promise<NodeServer> {
	return launch({
		args: [
			resolve(REPO_ROOT, VITE_BIN),
			'dev',
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--strictPort'
		],
		env: nodeServerEnv({ port, dbFile, env }),
		port,
		label: 'vite dev',
		timeoutMs
	});
}

/** Spawns `node <args>` and resolves once GET /health answers 200 (see startNodeServer). */
async function launch({
	args,
	env,
	port,
	label,
	timeoutMs
}: {
	args: string[];
	env: Record<string, string>;
	port: number;
	label: string;
	timeoutMs: number;
}): Promise<NodeServer> {
	const child = spawn(process.execPath, args, {
		cwd: REPO_ROOT,
		env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	const collect = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-4000);
	};
	child.stdout.on('data', collect);
	child.stderr.on('data', collect);

	let exited = child.exitCode !== null || child.signalCode !== null;
	const exit = new Promise<void>((done) => {
		const settle = () => {
			exited = true;
			done();
		};
		child.once('exit', settle);
		// A failed spawn emits 'error' and may never emit 'exit'.
		child.once('error', (error) => {
			collect(Buffer.from(String(error)));
			settle();
		});
	});

	// Awaiting exit matters on Windows: libsql holds the DB file open until the
	// process is gone, so a restart or cleanup right after kill() would fail. The
	// SIGKILL only cuts a drain short; stop() still resolves on 'exit' alone.
	const stop = async () => {
		if (exited) return;
		child.kill('SIGTERM');
		const escalate = setTimeout(() => {
			if (!exited) child.kill('SIGKILL');
		}, STOP_GRACE_MS);
		try {
			await exit;
		} finally {
			clearTimeout(escalate);
		}
	};

	const url = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + timeoutMs;
	while (!exited) {
		try {
			const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
			await res.body?.cancel();
			if (res.status === 200) return { url, stop };
		} catch {
			// Not listening yet.
		}
		if (Date.now() > deadline) {
			await stop();
			throw new Error(`node-server: ${label} /health not ready after ${timeoutMs}ms\n${output}`);
		}
		await new Promise((done) => setTimeout(done, 100));
	}
	await exit;
	throw new Error(`node-server: ${label} exited before /health answered\n${output}`);
}
