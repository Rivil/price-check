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
//
// Notifications: a launch with notify: 'record' (or 'unsupported') sets
// PRICE_CHECK_E2E_NOTIFY, so the unpackaged app swaps Electron's Notification class
// for the seam's recorder (src/desktop/notify-seam.ts) on every OS: no notification
// daemon, no OS prompt. recordedNotifications and clickNotification reach it through
// electronApp.evaluate. Without the option the variable is unset and the real class
// is in use.
//
// Windows: the test process never opens a userData DB itself. A libsql handle in
// this process keeps the file locked after close(), so removing the temp dir fails
// with EPERM; seed-child.ts does the DB work in a process that has exited before
// any rmSync. And app.process() is Playwright's cmd wrapper there, so a kill takes
// the whole tree (taskkill /T /F), not just the wrapper.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { defaultRegistry } from '../../src/lib/server/shops/index.ts';
import { DB_FILE_NAME, KEY_FILE_NAME } from '../../src/desktop/app-paths.ts';
import {
	E2E_NOTIFICATIONS_KEY,
	E2E_NOTIFY_ENV,
	type ShownNotification
} from '../../src/desktop/notify-seam.ts';

// resolve() drops the trailing separator fileURLToPath keeps for a directory URL. On
// Windows a trailing backslash breaks Playwright's shell quoting of the app path:
// Electron then shows a modal "cannot find app" box and the launch times out.
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SEED_CHILD = join(REPO_ROOT, 'e2e', 'desktop', 'seed-child.ts');
export const MAIN_JS = join(REPO_ROOT, 'dist-desktop', 'main.js');
export const HANDLER_JS = join(REPO_ROOT, 'build', 'handler.js');
export { DB_FILE_NAME, E2E_NOTIFY_ENV, KEY_FILE_NAME };

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

/** The command line Electron gets: the app path, then any extra arguments. */
export function electronArgs(extra: string[] = []): string[] {
	return [REPO_ROOT, ...extra];
}

/**
 * Chromium switches every launch and relaunch adds after electronArgs. On macOS,
 * --use-mock-keychain gives safeStorage a test keychain (06-remediate-security
 * c-24): the alerts key is still wrapped, but the login keychain is never touched
 * and no access prompt can hang a run.
 */
export function platformSwitches(platform: NodeJS.Platform = process.platform): string[] {
	return platform === 'darwin' ? ['--use-mock-keychain'] : [];
}

/**
 * The tree kill for `pid` on `platform`, or undefined where a plain SIGKILL to the
 * process is enough. On win32 the launched process is a cmd wrapper around Electron.
 */
export function treeKillCommand(
	pid: number | undefined,
	platform: NodeJS.Platform = process.platform
): { file: string; args: string[] } | undefined {
	if (platform !== 'win32' || pid === undefined) return undefined;
	return { file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
}

/**
 * Runs seed-child.ts in its own Node process and resolves with its stdout once it
 * has exited, so any DB handle it opened is gone with it.
 */
function runSeedChild(args: string[]): Promise<string> {
	return new Promise((done, fail) => {
		execFile(
			process.execPath,
			[SEED_CHILD, ...args],
			{ cwd: REPO_ROOT, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) fail(new Error(`seed-child ${args[0]} failed: ${error.message}\n${stderr}`));
				else done(stdout);
			}
		);
	});
}

/** A watch row as the specs seed it. */
export type SeedWatch = {
	id: string;
	shop: string;
	productId: string;
	canonicalUrl: string;
	title?: string;
};

/**
 * Inserts `watches` into the userData DB from a child process, migrating it first
 * when `migrate` is set (a userData no app has opened yet).
 */
export async function insertWatches(
	userData: string,
	watches: SeedWatch[],
	{ migrate = false }: { migrate?: boolean } = {}
): Promise<void> {
	await runSeedChild(['insert', userData, JSON.stringify({ migrate, watches })]);
}

/** A migrated DB in `userData` holding one watch per URL, written by a child process. */
export async function seedWatches(userData: string, urls: string[]): Promise<void> {
	const watches = urls.map((canonicalUrl, i) => ({
		id: `w${i}`,
		shop: 'e2e',
		productId: `p${i}`,
		canonicalUrl
	}));
	await insertWatches(userData, watches, { migrate: true });
}

