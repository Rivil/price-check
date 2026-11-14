// The CSRF and Host guard in the real app (spec c-3, c-4; decisions server_port and
// desktop_server_wrapper): real Electron, the real built handler behind the
// desktop server's Host check.
//
// Same-origin POSTs come from inside the window, through the page's own forms, so
// the browser sets Origin to the window's http://127.0.0.1:<port>. Foreign requests
// go over raw node:http (launch.ts rawRequest) to the window's port, because fetch
// cannot set Host or a forged Origin.
//
// Nothing here can reach a live shop (r-01): the scheduler is off, every watch URL
// is on a .invalid host no adapter claims (add refuses it before any fetch), and the
// ntfy topic is on a .invalid host and is only saved, never sent to.
import { readdirSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, relative, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { dbSnapshot, launchDesktop, rawRequest, REPO_ROOT, type DesktopApp } from './launch.ts';

/** A test-only topic on a .invalid host (r-01). */
const TOPIC = 'https://ntfy.e2e.invalid/e2e-guard-topic';
/** What a forged save would store instead. */
const FORGED_TOPIC = 'https://ntfy.e2e.invalid/forged-topic';
/** A URL no shop adapter claims: add refuses it with 400 before any fetch (r-01). */
const UNSUPPORTED_URL = 'https://shop.e2e.invalid/item/guard-1';

/** The page a form action's 403 comes from: Kit's CSRF check, not the Host guard. */
const KIT_CSRF = 'Cross-site POST form submissions are forbidden';

const IMMUTABLE_DIR = join(REPO_ROOT, 'build', 'client', '_app', 'immutable');

/** The first file under build/client/_app/immutable, as the URL path the server serves it at. */
function immutableAssetPath(): string {
	const walk = (dir: string): string | undefined => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				const found = walk(full);
				if (found) return found;
			} else if (name.endsWith('.js')) {
				return full;
			}
		}
		return undefined;
	};
	const file = walk(IMMUTABLE_DIR);
	if (!file) throw new Error(`no .js file under ${IMMUTABLE_DIR}; run pnpm test:e2e:desktop`);
	return `/_app/immutable/${relative(IMMUTABLE_DIR, file).split(sep).join('/')}`;
}

/**
 * Every watch and alert channel in the app's DB, as stored (channel config encrypted),
 * read by a child process so this one never holds the DB open (Windows EPERM).
 */
const snapshot = (desktop: DesktopApp) => dbSnapshot(desktop.userData);

const loopbackHost = (desktop: DesktopApp) => `127.0.0.1:${desktop.port}`;

/** A form POST over raw node:http, addressed to the loopback Host, with `origin` if given. */
function rawFormPost(
	desktop: DesktopApp,
	path: string,
	fields: Record<string, string>,
	origin: string | undefined
) {
	const body = new URLSearchParams(fields).toString();
	const headers: Record<string, string> = {
		host: loopbackHost(desktop),
		'content-type': 'application/x-www-form-urlencoded',
		'content-length': String(Buffer.byteLength(body))
	};
	if (origin !== undefined) headers.origin = origin;
	return rawRequest(desktop.port, { method: 'POST', path, headers, body });
}

type ConnectOutcome = 'connected' | 'refused' | 'timeout' | 'error';

/** Opens (and at once closes) a TCP connection to host:port, reporting how it went. */
function tryConnect(host: string, port: number, timeoutMs = 3_000): Promise<ConnectOutcome> {
	return new Promise((done) => {
		const socket = connect({ host, port });
		const finish = (outcome: ConnectOutcome) => {
			socket.destroy();
			done(outcome);
		};
		socket.setTimeout(timeoutMs, () => finish('timeout'));
		socket.once('connect', () => finish('connected'));
		socket.once('error', (error: NodeJS.ErrnoException) =>
			finish(error.code === 'ECONNREFUSED' ? 'refused' : 'error')
		);
	});
}

/** This machine's non-loopback IPv4 addresses. */
function externalIPv4(): string[] {
	return Object.values(networkInterfaces())
		.flat()
		.filter((info) => info !== undefined && info.family === 'IPv4' && !info.internal)
		.map((info) => info!.address)
		.filter((address) => !address.startsWith('127.'));
}

const ntfyCard = (page: Page) => page.getByTestId('channel-ntfy');

