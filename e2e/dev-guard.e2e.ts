// c-5 under a real `vite dev` (SEC-04): Kit compiles its own CSRF check out of dev,
// so only the server hook (createLocalRequestHandle) stands between a cross-site page
// and the form actions while a developer runs `pnpm dev`. This spec starts `vite dev`
// on its own port and its own seeded database, forges a post to every action, then
// checks that dev still works in a real browser (c-19).
//
// Nothing here can reach a live shop (r-01): the scheduler is off, the watch the
// actions target is in its Check-now cooldown (seeded one day after seeding), the add
// URL is on a .invalid host no adapter claims, and the seeded ntfy topic is .invalid.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { asc } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client.ts';
import { checkFailure, notifyChannel, pricePoint, watch } from '../src/lib/server/db/schema.ts';
import { E2E_ALERTS_KEY, SEEDED_WATCHES } from './accounts.ts';
import { ACTION_ENDPOINTS, actionUrl } from './action-endpoints.ts';
import { CSP_LISTENER, recordCspConsole, type CspRecord } from './desktop/launch.ts';
import { freePort, startDevServer, type NodeServer } from './node-server.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Its seeded lastCheckedAt is in the future, so even an accepted Check now is refused. */
const WATCH = SEEDED_WATCHES.layoutCooldown;
/** Rendered on the watchlist: proof the dev page really loaded its data. */
const LISTED = SEEDED_WATCHES.listPriced;

/** One body for every action, each field one that would change seeded state if accepted. */
const FIELDS = {
	kind: 'ntfy',
	topic: 'https://ntfy.dev-guard.invalid/forged-topic',
	url: 'https://shop.dev-guard.invalid/item/1',
	target: '12.34'
};
const TEXT_BODY = Object.entries(FIELDS)
	.map(([name, value]) => `${name}=${value}`)
	.join('\r\n');

/** The body of the hook's 403. */
const FORBIDDEN = 'Forbidden';

let dir: string;
let dbUrl: string;
let server: NodeServer | undefined;

/** Every row a forged action could change, as stored. */
async function snapshot() {
	const db = createDb(dbUrl);
	try {
		return {
			watches: await db.select().from(watch).orderBy(asc(watch.id)),
			channels: await db.select().from(notifyChannel).orderBy(asc(notifyChannel.kind)),
			points: await db.select().from(pricePoint).orderBy(asc(pricePoint.id)),
			failures: await db.select().from(checkFailure).orderBy(asc(checkFailure.id))
		};
	} finally {
		db.$client.close();
	}
}

/** The forged posts: a foreign Origin in each form encoding, Origin 'null', no Origin. */
function forgeries(request: APIRequestContext, url: string): [string, Promise<APIResponse>][] {
	const evil = { origin: 'https://evil.example' };
	return [
		['evil urlencoded', request.post(url, { headers: evil, form: FIELDS, maxRedirects: 0 })],
		['evil multipart', request.post(url, { headers: evil, multipart: FIELDS, maxRedirects: 0 })],
		[
			'evil text/plain',
			request.post(url, {
				headers: { ...evil, 'content-type': 'text/plain' },
				data: TEXT_BODY,
				maxRedirects: 0
			})
		],
		[
			"Origin 'null'",
			request.post(url, { headers: { origin: 'null' }, form: FIELDS, maxRedirects: 0 })
		],
		['no Origin', request.post(url, { form: FIELDS, maxRedirects: 0 })]
	];
}