/** Sets lastCheckedAt on the given watches, from a child process. */
export async function ageLastChecks(userData: string, ids: string[], at: Date): Promise<void> {
	await runSeedChild(['age', userData, JSON.stringify({ ids, at: at.getTime() })]);
}

/**
 * A v0.1.5 install in `userData`, written by a child process: a migrated DB with an
 * SMTP channel sealed under `key` (32 bytes), and alerts.key holding `key` as raw
 * base64, the form v0.1.5 wrote before keys were wrapped with safeStorage.
 */
export async function seedV015(
	userData: string,
	key: Buffer,
	smtp: Record<string, string>
): Promise<void> {
	await runSeedChild(['v015', userData, JSON.stringify({ key: key.toString('base64'), smtp })]);
}

/** Stored rows as JSON (dates as ISO strings, channel config still encrypted). */
export type DbSnapshot = {
	watches: Record<string, unknown>[];
	channels: Record<string, unknown>[];
};

/** Every watch and alert channel in the userData DB, read by a child process. */
export async function dbSnapshot(userData: string): Promise<DbSnapshot> {
	return JSON.parse(await runSeedChild(['snapshot', userData])) as DbSnapshot;
}

/** Every watch URL in the userData DB, read by a child process; [] without a DB. */
export async function watchUrls(userData: string): Promise<string[]> {
	if (!existsSync(join(userData, DB_FILE_NAME))) return [];
	const urls: unknown = JSON.parse(await runSeedChild(['urls', userData]));
	if (!Array.isArray(urls) || !urls.every((url) => typeof url === 'string')) {
		throw new Error(`seed-child urls: not a string array: ${JSON.stringify(urls)}`);
	}
	return urls;
}

/** Printed by src/desktop/main.ts once its server is up. */
const LISTENING = /^\[desktop\] listening on (http:\/\/127\.0\.0\.1:(\d+))\s*$/m;

const DEFAULT_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 15_000;

/** A fresh temp dir, its path resolved (macOS /var is /private/var) so comparisons hold. */
export function makeTempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), `price-check-e2e-${prefix}-`)));
}

export type SchedulerMode = 'disabled' | 'unsupported-only';

/** The notification seam's mode: 'record' shows nothing and records; 'unsupported' also fails isSupported(). */
export type NotifyMode = 'record' | 'unsupported';

export type DesktopEnvInput = {
	userData: string;
	/** XDG_CONFIG_HOME, so a Linux autostart entry could only land in a temp dir. */
	configHome: string;
	scheduler?: SchedulerMode;
	/** Unset by default: the app uses Electron's real Notification class. */
	notify?: NotifyMode;
	/**
	 * A PEM file the app's Node trusts on top of the system CAs (NODE_EXTRA_CA_CERTS),
	 * so a test SMTP server signed by the test CA verifies. Unset by default.
	 */
	caFile?: string;
};

