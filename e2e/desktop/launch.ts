// Launches the real Electron app for the desktop e2e specs (spec c-1, c-5, c-8):
// Playwright's _electron on the repo root, whose package.json main is the built
// dist-desktop/main.js, against the built SvelteKit server in build/. Run
// `pnpm test:e2e:desktop`, which builds both first.
//
// Every launch is isolated: its own temp userData (PRICE_CHECK_USER_DATA), its own
// temp cwd and XDG_CONFIG_HOME, and an env built from an allowlist, never a
// process.env spread, so a developer's DATABASE_URL, key or ORIGIN can never reach
// the app and the developer's real userData is never opened. The scheduler is off
// (SCHEDULER_DISABLED=1) unless a spec asks for 'unsupported-only', which refuses to
// launch while the userData DB holds any watch a shop adapter would fetch (r-01).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication } from '@playwright/test';
import { createDb } from '../../src/lib/server/db/client.ts';
import { watch } from '../../src/lib/server/db/schema.ts';
import { defaultRegistry } from '../../src/lib/server/shops/index.ts';
import { DB_FILE_NAME, KEY_FILE_NAME } from '../../src/desktop/app-paths.ts';
import { databaseUrl } from '../../src/desktop/server-env.ts';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const MAIN_JS = join(REPO_ROOT, 'dist-desktop', 'main.js');
export const HANDLER_JS = join(REPO_ROOT, 'build', 'handler.js');
export { DB_FILE_NAME, KEY_FILE_NAME };

/** The only variables taken from this process: enough to run Electron on every OS. */
export const INHERITED_ENV = [
	'PATH',
	'HOME',
	'SystemRoot',
	'TEMP',
	'TMP',
	'USERPROFILE',
	'APPDATA',
	'LOCALAPPDATA',
	'DISPLAY',
	'XAUTHORITY',
	'XDG_RUNTIME_DIR'
] as const;

/** Printed by src/desktop/main.ts once its server is up. */
const LISTENING = /^\[desktop\] listening on (http:\/\/127\.0\.0\.1:(\d+))\s*$/m;

const DEFAULT_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 15_000;

/** A fresh temp dir, its path resolved (macOS /var is /private/var) so comparisons hold. */
export function makeTempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), `price-check-e2e-${prefix}-`)));
}

export type SchedulerMode = 'disabled' | 'unsupported-only';

export type DesktopEnvInput = {
	userData: string;
	/** XDG_CONFIG_HOME, so a Linux autostart entry could only land in a temp dir. */
	configHome: string;
	scheduler?: SchedulerMode;
};

/** The launched app's whole environment: the allowlist plus the harness's own settings. */
export function desktopEnv({
	userData,
	configHome,
	scheduler = 'disabled'
}: DesktopEnvInput): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of INHERITED_ENV) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	env.PRICE_CHECK_USER_DATA = userData;
	env.XDG_CONFIG_HOME = configHome;
	// A launched app must never check a real shop (r-01).
	if (scheduler !== 'unsupported-only') env.SCHEDULER_DISABLED = '1';
	return env;
}

/**
 * Throws unless every watch in the userData DB is a URL no shop adapter claims, so
 * a scheduler pass can only record 'unsupported' failures, never fetch (r-01). A
 * userData with no DB yet holds no watches.
 */
export async function assertOnlyUnsupportedWatches(userData: string): Promise<void> {
	const dbFile = join(userData, DB_FILE_NAME);
	if (!existsSync(dbFile)) return;
	const db = createDb(databaseUrl(dbFile));
	let urls: string[];
	try {
		urls = (await db.select({ url: watch.canonicalUrl }).from(watch)).map((row) => row.url);
	} finally {
		db.$client.close();
	}
	const fetchable = urls.filter((url) => defaultRegistry.identify(url).kind !== 'unsupported');
	if (fetchable.length > 0) {
		throw new Error(
			`launchDesktop: scheduler 'unsupported-only' refused, the DB holds shop URLs: ${fetchable.join(', ')}`
		);
	}
}

export type LaunchOptions = {
	/** Defaults to a fresh temp dir, removed on close. A given dir is left in place. */
	userData?: string;
	/** Defaults to a fresh temp dir, removed on close. A given dir is left in place. */
	cwd?: string;
	/** Extra command-line arguments, e.g. '--login-launch'. */
	args?: string[];
	scheduler?: SchedulerMode;
	/** How long to wait for the listening line. */
	timeoutMs?: number;
};

export type DesktopApp = {
	app: ElectronApplication;
	userData: string;
	cwd: string;
	/** http://127.0.0.1:<port>, from the listening line. */
	origin: string;
	port: number;
	/** The environment the app was launched with. */
	env: Record<string, string>;
	/** Everything the app wrote to stdout and stderr so far. */
	output(): string;
	/**
	 * Quits through the app (Playwright's close calls app.quit()), waits for the
	 * process to exit and removes the temp dirs this launch created. Kills the
	 * process and throws if it outlives the deadline. Safe to call twice.
	 */
	close(): Promise<void>;
};

function collectOutput(child: ChildProcess): () => string {
	let text = '';
	const append = (chunk: Buffer | string) => {
		text += chunk.toString();
	};
	child.stdout?.on('data', append);
	child.stderr?.on('data', append);
	return () => text;
}

const tail = (text: string) => text.split(/\r?\n/).slice(-40).join('\n');

