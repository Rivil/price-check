import { expect, test, type Page } from '@playwright/test';
import { asc, eq } from 'drizzle-orm';
import { createDb } from '../../../lib/server/db/client.ts';
import { checkFailure, watch } from '../../../lib/server/db/schema.ts';
import { formatCheckedAt } from '../../../lib/watch-view.ts';
import {
	E2E_DATABASE_URL,
	E2E_ORIGIN,
	SEEDED_MEMBER,
	SEEDED_WATCHES,
	signIn
} from '../../../../e2e/accounts.ts';

// Only watches seeded for this file are edited or deleted here (see SEEDED_WATCHES).
const {
	pageDetail,
	pageFailed,
	pageEdit,
	pageDelete,
	otherPriced,
	failedPriced,
	pageCooldown,
	chartFull,
	chartNoTarget
} = SEEDED_WATCHES;

/** Seven points and four failures, the latest stamped at seeding. */
const CHART_FULL_MARKS = 11;
/** Those inside 30 days: three points and three failures. */
const CHART_FULL_30_DAY_MARKS = 6;

async function storedWatch(id: string) {
	const db = createDb(E2E_DATABASE_URL);
	try {
		const [row] = await db.select().from(watch).where(eq(watch.id, id));
		return row ?? null;
	} finally {
		db.$client.close();
	}
}

async function storedFailures(watchId: string) {
	const db = createDb(E2E_DATABASE_URL);
	try {
		return await db
			.select()
			.from(checkFailure)
			.where(eq(checkFailure.watchId, watchId))
			.orderBy(asc(checkFailure.checkedAt));
	} finally {
		db.$client.close();
	}
}

const marks = (page: Page) => page.locator('.chart .mark');
const timelineRows = (page: Page) => page.locator('table tbody tr');

/** The <dd> following the <dt> with this label. */
function field(page: import('@playwright/test').Page, label: string) {
	return page.locator(`dt:text-is("${label}") + dd`);
}

test.beforeEach(async ({ page }) => {
	await signIn(page, SEEDED_MEMBER);
});

test('details', async ({ page }) => {
	// Reached from the watchlist.
	await page.getByRole('link', { name: pageDetail.title }).click();
	await page.waitForURL(`/watches/${pageDetail.id}`);

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(pageDetail.title);
	await expect(page.getByRole('img', { name: pageDetail.title })).toHaveAttribute(
		'src',
		pageDetail.imageUrl
	);
	await expect(field(page, 'Current price')).toHaveText('£89.99');
	await expect(field(page, 'Target price')).toHaveText('£75.00');
	await expect(field(page, 'Last checked')).toHaveText('1 Nov 2026, 12:00');
	await expect(page.locator('dt', { hasText: 'Last check failed' })).toHaveCount(0);
});

test('failure details', async ({ page }) => {
	await page.goto(`/watches/${pageFailed.id}`);

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		`https://www.amazon.co.uk/dp/${pageFailed.productId}`
	);
	await expect(field(page, 'Last check failed')).toHaveText(
		'Currently unavailable — Currently unavailable on amazon.co.uk'
	);
	await expect(field(page, 'Last checked')).toHaveText('1 Nov 2026, 12:15');
	await expect(field(page, 'Last known price')).toHaveText('Not known yet');
});

test('history', async ({ page }) => {
	await page.goto(`/watches/${pageDetail.id}`);

	const rows = page.locator('table tbody tr');
	await expect(rows).toHaveText([
		/1 Nov 2026, 12:00\s*£89\.99/,
		/31 Oct 2026, 21:00\s*£94\.99/,
		/31 Oct 2026, 09:00\s*£99\.99/
	]);
});

test('no success', async ({ page }) => {
	await page.goto(`/watches/${pageFailed.id}`);

	await expect(page.getByText("No successful check yet, so there's no chart")).toBeVisible();
	await expect(page.locator('.chart')).toHaveCount(0);
	await expect(page.locator('.stats')).toHaveCount(0);
	await expect(timelineRows(page)).toHaveText([
		/Failed: Currently unavailable — Currently unavailable on amazon\.co\.uk/
	]);
});

test('chart marks', async ({ page }) => {
	await page.goto(`/watches/${chartFull.id}`);

	await expect(marks(page)).toHaveCount(CHART_FULL_MARKS);
});

test('target line', async ({ page }) => {
	await page.goto(`/watches/${chartFull.id}`);
	await expect(page.locator('.chart .lines .target')).toHaveCount(1);

	await page.goto(`/watches/${chartNoTarget.id}`);
	await expect(page.locator('.chart .lines .line')).toHaveCount(1);
	await expect(page.locator('.chart .lines .target')).toHaveCount(0);
});

test('failure rows', async ({ page }) => {
	await page.goto(`/watches/${chartFull.id}`);

	// Oldest first: the 95-day failure, the consecutive pair, the failure at seeding.
	const [, blocked, unavailable] = await storedFailures(chartFull.id);
	const at = ({ checkedAt }: { checkedAt: Date }) => formatCheckedAt(checkedAt);

	const rows = timelineRows(page);
	await expect(rows.nth(1)).toContainText('£109.99');
	await expect(rows.nth(2).locator('td')).toHaveText([
		at(unavailable),
		'Failed: Currently unavailable'
	]);
	await expect(rows.nth(3).locator('td')).toHaveText([
		at(blocked),
		'Failed: Blocked by Amazon — Amazon showed a captcha page'
	]);
	await expect(rows.nth(4)).toContainText('£115.00');
});