/** The launched app's whole environment: the allowlist plus the harness's own settings. */
export function desktopEnv({
	userData,
	configHome,
	scheduler = 'disabled',
	notify,
	caFile
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
	if (notify !== undefined) env[E2E_NOTIFY_ENV] = notify;
	if (caFile !== undefined) env.NODE_EXTRA_CA_CERTS = caFile;
	return env;
}

/**
 * Throws unless every watch in the userData DB is a URL no shop adapter claims, so
 * a scheduler pass can only record 'unsupported' failures, never fetch (r-01). A
 * userData with no DB yet holds no watches.
 */
export async function assertOnlyUnsupportedWatches(userData: string): Promise<void> {
	const urls = await watchUrls(userData);
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
	/** Swaps in the notification recorder (see the header); unset uses the real class. */
	notify?: NotifyMode;
	/** How long to wait for the listening line. */
	timeoutMs?: number;
	/** Extra CA PEM file for the app's TLS (see DesktopEnvInput.caFile). */
	caFile?: string;
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
	/** The arguments handed to electron.launch, before platformSwitches. */
	args: string[];
	/** Everything the app wrote to stdout and stderr so far. */
	output(): string;
	/** CSP violations every window has reported so far, as '<directive> <blocked URI>'. */
	cspViolations(): string[];
	/** Forgets the violations seen so far: for a spec that causes them on purpose. */
	clearCspViolations(): void;
	/**
	 * Quits through the app (Playwright's close calls app.quit()), waits for the
	 * process to exit and removes the temp dirs this launch created. Kills the
	 * process and throws if it outlives the deadline. Then throws if any window
	 * reported a CSP violation, so every desktop test gates on zero (c-23). Safe to
	 * call twice.
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

/** Kills `child` and everything it started (see treeKillCommand), then waits for its exit. */
async function killTree(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const tree = treeKillCommand(child.pid);
	if (tree) {
		await new Promise<void>((done) => {
			// A failed taskkill falls through to the plain kill below.
			execFile(tree.file, tree.args, { windowsHide: true }, () => done());
		});
	}
	if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	await exited(child);
}

function assertBuilt(): void {
	for (const file of [MAIN_JS, HANDLER_JS]) {
		if (!existsSync(file)) {
			throw new Error(`launchDesktop: ${file} is missing; run pnpm test:e2e:desktop (it builds)`);
		}
	}
}

/** What a window's CSP listener logs: this marker, the directive and the blocked URI. */
export const CSP_VIOLATION_MARKER = '[e2e-csp-violation]';
/** Chromium's own console line for a CSP violation. */
const NATIVE_CSP = /Content Security Policy|Refused to (?:load|execute|apply|connect|frame|run)/;

/**
 * Logs every securitypolicyviolation in the document through the console, once per
 * document however often it is installed (the init script and the live-window
 * install below can both reach the first page).
 */
export const CSP_LISTENER = `(() => {
	if (window.__e2eCspListener) return;
	window.__e2eCspListener = true;
	document.addEventListener('securitypolicyviolation', (event) => {
		console.warn(${JSON.stringify(CSP_VIOLATION_MARKER)} + ' ' + event.effectiveDirective + ' ' + event.blockedURI);
	}, true);
})();`;

export type CspRecord = { violations: string[]; native: string[] };

/**
 * Records CSP violations from every window, from the first page on: an init script
 * for each new document, the listener added to any window already open, and a
 * console matcher for Chromium's own violation lines in case a listener missed one.
 */
async function recordCsp(app: ElectronApplication): Promise<CspRecord> {
	const record: CspRecord = { violations: [], native: [] };
	await app.context().addInitScript({ content: CSP_LISTENER });
	const attach = (page: Page) => {
		recordCspConsole(page, record);
		// A window that loaded before the init script was registered.
		page.evaluate(CSP_LISTENER).catch(() => {
			// The page closed or navigated mid-install: its next document gets the init script.
		});
	};
	app.on('window', attach);
	for (const page of app.windows()) attach(page);
	return record;
}

/** Adds `page`'s CSP console lines (the listener's and Chromium's own) to `record`. */
export function recordCspConsole(page: Page, record: CspRecord): void {
	page.on('console', (message) => {
		const text = message.text();
		if (text.startsWith(CSP_VIOLATION_MARKER)) {
			record.violations.push(text.slice(CSP_VIOLATION_MARKER.length).trim());
		} else if (NATIVE_CSP.test(text)) {
			record.native.push(text);
		}
	});
}

/** Throws naming every CSP violation a launch recorded. */
function assertNoCspViolations(record: CspRecord): void {
	// A native line with no listener record means the listener missed it: still a failure.
	const seen = record.violations.length > 0 ? record.violations : record.native;
	if (seen.length > 0) {
		throw new Error(`launchDesktop: CSP violation(s) in the app's windows:\n${seen.join('\n')}`);
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
		const env = desktopEnv({
			userData,
			configHome,
			scheduler,
			notify: options.notify,
			caFile: options.caFile
		});
		const args = electronArgs(options.args);

		app = await _electron.launch({
			args: [...args, ...platformSwitches()],
			cwd,
			env,
			// Keep Chromium's sandbox on Linux too: Playwright would otherwise add --no-sandbox.
			chromiumSandbox: true,
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		});
		const child = app.process();
		const output = collectOutput(child);
		const csp = await recordCsp(app);
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
					await quit(launched, child, output);
				} finally {
					removeOwned();
				}
				assertNoCspViolations(csp);
			})();
			return closing;
		};
		return {
			app: launched,
			userData,
			cwd,
			origin,
			port,
			env,
			args,
			output,
			close,
			cspViolations: () => [...csp.violations],
			clearCspViolations: () => {
				csp.violations.length = 0;
				csp.native.length = 0;
			}
		};
	} catch (error) {
		if (app) await killTree(app.process());
		removeOwned();
		throw error;
	}
}