/** Resolves with the origin and port once `output` shows the listening line. */
function waitForListening(
	child: ChildProcess,
	output: () => string,
	timeoutMs: number
): Promise<{ origin: string; port: number }> {
	return new Promise((done, fail) => {
		const check = () => {
			const match = LISTENING.exec(output());
			if (!match) return;
			cleanup();
			done({ origin: match[1], port: Number(match[2]) });
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			fail(
				new Error(
					`launchDesktop: the app exited (code ${code}, signal ${signal}) before listening:\n${tail(output())}`
				)
			);
		};
		const timer = setTimeout(() => {
			cleanup();
			fail(new Error(`launchDesktop: no listening line after ${timeoutMs}ms:\n${tail(output())}`));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			child.stdout?.off('data', check);
			child.stderr?.off('data', check);
			child.off('exit', onExit);
		};
		child.stdout?.on('data', check);
		child.stderr?.on('data', check);
		child.once('exit', onExit);
		check();
	});
}

function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((done) => child.once('exit', () => done()));
}

function assertBuilt(): void {
	for (const file of [MAIN_JS, HANDLER_JS]) {
		if (!existsSync(file)) {
			throw new Error(`launchDesktop: ${file} is missing; run pnpm test:e2e:desktop (it builds)`);
		}
	}
}

/** Launches the app and waits until its server is listening. */
export async function launchDesktop(options: LaunchOptions = {}): Promise<DesktopApp> {
	assertBuilt();
	const scheduler = options.scheduler ?? 'disabled';
	const owned: string[] = [];
	const own = (prefix: string) => {
		const dir = makeTempDir(prefix);
		owned.push(dir);
		return dir;
	};
	const removeOwned = () => {
		for (const dir of owned) rmSync(dir, { recursive: true, force: true });
	};

	let app: ElectronApplication | undefined;
	try {
		const userData = options.userData ?? own('userdata');
		const cwd = options.cwd ?? own('cwd');
		const configHome = own('xdg-config');
		// Before anything starts: a refused launch must never reach Electron.
		if (scheduler === 'unsupported-only') await assertOnlyUnsupportedWatches(userData);
		const env = desktopEnv({ userData, configHome, scheduler });

		app = await _electron.launch({
			args: [REPO_ROOT, ...(options.args ?? [])],
			cwd,
			env,
			// Keep Chromium's sandbox on Linux too: Playwright would otherwise add --no-sandbox.
			chromiumSandbox: true,
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		});
		const child = app.process();
		const output = collectOutput(child);
		const { origin, port } = await waitForListening(
			child,
			output,
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		);

		const launched = app;
		let closing: Promise<void> | undefined;
		const close = () => {
			closing ??= (async () => {
				try {
					await quit(launched, output);
				} finally {
					removeOwned();
				}
			})();
			return closing;
		};
		return { app: launched, userData, cwd, origin, port, env, output, close };
	} catch (error) {
		if (app) {
			app.process().kill('SIGKILL');
			await exited(app.process());
		}
		removeOwned();
		throw error;
	}
}

async function quit(app: ElectronApplication, output: () => string): Promise<void> {
	const child = app.process();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<'timeout'>((done) => {
		timer = setTimeout(() => done('timeout'), CLOSE_TIMEOUT_MS);
	});
	const outcome = await Promise.race([app.close().then(() => 'closed' as const), deadline]);
	clearTimeout(timer);
	if (outcome === 'timeout') {
		child.kill('SIGKILL');
		await exited(child);
		throw new Error(
			`launchDesktop: the app did not quit within ${CLOSE_TIMEOUT_MS}ms:\n${tail(output())}`
		);
	}
	await exited(child);
}

export type SecondInstance = {
	child: ChildProcess;
	/** Resolves when the process exits. */
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	output(): string;
	/** Kills it if still running and waits for the exit. */
	kill(): Promise<void>;
};

/**
 * Starts the app again on `first`'s userData and env, outside Playwright, as a user
 * relaunching it would. The single-instance lock should make it exit at once.
 */
export function spawnSecondInstance(first: DesktopApp, args: string[] = []): SecondInstance {
	assertBuilt();
	const binary = createRequire(import.meta.url)('electron') as string;
	const child = spawn(binary, [REPO_ROOT, ...args], {
		cwd: first.cwd,
		env: first.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const output = collectOutput(child);
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
		child.once('exit', (code, signal) => done({ code, signal }));
	});
	return {
		child,
		exit,
		output,
		async kill() {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			await exit;
		}
	};
}

export type RawResponse = {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
};

export type RawRequest = {
	method?: string;
	path?: string;
	/** Sent as given, Host included: nothing is derived from the URL. */
	headers?: Record<string, string>;
	body?: string;
};

/**
 * One request over plain node:http to 127.0.0.1:<port>, with full control of the
 * Host and Origin headers, as a foreign client or a rebinding page would send them.
 */
export function rawRequest(port: number, req: RawRequest = {}): Promise<RawResponse> {
	return new Promise((done, fail) => {
		const outgoing = request(
			{
				host: '127.0.0.1',
				port,
				method: req.method ?? 'GET',
				path: req.path ?? '/',
				headers: req.headers,
				setHost: req.headers?.host === undefined && req.headers?.Host === undefined,
				agent: false
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () =>
					done({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString('utf8')
					})
				);
				res.on('error', fail);
			}
		);
		outgoing.on('error', fail);
		if (req.body !== undefined) outgoing.write(req.body);
		outgoing.end();
	});
}
