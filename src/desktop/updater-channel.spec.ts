// Drives electron-updater's real AppUpdater and GitHubProvider, configured by
// createUpdater, against a local http fake of GitHub Releases (releases.atom,
// /releases/latest, latest*.yml). No network. Proves the channel rules of spec c-5:
// an rc install takes the final release, a final install never takes an rc, and no
// rc*.yml is ever asked for (t-2 sets detectUpdateChannel false, so every release
// publishes latest*.yml only).
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronUpdater from 'electron-updater';
import type { AppAdapter } from 'electron-updater/out/AppAdapter';
import type {
	DownloadExecutorResult,
	DownloadUpdateOptions
} from 'electron-updater/out/AppUpdater';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopNotifier } from '#lib/server/notify-bridge.ts';
import { createUpdater, type UpdaterStatus } from './updater.ts';

const OWNER = 'Rivil';
const REPO = 'price-check';
const RC_CHANNEL_FILE = /\/rc(-[^/]*)?\.yml$/;
const LATEST_CHANNEL_FILE = /^latest(-mac|-linux(-[a-z0-9]+)?)?\.yml$/;

const { AppUpdater } = electronUpdater;

// builder-util-runtime is electron-updater's own dependency: reach it through
// electron-updater so the provider's HttpError checks see the same class.
const requireFromUpdater = createRequire(
	createRequire(import.meta.url).resolve('electron-updater')
);
type HttpExecutorBase = abstract new () => object;
const { HttpExecutor } = requireFromUpdater('builder-util-runtime') as {
	HttpExecutor: HttpExecutorBase;
};

/** builder-util's NodeHttpExecutor, minus the proxy support. */
class NodeHttpExecutor extends HttpExecutor {
	createRequest(options: Parameters<typeof httpRequest>[0], callback: () => void) {
		return httpRequest(options, callback);
	}
}

type Release = { tag: string; prerelease: boolean };

/** GitHub Releases as electron-updater's GitHub provider reads it. Newest first. */
function startFeed(
	releases: Release[]
): Promise<{ server: Server; port: number; requests: string[] }> {
	const requests: string[] = [];
	const base = `/${OWNER}/${REPO}/releases`;
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
		requests.push(path);
		if (path === `${base}.atom`) {
			res.writeHead(200, { 'content-type': 'application/atom+xml' });
			res.end(atom(releases));
			return;
		}
		if (path.endsWith(`/${OWNER}/${REPO}/releases/latest`)) {
			// GitHub's latest release is the newest that is not a pre-release.
			const latest = releases.find((release) => !release.prerelease);
			res.writeHead(latest ? 200 : 404, { 'content-type': 'application/json' });
			res.end(latest ? JSON.stringify({ tag_name: latest.tag }) : '{}');
			return;
		}
		const download = path.match(new RegExp(`^${base}/download/([^/]+)/([^/]+)$`));
		if (
			download &&
			LATEST_CHANNEL_FILE.test(download[2]) &&
			releases.some((release) => release.tag === download[1])
		) {
			res.writeHead(200, { 'content-type': 'text/yaml' });
			res.end(latestYml(download[1].replace(/^v/, '')));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			resolve({ server, port: (server.address() as AddressInfo).port, requests });
		});
	});
}

function atom(releases: Release[]): string {
	const entries = releases
		.map(
			({ tag }) =>
				`<entry><id>tag:github.com,2008:Repository/1/${tag}</id>` +
				`<updated>2026-11-14T00:00:00Z</updated>` +
				`<link rel="alternate" type="text/html" href="https://github.com/${OWNER}/${REPO}/releases/tag/${tag}"/>` +
				`<title>${tag}</title><content type="html">No content.</content></entry>`
		)
		.join('');
	return (
		'<?xml version="1.0" encoding="UTF-8"?>' +
		`<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">` +
		`<id>tag:github.com,2008:https://github.com/${OWNER}/${REPO}/releases</id>` +
		`<title>Release notes from ${REPO}</title>${entries}</feed>`
	);
}

function latestYml(version: string): string {
	const file = `Price-Check-${version}.AppImage`;
	const sha512 = `${'A'.repeat(86)}==`;
	return [
		`version: '${version}'`,
		'files:',
		`  - url: ${file}`,
		`    sha512: ${sha512}`,
		'    size: 1',
		`path: ${file}`,
		`sha512: ${sha512}`,
		"releaseDate: '2026-11-14T00:00:00.000Z'",
		''
	].join('\n');
}

/** A real AppUpdater over a fake Electron app; downloading is stubbed out. */
class FeedUpdater extends AppUpdater {
	readonly downloads: string[] = [];

	constructor(app: AppAdapter, port: number) {
		super(null, app);
		this.logger = null;
		// Electron's net module is not here: plain Node http to the local fake.
		(this as unknown as { httpExecutor: unknown }).httpExecutor = new NodeHttpExecutor();
		this.setFeedURL({
			provider: 'github',
			owner: OWNER,
			repo: REPO,
			host: `127.0.0.1:${port}`,
			protocol: 'http'
		});
	}