/**
 * `child` is the process captured at launch: once it has exited (a spec quit the app
 * itself), Playwright may have disposed `app`, and app.process() then throws on
 * Windows, so a gone process is left as it is.
 */
async function quit(
	app: ElectronApplication,
	child: ChildProcess,
	output: () => string
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<'timeout'>((done) => {
		timer = setTimeout(() => done('timeout'), CLOSE_TIMEOUT_MS);
	});
	const outcome = await Promise.race([app.close().then(() => 'closed' as const), deadline]);
	clearTimeout(timer);
	if (outcome === 'timeout') {
		await killTree(child);
		throw new Error(
			`launchDesktop: the app did not quit within ${CLOSE_TIMEOUT_MS}ms:\n${tail(output())}`
		);
	}
	await exited(child);
}

/** The seam's registry key, passed into evaluate: a Symbol cannot cross into it. */
const NOTIFICATIONS_KEY = E2E_NOTIFICATIONS_KEY.description ?? '';

/**
 * Every notification the app has shown so far, in order, as the seam recorded them.
 * Throws if the recorder is not installed (a launch without notify: 'record').
 */
export async function recordedNotifications(
	app: ElectronApplication
): Promise<ShownNotification[]> {
	return app.evaluate((_electron, key) => {
		const records = (globalThis as Record<symbol, { shown: ShownNotification[] } | undefined>)[
			Symbol.for(key)
		];
		if (!records) throw new Error('no e2e notification recorder: launch with notify set');
		return records.shown.map(({ title, body }) => ({ title, body }));
	}, NOTIFICATIONS_KEY);
}

/** Clicks the index-th shown notification, as the user clicking it in the OS would. */
export async function clickNotification(app: ElectronApplication, index: number): Promise<void> {
	await app.evaluate(
		async (_electron, { key, index }) => {
			const records = (
				globalThis as Record<symbol, { click(i: number): Promise<void> } | undefined>
			)[Symbol.for(key)];
			if (!records) throw new Error('no e2e notification recorder: launch with notify set');
			await records.click(index);
		},
		{ key: NOTIFICATIONS_KEY, index }
	);
}

/** Whether the seam's recorder global exists in the app's main process. */
export async function hasNotificationRecorder(app: ElectronApplication): Promise<boolean> {
	return app.evaluate(
		(_electron, key) => (globalThis as Record<symbol, unknown>)[Symbol.for(key)] !== undefined,
		NOTIFICATIONS_KEY
	);
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
	const child = spawn(binary, [...electronArgs(args), ...platformSwitches()], {
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
	/**
	 * Fail once this long has passed without the whole response, and destroy the
	 * request: a server that accepts but never answers would otherwise hold the caller
	 * until its test times out. Unset waits as long as the server takes.
	 */
	timeoutMs?: number;
};

/**
 * One request over plain node:http to 127.0.0.1:<port>, with full control of the
 * Host and Origin headers, as a foreign client or a rebinding page would send them.
 */
export function rawRequest(port: number, req: RawRequest = {}): Promise<RawResponse> {
	return new Promise((resolveResponse, rejectResponse) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (response: RawResponse) => {
			clearTimeout(timer);
			resolveResponse(response);
		};
		const fail = (error: unknown) => {
			clearTimeout(timer);
			rejectResponse(error);
		};
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
		if (req.timeoutMs !== undefined) {
			const ms = req.timeoutMs;
			timer = setTimeout(() => {
				const error = new Error(
					`rawRequest: no complete response from 127.0.0.1:${port}${req.path ?? '/'} within ${ms}ms`
				);
				// Rejected here, not left to the 'error' events destroy() emits: which stream
				// gets one depends on whether the response had begun.
				fail(error);
				outgoing.destroy(error);
			}, ms);
		}
		if (req.body !== undefined) outgoing.write(req.body);
		outgoing.end();
	});
}
