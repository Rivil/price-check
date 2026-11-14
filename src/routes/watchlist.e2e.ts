import { expect, test, type Page } from '@playwright/test';
import { SEEDED_WATCHES } from '../../e2e/accounts.ts';

// Every URL submitted here is rejected before any request (unsupported host, or
// a bad target checked first), so these tests never reach amazon.co.uk (r-01).

const {
	listPriced,
	listFailed,
	pageDelete,
	failedPriced,
	cardFresh,
	cardOverdue,
	cardInGrace,
	cardStale
} = SEEDED_WATCHES;

function watchItem(page: Page, id: string) {
	return page.locator(`li[data-watch-id="${id}"]`);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/');
});

test('opens without login', async ({ page }) => {
	// Loaded straight, not via beforeEach: no login screen, no redirect (c-1).
	const response = await page.goto('/');
	expect(response?.status()).toBe(200);
	expect(response?.request().redirectedFrom()).toBeNull();
	await expect(page.getByRole('heading', { level: 1, name: 'Watchlist' })).toBeVisible();

	// The one install's whole seed, on one list. watch-page.e2e 'delete' may already
	// have removed its own watch.
	for (const seeded of Object.values(SEEDED_WATCHES)) {
		if (seeded.id === pageDelete.id) continue;
		const label = seeded.title ?? `https://www.amazon.co.uk/dp/${seeded.productId}`;
		await expect(watchItem(page, seeded.id).getByText(label, { exact: true })).toBeVisible();
	}
});

test('list', async ({ page }) => {
	const item = watchItem(page, listPriced.id);

	await expect(item.getByText(listPriced.title)).toBeVisible();
	await expect(item.getByText('Now £1,299.00')).toBeVisible();
	await expect(item.getByText('Target £999.00')).toBeVisible();
	await expect(item.getByRole('img', { name: listPriced.title })).toHaveAttribute(
		'src',
		listPriced.imageUrl
	);
});

test('failed watch', async ({ page }) => {
	const item = watchItem(page, listFailed.id);

	// Untitled until a check succeeds: labelled by its canonical URL.
	await expect(
		item.getByText(`https://www.amazon.co.uk/dp/${listFailed.productId}`, { exact: true })
	).toBeVisible();
	await expect(item.getByText('Last check failed: Blocked by Amazon')).toBeVisible();
	await expect(item.getByText('1 Nov 2026, 09:45')).toBeVisible();
	await expect(item.getByText(/Now £/)).toHaveCount(0);
	await expect(item.getByRole('img')).toHaveCount(0);
});

test('failure keeps price', async ({ page }) => {
	const item = watchItem(page, failedPriced.id);

	await expect(item.getByText("Last check failed: Couldn't reach Amazon")).toBeVisible();
	await expect(item.getByText('Last known £45.00')).toBeVisible();
	await expect(item.getByText(/Now £/)).toHaveCount(0);
});

test('card sparkline', async ({ page }) => {
	const item = watchItem(page, cardFresh.id);

	// Exact, so a name carrying the product title fails too.
	await expect(
		item.getByRole('img', {
			name: '30-day prices, lowest £18.00, highest £20.00',
			exact: true
		})
	).toBeVisible();
	await expect(item.locator('.sparkline .line')).toHaveAttribute('d', /^M.+L/);
});

test('card overdue', async ({ page }) => {
	await expect(watchItem(page, cardOverdue.id).locator('.status')).toContainText('overdue');
	await expect(watchItem(page, cardInGrace.id).locator('.status')).toContainText('next check due');
	await expect(watchItem(page, cardInGrace.id).locator('.status')).not.toContainText('overdue');
	await expect(watchItem(page, cardFresh.id).locator('.status')).toContainText('next check due');
	await expect(watchItem(page, cardFresh.id).locator('.status')).not.toContainText('overdue');
});

test('card failure', async ({ page }) => {
	await expect(watchItem(page, listFailed.id).locator('.failure')).toContainText(
		/^Last check failed: Blocked by Amazon · Checked .+ · next check .*due/
	);
});

test('card no success', async ({ page }) => {
	const failed = watchItem(page, listFailed.id);
	await expect(failed.getByRole('img')).toHaveCount(0);
	await expect(failed.getByText('No successful check yet')).toBeVisible();

	const stale = watchItem(page, cardStale.id);
	await expect(stale.getByRole('img')).toHaveCount(0);
	await expect(stale.getByText('No recent prices')).toBeVisible();
});

test('unsupported', async ({ page }) => {
	const url = 'https://www.amazon.com/dp/B000000000';

	await page.getByLabel('Product link').fill(url);
	await page.getByRole('button', { name: 'Add to watchlist' }).click();

	await expect(page.getByRole('alert')).toHaveText('unsupported URL');
	await expect(page.getByLabel('Product link')).toHaveValue(url);
	// Nothing stored: no listed watch carries the submitted product.
	await expect(page.locator('li[data-watch-id]', { hasText: 'B000000000' })).toHaveCount(0);
});

test('bad target', async ({ page }) => {
	const url = 'https://www.amazon.com/dp/B000000000';

	await page.getByLabel('Product link').fill(url);
	await page.getByLabel('Target price (£, optional)').fill('24.999');
	await page.getByRole('button', { name: 'Add to watchlist' }).click();

	// The target's own message, not the URL's: the target is checked first.
	await expect(page.getByRole('alert')).toHaveText('Enter a price in pounds, like 24.99');
	await expect(page.getByLabel('Product link')).toHaveValue(url);
	await expect(page.getByLabel('Target price (£, optional)')).toHaveValue('24.999');
});