test('stats', async ({ page }) => {
	await page.goto(`/watches/${pageDetail.id}`);

	await expect(field(page, 'Lowest ever')).toHaveText('£89.99');
	await expect(field(page, 'Highest ever')).toHaveText('£99.99');
	await expect(field(page, 'Average')).toHaveText('£94.99');
	await expect(field(page, 'Change since added')).toHaveText('-10.0%');
});

test('range leaves the rest', async ({ page }) => {
	await page.goto(`/watches/${chartFull.id}`);
	const stats = await page.locator('.stats').innerText();
	const rows = await timelineRows(page).count();

	const documents: string[] = [];
	page.on('request', (request) => {
		if (request.resourceType() === 'document') documents.push(request.url());
	});

	const thirtyDays = page.getByRole('button', { name: '30 days' });
	// A click before hydration does nothing, and there's no signal to wait on.
	await expect(async () => {
		await thirtyDays.click();
		await expect(thirtyDays).toHaveAttribute('aria-pressed', 'true', { timeout: 200 });
	}).toPass();

	await expect(marks(page)).toHaveCount(CHART_FULL_30_DAY_MARKS);
	await expect(page.locator('.stats')).toHaveText(stats);
	await expect(timelineRows(page)).toHaveCount(rows);
	expect(documents).toEqual([]);

	await page.reload();
	await expect(page.getByRole('button', { name: 'All time' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(marks(page)).toHaveCount(CHART_FULL_MARKS);
});

test('table carries it all', async ({ page }) => {
	await page.goto(`/watches/${chartFull.id}`);

	await expect(marks(page)).toHaveCount(CHART_FULL_MARKS);
	await expect(timelineRows(page)).toHaveCount(CHART_FULL_MARKS);
});

test('tooltip keyboard', async ({ page }) => {
	await page.goto(`/watches/${chartFull.id}`);

	const tooltip = page.getByRole('tooltip');
	await expect(async () => {
		await page.getByRole('button', { name: 'All time' }).focus();
		await page.keyboard.press('Tab');
		await expect(tooltip).toContainText('Failed: Blocked by Amazon', { timeout: 200 });
	}).toPass();

	await page.keyboard.press('ArrowLeft');
	await expect(tooltip).toContainText('£109.99');
});

test('failure keeps price', async ({ page }) => {
	await page.goto(`/watches/${failedPriced.id}`);

	await expect(field(page, 'Last known price')).toHaveText('£45.00');
	await expect(field(page, 'Last check failed')).toHaveText(
		"Couldn't reach Amazon — request timed out after 15000ms"
	);
	await expect(field(page, 'Last checked')).toHaveText('1 Nov 2026, 13:00');
});

test('check now cooldown', async ({ page }) => {
	// Seeded as checked one day after seeding: always inside the cooldown, so this
	// click can never run a live check (r-01).
	await page.goto(`/watches/${pageCooldown.id}`);

	await page.getByRole('button', { name: 'Check now' }).click();

	await expect(page.getByRole('alert')).toHaveText(
		'Checked less than 15 minutes ago — try again later'
	);
	await expect(field(page, 'Current price')).toHaveText('£30.00');
});

test('edit target', async ({ page }) => {
	const target = page.getByLabel('New target (£, leave empty to clear)');
	const save = page.getByRole('button', { name: 'Save target' });
	await page.goto(`/watches/${pageEdit.id}`);
	await expect(field(page, 'Target price')).toHaveText('£20.00');

	await target.fill('19.99');
	await save.click();
	await expect(page.getByRole('status')).toHaveText('Target saved.');
	await page.reload();
	await expect(field(page, 'Target price')).toHaveText('£19.99');

	// An invalid target is refused and changes nothing.
	await target.fill('24.999');
	await save.click();
	await expect(page.getByRole('alert')).toHaveText('Enter a price in pounds, like 24.99');
	await page.reload();
	await expect(field(page, 'Target price')).toHaveText('£19.99');

	await target.fill('');
	await save.click();
	await expect(page.getByRole('status')).toHaveText('Target saved.');
	await page.reload();
	await expect(field(page, 'Target price')).toHaveText('No target');
	expect((await storedWatch(pageEdit.id))?.targetPence).toBeNull();
});

test('delete', async ({ page }) => {
	await page.goto(`/watches/${pageDelete.id}`);

	await page.getByRole('button', { name: 'Delete this watch' }).click();
	await page.waitForURL('/');

	await expect(page.locator(`li[data-watch-id="${pageDelete.id}"]`)).toHaveCount(0);
	const gone = await page.goto(`/watches/${pageDelete.id}`);
	expect(gone?.status()).toBe(404);
	expect(await storedWatch(pageDelete.id)).toBeNull();
});

test('not yours', async ({ page }) => {
	const before = await storedWatch(otherPriced.id);
	expect(before).not.toBeNull();

	const view = await page.goto(`/watches/${otherPriced.id}`);
	expect(view?.status()).toBe(404);
	await expect(page.getByText(otherPriced.title)).toHaveCount(0);

	// The member's own session, posting straight at the other user's actions.
	const headers = { origin: E2E_ORIGIN };
	const edit = await page.request.post(`/watches/${otherPriced.id}?/target`, {
		form: { target: '1' },
		headers
	});
	expect(edit.status()).toBe(404);
	const del = await page.request.post(`/watches/${otherPriced.id}?/delete`, { form: {}, headers });
	expect(del.status()).toBe(404);

	expect(await storedWatch(otherPriced.id)).toEqual(before);
});
