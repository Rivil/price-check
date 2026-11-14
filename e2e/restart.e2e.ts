import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createDb } from '../src/lib/server/db/client.ts';
import { pricePoint, watch } from '../src/lib/server/db/schema.ts';
import { removeTempDir } from '../src/lib/server/testing/temp-dir.ts';
import { E2E_ALERTS_KEY } from './accounts.ts';
import { freePort, startNodeServer } from './node-server.ts';

// c-5 on the built server (`node build`): what one run stores survives a restart
// on the same database file. Server A saves an ntfy channel through its own form
// action; the watch and its history are inserted straight into the file, because
// adding through the UI would fetch Amazon live (r-01). Server B, a new process on
// the same file, must show all of it. Both run with SCHEDULER_DISABLED=1 (set by
// node-server.ts) so neither re-checks the watch.

/** A test-only topic on a .invalid host (r-01): saving it never sends anything. */
const TOPIC = 'https://ntfy.e2e.invalid/e2e-restart-topic';

const WATCH = {
	id: 'e2e-restart-watch',
	shop: 'amazon-uk',
	productId: 'B0E2ERSTR1',
	canonicalUrl: 'https://www.amazon.co.uk/dp/B0E2ERSTR1',
	title: 'E2E Restart Kettle',
	imageUrl: null,
	pricePence: 1999,
	targetPence: null,
	lastCheckReason: null,
	lastCheckMessage: null
};

/**
 * Two checks, oldest first: £24.99 then £21.99. Neither is the watch's own price
 * (£19.99), so a lost point cannot pass on the price the page shows anyway.
 */
const POINTS = [
	{ id: 'e2e-restart-pt-1', pricePence: 2499, hoursAgo: 30, shown: '£24.99' },
	{ id: 'e2e-restart-pt-2', pricePence: 2199, hoursAgo: 1, shown: '£21.99' }
];

let dir: string;

test.beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'restart-'));
});

// This process opened the file to seed it, and on Windows libsql keeps it locked
// after close(), so cleanup there is best-effort (see temp-dir.ts).
test.afterEach(() => {
	removeTempDir(dir);
});

test('data survives a restart on the same database', async ({ page }) => {
	const dbFile = join(dir, 'restart.db');
	const env = { ALERTS_ENCRYPTION_KEY: E2E_ALERTS_KEY };

	const portA = await freePort();
	const originA = `http://127.0.0.1:${portA}`;
	// adapter-node 6 ignores ORIGIN at runtime (its origin is the build-time
	// paths.origin) and, with none, takes the self origin to be https://<Host>, so
	// Kit's CSRF check refuses a same-origin http form POST. PROTOCOL_HEADER is its
	// runtime way to learn the scheme: with it the self origin is originA, which this
	// POST's Origin matches.
	const serverA = await startNodeServer({
		port: portA,
		dbFile,
		env: { ...env, ORIGIN: originA, PROTOCOL_HEADER: 'x-forwarded-proto' }
	});
	try {
		const save = await fetch(`${originA}/account/alerts?/save`, {
			method: 'POST',
			headers: { origin: originA, 'x-forwarded-proto': 'http' },
			body: new URLSearchParams({ kind: 'ntfy', topic: TOPIC, price_drops: 'on' }),
			redirect: 'manual'
		});
		await save.body?.cancel();
		// 400 would be a refused topic, 403 a CSRF rejection.
		expect(save.status, 'save').toBe(200);

		// Server A has migrated the file; the watch and its history go in beside it.
		const db = createDb(`file:${dbFile}`);
		try {
			await db.insert(watch).values({
				...WATCH,
				lastCheckedAt: new Date(Date.now() - POINTS[1].hoursAgo * 60 * 60 * 1000)
			});
			await db.insert(pricePoint).values(
				POINTS.map(({ id, pricePence, hoursAgo }) => ({
					id,
					watchId: WATCH.id,
					pricePence,
					checkedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
				}))
			);
		} finally {
			db.$client.close();
		}
	} finally {
		await serverA.stop();
	}

	// A new process on the same file; stop() resolved only once A had exited.
	const serverB = await startNodeServer({ port: await freePort(), dbFile, env });
	try {
		const get = async (path: string) => {
			const res = await fetch(`${serverB.url}${path}`, { redirect: 'manual' });
			const html = await res.text();
			expect(res.status, path).toBe(200);
			return html;
		};

		const list = await get('/');
		expect(list).toContain(WATCH.title);
		expect(list).toContain(`/watches/${WATCH.id}`);

		const detail = await get(`/watches/${WATCH.id}`);
		for (const point of POINTS) expect(detail, point.id).toContain(point.shown);
		// One history row per point, each with its own price.
		await page.goto(`${serverB.url}/watches/${WATCH.id}`);
		const rows = page.locator('table tbody tr');
		await expect(rows).toHaveCount(POINTS.length);
		for (const point of POINTS) {
			await expect(rows.filter({ hasText: point.shown }), point.id).toHaveCount(1);
		}

		// The topic was stored encrypted; B decrypts it with the same key. Read through
		// the rendered page, not the raw HTML: Svelte adds attributes to <code>.
		const alerts = await page.goto(`${serverB.url}/account/alerts`);
		expect(alerts?.status(), '/account/alerts').toBe(200);
		await expect(page.getByTestId('current-topic').locator('code')).toHaveText(TOPIC);
	} finally {
		await serverB.stop();
	}
});