test.describe('vite dev guard', () => {
	test.beforeAll(async () => {
		test.setTimeout(180_000);
		dir = mkdtempSync(join(tmpdir(), 'dev-guard-'));
		const dbFile = join(dir, 'dev.db');
		dbUrl = `file:${dbFile}`;
		const seeded = spawnSync(process.execPath, ['e2e/seed.ts'], {
			cwd: REPO_ROOT,
			env: { ...process.env, DATABASE_URL: dbUrl },
			encoding: 'utf8'
		});
		expect(seeded.status, `${seeded.stdout}\n${seeded.stderr}`).toBe(0);
		// The shared seed's product images sit on .invalid hosts (r-01), which img-src
		// blocks as it should; this copy drops them so 'dev runs under the CSP' can
		// demand zero violations from dev itself.
		const db = createDb(dbUrl);
		try {
			await db.update(watch).set({ imageUrl: null });
		} finally {
			db.$client.close();
		}
		server = await startDevServer({
			port: await freePort(),
			dbFile,
			env: { ALERTS_ENCRYPTION_KEY: E2E_ALERTS_KEY }
		});
	});

	test.afterAll(async () => {
		await server?.stop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test('every action refuses a forged Origin under vite dev', async ({ request }) => {
		test.setTimeout(120_000);
		const before = await snapshot();
		expect(before.watches.map(({ id }) => id)).toContain(WATCH.id);
		expect(before.channels.map(({ kind }) => kind)).toContain('ntfy');

		for (const endpoint of ACTION_ENDPOINTS) {
			const url = `${server!.url}${actionUrl(endpoint, { id: WATCH.id })}`;
			for (const [what, sent] of forgeries(request, url)) {
				const res = await sent;
				expect(res.status(), `${url} ${what}`).toBe(403);
				expect(await res.text(), `${url} ${what}`).toBe(FORBIDDEN);
			}
		}
		expect(await snapshot()).toStrictEqual(before);
	});

	test('dev still works in a browser', async ({ page }) => {
		test.setTimeout(120_000);
		// The first visit may make Vite optimise dependencies and reload; settle first.
		await page.goto(`${server!.url}/`);
		await page.waitForLoadState('networkidle');

		const home = await page.goto(`${server!.url}/`);
		expect(home?.status()).toBe(200);
		await expect(page.getByText(LISTED.title).first()).toBeVisible();
		expect(home?.headers()['x-frame-options']).toBe('DENY');

		// The page's own add form, submitted natively (form.submit() skips enhance and
		// the required check): the browser's own same-origin POST reaches the action,
		// which refuses the unsupported URL with 400 before any fetch.
		const addForm = page.locator('form[action="?/add"]');
		await addForm.getByLabel('Product link').fill(FIELDS.url);
		const [added] = await Promise.all([
			page.waitForResponse(
				(res) => res.request().method() === 'POST' && res.url().endsWith('/?/add')
			),
			addForm.evaluate((form: HTMLFormElement) => form.submit())
		]);
		expect(await added.request().headerValue('origin')).toBe(server!.url);
		expect(added.status()).toBe(400);
		expect(await added.text()).not.toBe(FORBIDDEN);
	});

	// c-23 + c-19: the CSP from kit.csp applies under `vite dev` too, and dev still
	// works under it: both pages load and hydrate, Vite's HMR websocket connects, and
	// an enhanced form saves, with no CSP violation anywhere.
	test('dev runs under the CSP', async ({ page }) => {
		test.setTimeout(120_000);
		const csp: CspRecord = { violations: [], native: [] };
		await page.addInitScript({ content: CSP_LISTENER });
		recordCspConsole(page, csp);
		const hmr: string[] = [];
		page.on('websocket', (socket) => hmr.push(socket.url()));

		// The first visit may make Vite optimise dependencies and reload; settle first.
		await page.goto(`${server!.url}/`);
		await page.waitForLoadState('networkidle');

		for (const path of ['/', '/account/alerts']) {
			const res = await page.goto(`${server!.url}${path}`);
			expect(res?.status(), path).toBe(200);
			expect(res?.headers()['content-security-policy'], path).toContain("frame-ancestors 'none'");
			// vite dev serves the client as many modules: once they have all loaded the
			// page has hydrated, so a click below goes through enhance, not a native post.
			await page.waitForLoadState('networkidle');
		}

		// Hydrated: an enhanced save goes out as a SvelteKit action request and the
		// result shows in place. Same origin as the seeded topic, so its token stays.
		const card = page.getByTestId('channel-ntfy');
		await card.getByLabel('ntfy topic link').fill('https://ntfy.e2e.invalid/dev-guard-topic');
		const [saved] = await Promise.all([
			page.waitForResponse(
				(res) => res.request().method() === 'POST' && res.url().endsWith('/account/alerts?/save')
			),
			card.getByRole('button', { name: 'Save topic' }).click()
		]);
		expect(await saved.request().headerValue('x-sveltekit-action')).toBe('true');
		expect(saved.status()).toBe(200);
		await expect(card.getByRole('status')).toHaveText('Saved.');

		// The watchlist hydrates too: its add form posts through enhance.
		await page.goto(`${server!.url}/`);
		await page.waitForLoadState('networkidle');
		const addForm = page.locator('form[action="?/add"]');
		await addForm.getByLabel('Product link').fill(FIELDS.url);
		const [added] = await Promise.all([
			page.waitForResponse(
				(res) => res.request().method() === 'POST' && res.url().endsWith('/?/add')
			),
			addForm.getByRole('button', { name: 'Add to watchlist' }).click()
		]);
		expect(await added.request().headerValue('x-sveltekit-action')).toBe('true');
		await expect(page.getByRole('alert')).toBeVisible();

		// Vite's HMR client connected over its websocket, and nothing was blocked.
		await expect.poll(() => hmr.length, { timeout: 10_000 }).toBeGreaterThan(0);
		await page.waitForTimeout(500);
		expect(csp.violations).toEqual([]);
		expect(csp.native).toEqual([]);
	});
});
