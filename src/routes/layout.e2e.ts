import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoOverflow } from '../../e2e/a11y.ts';
import { SEEDED_DESIGN_TOPIC_URL, SEEDED_WATCHES } from '../../e2e/accounts.ts';

// Read-only: pages are only loaded and measured. Seeded image hosts are .invalid
// and every request to one is aborted, so nothing reaches Amazon (r-01).

const PHONE = { width: 375, height: 800 };
const { layoutLong, chartFull } = SEEDED_WATCHES;

async function open(
	browser: Browser,
	viewport = PHONE
): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext({ viewport });
	await context.route(
		(url) => url.hostname.endsWith('.invalid'),
		(route) => route.abort()
	);
	const page = await context.newPage();
	return { page, close: () => context.close() };
}

/** Nothing is hidden to fake a fit, and every header and footer control is inside the viewport. */
async function expectNoClipping(page: Page) {
	const clipped = await page.evaluate(() =>
		['html', 'body', 'main']
			.map((sel) => document.querySelector(sel))
			.filter((el): el is Element => el !== null)
			.flatMap((el) => {
				const { overflowX } = getComputedStyle(el);
				return overflowX === 'hidden' || overflowX === 'clip'
					? [`${el.tagName.toLowerCase()} overflow-x: ${overflowX}`]
					: [];
			})
	);
	expect(clipped, 'overflow hidden to fake a fit').toEqual([]);

	const outside = await page.evaluate(() => {
		const width = document.documentElement.clientWidth;
		return [...document.querySelectorAll('header a, header button, footer a')].flatMap((el) => {
			const box = el.getBoundingClientRect();
			return box.left < 0 || box.right > width + 0.5
				? [`${el.textContent?.trim()} at ${box.left}..${box.right}`]
				: [];
		});
	});
	expect(outside, 'header or footer control outside the viewport').toEqual([]);
}

async function check375(page: Page, path: string) {
	await page.goto(path);
	await expectNoOverflow(page);
	await expectNoClipping(page);
}

test('no sideways scroll /', async ({ browser }) => {
	const { page, close } = await open(browser);
	try {
		await page.goto('/');
		// Not vacuous: the 240-char unbroken title is on the page.
		await expect(page.getByRole('link', { name: layoutLong.title })).toBeVisible();
		await check375(page, '/');
	} finally {
		await close();
	}
});

test('no sideways scroll /watches/:id', async ({ browser }) => {
	const { page, close } = await open(browser);
	try {
		await page.goto(`/watches/${layoutLong.id}`);
		// Scoped: the history timeline repeats the message.
		await expect(page.locator('dd.failure').getByText(layoutLong.lastCheckMessage)).toBeVisible();
		await check375(page, `/watches/${layoutLong.id}`);
	} finally {
		await close();
	}
});

test('no sideways scroll tooltip', async ({ browser }) => {
	const { page, close } = await open(browser);
	try {
		await page.goto(`/watches/${chartFull.id}`);
		const tooltip = page.getByRole('tooltip');
		const marks = page.locator('.chart .mark');
		await expect(marks).toHaveCount(11);

		// The left edge, then the latest mark on the right with its long unbroken reason.
		for (const [mark, text] of [
			[marks.first(), '£150.00'],
			[marks.last(), chartFull.lastCheckMessage]
		] as const) {
			// Focus does nothing until hydration, and there's no signal to wait on. The blur
			// matters: focusing the element that already has focus fires no event.
			await expect(async () => {
				await mark.blur();
				await mark.focus();
				await expect(tooltip).toContainText(text, { timeout: 200 });
			}).toPass();

			await tooltip.scrollIntoViewIfNeeded();
			const box = await tooltip.boundingBox();
			// Font metrics differ per OS, so edges land on fractional pixels while scrolling
			// snaps to whole ones (Linux CI: bottom at 800.19 of 800). Allow under 1px.
			const SUBPIXEL = 1;
			expect(box!.x, 'tooltip left of the viewport').toBeGreaterThanOrEqual(-SUBPIXEL);
			expect(box!.x + box!.width, 'tooltip right of the viewport').toBeLessThanOrEqual(
				PHONE.width + SUBPIXEL
			);
			expect(box!.y, 'tooltip above the viewport').toBeGreaterThanOrEqual(-SUBPIXEL);
			expect(box!.y + box!.height, 'tooltip below the viewport').toBeLessThanOrEqual(
				PHONE.height + SUBPIXEL
			);
			await expectNoOverflow(page);
		}
	} finally {
		await close();
	}
});

test('image fits', async ({ browser }) => {
	const { page, close } = await open(browser);
	try {
		await page.goto(`/watches/${layoutLong.id}`);
		const img = page.getByRole('img', { name: layoutLong.title });
		await expect(img).toHaveCount(1);
		const fit = await img.evaluate((el) => {
			const container = el.parentElement!.getBoundingClientRect().width;
			return {
				maxWidth: getComputedStyle(el).maxWidth,
				width: el.getBoundingClientRect().width,
				container
			};
		});
		expect(fit.maxWidth).toBe('100%');
		expect(fit.width).toBeLessThanOrEqual(fit.container + 0.5);
	} finally {
		await close();
	}
});

test('375 alerts', async ({ browser }) => {
	const { page, close } = await open(browser);
	try {
		await page.goto('/account/alerts');
		// Fails as vacuous if another spec replaced the long seeded topic.
		const topic = (await page.locator('code').first().textContent()) ?? '';
		expect(topic.length, 'alerts topic is the long seeded one').toBeGreaterThanOrEqual(140);
		expect(topic).toBe(SEEDED_DESIGN_TOPIC_URL);
		await check375(page, '/account/alerts');
	} finally {
		await close();
	}
});

test('no sideways scroll 404', async ({ browser }) => {
	const { page, close } = await open(browser);
	try {
		const response = await page.goto('/no-such-page');
		expect(response?.status()).toBe(404);
		// Not vacuous: the 404 page renders inside the layout, header and footer included.
		await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Source', exact: true })).toBeVisible();
		await check375(page, '/no-such-page');
	} finally {
		await close();
	}
});

test('column', async ({ browser }) => {
	const { page, close } = await open(browser, { width: 1280, height: 800 });
	try {
		await page.goto('/');
		const m = await page.locator('main').evaluate((el) => {
			const box = el.getBoundingClientRect();
			const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
			return {
				left: box.left,
				right: document.documentElement.clientWidth - box.right,
				width: box.width,
				max: 44 * rem
			};
		});
		expect(m.width).toBeLessThanOrEqual(m.max + 0.5);
		expect(m.width).toBeGreaterThan(m.max - 1);
		expect(Math.abs(m.left - m.right)).toBeLessThanOrEqual(1);
	} finally {
		await close();
	}
});