	protected doDownloadUpdate(options: DownloadUpdateOptions): Promise<DownloadExecutorResult> {
		const info = options.updateInfoAndProvider.info;
		this.downloads.push(info.version);
		this.dispatchUpdateDownloaded({ ...info, downloadedFile: '/fake/update' });
		return Promise.resolve({ updateFile: '/fake/update' });
	}

	quitAndInstall(): void {}
}

function fakeApp(version: string, userDataPath: string): AppAdapter {
	return {
		version,
		name: 'Price Check',
		isPackaged: true,
		appUpdateConfigPath: join(userDataPath, 'app-update.yml'),
		userDataPath,
		baseCachePath: userDataPath,
		whenReady: () => Promise.resolve(),
		relaunch: () => undefined,
		quit: () => undefined,
		onQuit: () => undefined
	};
}

type Outcome = {
	/** allowPrerelease as the library set it, before createUpdater's start(). */
	prereleaseDefault: boolean;
	allowPrerelease: boolean;
	events: string[];
	downloads: string[];
	requests: string[];
	status: UpdaterStatus;
	shown: number;
};

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function checkAgainstFeed(current: string, releases: Release[]): Promise<Outcome> {
	const { server, port, requests } = await startFeed(releases);
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const userData = mkdtempSync(join(tmpdir(), 'price-check-updater-'));
	cleanups.push(() => rmSync(userData, { recursive: true, force: true }));

	const updater = new FeedUpdater(fakeApp(current, userData), port);
	const events: string[] = [];
	updater.on('update-available', (info) => events.push(`available ${info.version}`));
	updater.on('update-not-available', (info) => events.push(`not-available ${info.version}`));
	updater.on('error', (error) => events.push(`error ${error.message}`));
	const show = vi.fn<DesktopNotifier['show']>(() => Promise.resolve({ ok: true }));
	const prereleaseDefault = updater.allowPrerelease;

	const controller = createUpdater({
		autoUpdater: updater,
		isPackaged: true,
		appVersion: current,
		notifier: { show },
		onReady: () => undefined,
		timers: { setInterval, clearInterval },
		log: { info: () => undefined, error: () => undefined }
	});
	controller.start();
	cleanups.push(() => controller.stop());
	await controller.checkNow();

	return {
		prereleaseDefault,
		allowPrerelease: updater.allowPrerelease,
		events,
		downloads: [...updater.downloads],
		requests: [...requests],
		status: controller.status(),
		shown: show.mock.calls.length
	};
}

describe('update channels through the real GitHub provider', () => {
	it('rc takes final: 0.1.5-rc.1 updates to 0.1.5', async () => {
		const outcome = await checkAgainstFeed('0.1.5-rc.1', [
			{ tag: 'v0.1.5', prerelease: false },
			{ tag: 'v0.1.5-rc.1', prerelease: true }
		]);

		// The library's own default would follow the rc channel and stay on rc.1.
		expect(outcome.prereleaseDefault).toBe(true);
		expect(outcome.events).toEqual(['available 0.1.5']);
		expect(outcome.downloads).toEqual(['0.1.5']);
		expect(outcome.status).toEqual({ state: 'downloaded', version: '0.1.5', notified: ['0.1.5'] });
		expect(outcome.shown).toBe(1);
		expect(outcome.requests.some((p) => p.includes('/download/v0.1.5/latest'))).toBe(true);
		expect(outcome.requests.filter((p) => RC_CHANNEL_FILE.test(p))).toEqual([]);
		expect(outcome.requests.filter((p) => p.includes('/download/v0.1.5-rc.1/'))).toEqual([]);
		expect(outcome.allowPrerelease).toBe(false);
	});

	it('final never takes rc: 0.1.5 ignores a newer 0.1.6-rc.1', async () => {
		const outcome = await checkAgainstFeed('0.1.5', [
			{ tag: 'v0.1.6-rc.1', prerelease: true },
			{ tag: 'v0.1.5', prerelease: false }
		]);

		expect(outcome.events).toEqual(['not-available 0.1.5']);
		expect(outcome.downloads).toEqual([]);
		expect(outcome.status).toEqual({ state: 'idle', version: null, notified: [] });
		expect(outcome.shown).toBe(0);
		expect(outcome.requests.filter((p) => RC_CHANNEL_FILE.test(p))).toEqual([]);
		expect(outcome.requests.filter((p) => p.includes('/download/v0.1.6-rc.1/'))).toEqual([]);
		expect(outcome.allowPrerelease).toBe(false);
	});

	it('an rc install with only rc releases newer asks for no rc*.yml', async () => {
		const outcome = await checkAgainstFeed('0.1.5-rc.1', [
			{ tag: 'v0.1.5-rc.2', prerelease: true },
			{ tag: 'v0.1.5-rc.1', prerelease: true },
			{ tag: 'v0.1.4', prerelease: false }
		]);

		// /releases/latest names 0.1.4: older than rc.1, and downgrade is off.
		expect(outcome.events).toEqual(['not-available 0.1.4']);
		expect(outcome.downloads).toEqual([]);
		expect(outcome.requests.filter((p) => RC_CHANNEL_FILE.test(p))).toEqual([]);
	});
});