test.describe('guard in the app window', () => {
	let desktop: DesktopApp;
	let page: Page;

	test.beforeAll(async () => {
		test.setTimeout(60_000);
		desktop = await launchDesktop();
		page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
	});
	test.afterAll(async () => {
		await desktop?.close();
	});

	test("the window's own form posts reach their actions", async () => {
		// The ntfy save form, through enhance: saved, and the topic shows.
		const alerts = await page.goto(`${desktop.origin}/account/alerts`);
		expect(alerts?.status()).toBe(200);
		await ntfyCard(page).getByLabel('ntfy topic link').fill(TOPIC);
		const [saved] = await Promise.all([
			page.waitForResponse(
				(res) => res.request().method() === 'POST' && res.url().endsWith('/account/alerts?/save')
			),
			ntfyCard(page).getByRole('button', { name: 'Save topic' }).click()
		]);
		expect(saved.status()).toBe(200);
		expect(await saved.request().headerValue('origin')).toBe(desktop.origin);
		await expect(ntfyCard(page).getByRole('status')).toHaveText('Saved.');
		await expect(ntfyCard(page).getByTestId('current-topic').locator('code')).toHaveText(TOPIC);
		const stored = await snapshot(desktop);
		expect(stored.channels.map(({ kind }) => kind)).toEqual(['ntfy']);

		// The add form, submitted natively (form.submit() skips enhance and the required
		// check): the browser's own POST, which the action refuses with 400, not Kit's 403.
		const home = await page.goto(`${desktop.origin}/`);
		expect(home?.status()).toBe(200);
		const addForm = page.locator('form[action="?/add"]');
		await addForm.getByLabel('Product link').fill(UNSUPPORTED_URL);
		const [added] = await Promise.all([
			page.waitForResponse(
				(res) => res.request().method() === 'POST' && res.url().endsWith('/?/add')
			),
			addForm.evaluate((form: HTMLFormElement) => form.submit())
		]);
		expect(added.status()).toBe(400);
		expect(await added.request().headerValue('origin')).toBe(desktop.origin);
		expect(await added.text()).not.toContain(KIT_CSRF);
		await expect(page.getByRole('alert')).toBeVisible();
		expect((await snapshot(desktop)).watches).toEqual([]);
	});

	test('a foreign, wrong-scheme, null or missing Origin gets 403 and changes nothing', async () => {
		const origins: [string, string | undefined][] = [
			['foreign', 'https://evil.example'],
			['wrong scheme', `https://127.0.0.1:${desktop.port}`],
			["'null'", 'null'],
			['none', undefined]
		];
		const posts: [string, Record<string, string>][] = [
			['/account/alerts?/save', { kind: 'ntfy', topic: FORGED_TOPIC }],
			['/?/add', { url: UNSUPPORTED_URL, target: '' }]
		];

		const before = await snapshot(desktop);
		for (const [path, fields] of posts) {
			for (const [what, origin] of origins) {
				const res = await rawFormPost(desktop, path, fields, origin);
				expect(res.status, `${path} ${what}`).toBe(403);
				expect(res.body, `${path} ${what}`).toContain(KIT_CSRF);
			}
		}
		expect(await snapshot(desktop)).toStrictEqual(before);

		// Control: the same raw post with the window's own Origin reaches the action.
		const control = await rawFormPost(
			desktop,
			'/?/add',
			{ url: UNSUPPORTED_URL, target: '' },
			desktop.origin
		);
		expect(control.status).toBe(400);
		expect(control.body).not.toContain(KIT_CSRF);
	});

	test('a non-loopback Host gets 403, immutable assets included', async () => {
		const asset = immutableAssetPath();
		for (const path of [asset, '/health', '/']) {
			const res = await rawRequest(desktop.port, { path, headers: { host: 'evil.example' } });
			expect(res.status, path).toBe(403);
			expect(res.body, path).toBe('Forbidden');
		}

		// Control: the same asset addressed to the loopback Host is served, immutable.
		const served = await rawRequest(desktop.port, {
			path: asset,
			headers: { host: loopbackHost(desktop) }
		});
		expect(served.status).toBe(200);
		expect(String(served.headers['cache-control'])).toMatch(/\bimmutable\b/);
	});

	test('the port answers on 127.0.0.1 only', async () => {
		expect(new URL(page.url()).port).toBe(String(desktop.port));
		// Control: the probe itself connects where the server listens.
		expect(await tryConnect('127.0.0.1', desktop.port)).toBe('connected');

		const addresses = externalIPv4();
		test.skip(addresses.length === 0, 'this host has no non-loopback IPv4 address');
		for (const address of addresses) {
			expect(await tryConnect(address, desktop.port), address).not.toBe('connected');
		}
	});
});

test('two launches on different userData get different ports', async () => {
	let first: DesktopApp | undefined;
	let second: DesktopApp | undefined;
	try {
		first = await launchDesktop();
		second = await launchDesktop();
		expect(second.userData).not.toBe(first.userData);
		expect(second.port).not.toBe(first.port);
		for (const desktop of [first, second]) {
			const health = await rawRequest(desktop.port, {
				path: '/health',
				headers: { host: loopbackHost(desktop) }
			});
			expect(health.status, desktop.origin).toBe(200);
		}
	} finally {
		await first?.close();
		await second?.close();
	}
});
