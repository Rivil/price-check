// The CSP violation collector in launchDesktop (c-23) really listens: every desktop
// test gates on zero violations at close, which proves nothing unless the collector
// would have seen one. This spec causes exactly two in the live window, an inline
// script (script-src) and an image on a .invalid host (img-src, never fetched: r-01),
// and expects both, then clears them so its own close passes.
import { expect, test } from '@playwright/test';
import { launchDesktop, type DesktopApp } from './launch.ts';

test('the collector records exactly the violations a window causes', async () => {
	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop();
		const page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
		await page.waitForLoadState('load');
		// The app's own first page reported nothing.
		expect(desktop.cspViolations()).toEqual([]);

		await page.evaluate(() => {
			const script = document.createElement('script');
			script.textContent = 'window.__e2eInlineRan = true;';
			document.body.append(script);
			const img = document.createElement('img');
			img.src = 'https://images.csp-e2e.invalid/blocked.png';
			document.body.append(img);
		});

		await expect.poll(() => desktop!.cspViolations().length, { timeout: 10_000 }).toBe(2);
		const violations = desktop.cspViolations();
		expect(violations.some((v) => v.startsWith('script-src') && v.endsWith('inline'))).toBe(true);
		expect(violations).toContain('img-src https://images.csp-e2e.invalid/blocked.png');
		// The inline script never ran.
		expect(await page.evaluate(() => 'e2eInlineRan' in window)).toBe(false);
		// Nothing else trickles in.
		await page.waitForTimeout(500);
		expect(desktop.cspViolations()).toHaveLength(2);
		desktop.clearCspViolations();
	} finally {
		await desktop?.close();
	}
});

test('close fails a test whose window reported a violation', async () => {
	const desktop = await launchDesktop();
	try {
		const page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
		await page.evaluate(() => {
			const img = document.createElement('img');
			img.src = 'https://images.csp-e2e.invalid/close-gate.png';
			document.body.append(img);
		});
		await expect.poll(() => desktop.cspViolations().length, { timeout: 10_000 }).toBe(1);
	} catch (error) {
		await desktop.close().catch(() => {
			// The close below is the one under test; this path only cleans up.
		});
		throw error;
	}
	await expect(desktop.close()).rejects.toThrow(
		/CSP violation\(s\)[\s\S]*img-src https:\/\/images\.csp-e2e\.invalid\/close-gate\.png/
	);
});
