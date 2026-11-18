import {
	expect,
	test,
	type Browser,
	type BrowserContextOptions,
	type Page
} from '@playwright/test';
import { expectStructure, type Scheme } from '../../e2e/a11y.ts';
import { SEEDED_WATCHES } from '../../e2e/accounts.ts';

// What component tests can't see, on the seeded watches. Nothing here clicks Check
// now, *.invalid requests are aborted, and 'no live fetch' holds every request to
// localhost or *.invalid (r-01).

const { chartFull, chartDense } = SEEDED_WATCHES;
const PHONE = { width: 375, height: 800 };
const TIME = String.raw`\d{1,2} \w+ \d{4}, \d{2}:\d{2}`;

/** A page in a fresh context with `options`. */
async function withPage(
	browser: Browser,
	options: BrowserContextOptions,
	run: (page: Page) => Promise<void>
) {
	const context = await browser.newContext(options);
	await context.route(
		(url) => url.hostname.endsWith('.invalid'),
		(route) => route.abort()
	);
	try {
		await run(await context.newPage());
	} finally {
		await context.close();
	}
}

/** Taps a viewport point until the tooltip opens: taps before hydration do nothing. */
async function tapUntilTooltip(page: Page, x: number, y: number) {
	const tooltip = page.getByRole('tooltip');
	await expect(async () => {
		await page.touchscreen.tap(x, y);
		await expect(tooltip).toBeVisible({ timeout: 200 });
	}).toPass();
	return tooltip;
}

/** Focuses the first mark and waits for its tooltip, which also proves hydration. */
async function openTooltip(page: Page) {
	const mark = page.locator('.chart .mark').first();
	await expect(async () => {
		// Focusing the element that already has focus fires no event.
		await mark.blur();
		await mark.focus();
		await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 200 });
	}).toPass();
}

for (const colorScheme of ['light', 'dark'] as Scheme[]) {
	test(`chart structure ${colorScheme}`, async ({ browser }) => {
		await withPage(browser, { colorScheme }, async (page) => {
			await page.goto(`/watches/${chartFull.id}`);
			await openTooltip(page);
			await expectStructure(page);

			await page.goto('/');
			await expect(page.locator('.sparkline').first()).toBeVisible();
			await expectStructure(page);
		});
	});
}

test('touch tooltip', async ({ browser }) => {
	await withPage(browser, { hasTouch: true, viewport: PHONE }, async (page) => {
		await page.goto(`/watches/${chartFull.id}`);
		await page.locator('.chart .plot').scrollIntoViewIfNeeded();

		// The 95-day failure, with no other mark near it.
		const mark = page.locator('.chart .mark.failed').first();
		await expect(mark).toHaveAccessibleName(/^Failed: Couldn't reach Amazon/);
		const box = (await mark.boundingBox())!;
		const tooltip = await tapUntilTooltip(page, box.x + box.width / 2, box.y + box.height / 2);

		await expect(tooltip).toHaveText(
			new RegExp(`^Failed: Couldn't reach Amazon — request timed out after 15000ms · ${TIME}$`)
		);
	});
});

test('dense tap', async ({ browser }) => {
	await withPage(browser, { hasTouch: true, viewport: PHONE }, async (page) => {
		await page.goto(`/watches/${chartDense.id}`);
		const plot = page.locator('.chart .plot');
		await plot.scrollIntoViewIfNeeded();
		const box = (await plot.boundingBox())!;
		const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];

		const tooltip = await tapUntilTooltip(page, x, y);

		await expect(tooltip).toHaveText(new RegExp(`^£[\\d,.]+ · ${TIME}$`));
		// Neighbours sit under a half-pixel apart, so any of the closest few is right.
		const closest = await page.locator('.chart .mark').evaluateAll(
			(marks, [tapX, tapY]) =>
				marks
					.map((mark) => {
						const { left, top, width, height } = mark.getBoundingClientRect();
						const distance = Math.hypot(left + width / 2 - tapX, top + height / 2 - tapY);
						return { distance, label: mark.getAttribute('aria-label') };
					})
					.sort((a, b) => a.distance - b.distance)
					.slice(0, 5)
					.map(({ label }) => label),
			[x, y]
		);
		expect(closest).toContain(await tooltip.textContent().then((text) => text?.trim()));
	});
});

test('one timezone', async ({ browser }) => {
	const read = (timezoneId: string) => {
		const seen = {
			hydration: [] as string[],
			marks: [] as (string | null)[],
			rows: [] as string[]
		};
		return withPage(browser, { timezoneId }, async (page) => {
			page.on('console', (message) => {
				if (/hydrat/i.test(message.text())) seen.hydration.push(message.text());
			});
			await page.goto(`/watches/${chartFull.id}`);
			await openTooltip(page);
			seen.marks = await page
				.locator('.chart .mark')
				.evaluateAll((marks) => marks.map((mark) => mark.getAttribute('aria-label')));
			seen.rows = await page.locator('table tbody tr td:first-child').allInnerTexts();
		}).then(() => seen);
	};

	const london = await read('Europe/London');
	const newYork = await read('America/New_York');

	expect(london.rows.length).toBeGreaterThan(0);
	expect(newYork.marks).toEqual(london.marks);
	expect(newYork.rows).toEqual(london.rows);
	expect([...london.hydration, ...newYork.hydration]).toEqual([]);
});

test('forced colours', async ({ browser }) => {
	await withPage(browser, { forcedColors: 'active' }, async (page) => {
		await page.goto(`/watches/${chartFull.id}`);

		const ground = await page
			.locator('.chart')
			.evaluate((el) => getComputedStyle(el).backgroundColor);
		const cross = await page
			.locator('.chart .mark .cross')
			.first()
			.evaluate((el) => getComputedStyle(el).stroke);
		const dot = await page
			.locator('.chart .mark .dot')
			.first()
			.evaluate((el) => getComputedStyle(el).fill);

		expect(cross, 'failure mark').not.toBe(ground);
		expect(dot, 'price mark').not.toBe(ground);
	});
});

test('no live fetch', async ({ browser }) => {
	const hosts = new Set<string>();
	await withPage(browser, {}, async (page) => {
		page.context().on('request', (request) => hosts.add(new URL(request.url()).hostname));
		await page.goto('/');
		await page.goto(`/watches/${chartFull.id}`);
		await openTooltip(page);
		await page.getByRole('button', { name: '30 days' }).click();
		await expect(page.locator('.chart .mark')).toHaveCount(6);
	});

	expect(hosts.size).toBeGreaterThan(0);
	expect([...hosts].filter((host) => host !== 'localhost' && !host.endsWith('.invalid'))).toEqual(
		[]
	);
});
