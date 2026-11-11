import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
	controlBorderContrast,
	expectNoOverflow,
	expectStructure,
	expectTextContrast,
	tabWalk,
	useScheme,
	type AllowlistEntry
} from './a11y.ts';

// The a11y helpers against inline page.setContent fixtures: no app route is
// visited and every request is aborted, so nothing here touches the network (r-01).

test.beforeEach(async ({ page }) => {
	await page.route('**/*', (route) => route.abort());
	await page.setViewportSize({ width: 375, height: 800 });
});

function fixture(body: string, style = ''): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>a11y fixture</title>
<style>
body { margin: 0; padding: 16px; background: #fff; color: #000; font: 16px/1.5 sans-serif; }
${style}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

async function show(page: Page, body: string, style = ''): Promise<void> {
	await page.setContent(fixture(body, style));
}

// A tiny inline SVG: axe cannot know the colour beneath text drawn over it.
const IMAGE_BG =
	"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='%23eee'/%3E%3C/svg%3E\")";
const OVER_IMAGE = `<p id="over-image" style="background-image: ${IMAGE_BG}">Text over an image</p>`;
const REASON = 'fixture: the image is a flat light grey under black text';

const CLEAN_STYLE = `
a { color: #0b5cad; text-decoration: underline; }
input, button { border: 1px solid #767676; background: #fff; color: #000; font: inherit; }
:focus-visible { outline: 2px solid #0b5cad; outline-offset: 2px; }
.dark-band { background: #222; color: #fff; padding: 8px; }
.dark-band :focus-visible { outline-color: #fff; }
.ghost { background: transparent; border: 2px solid #ddd; color: #fff; }
.long { overflow-wrap: anywhere; }
@media (prefers-color-scheme: dark) {
	body { background: #15181d; color: #e7e9ec; }
	a { color: #7cb6ff; }
	input, button { background: #1e2229; color: #e7e9ec; border-color: #7c858f; }
	:focus-visible { outline-color: #7cb6ff; }
}`;

const CLEAN_BODY = `
<h1>Clean page</h1>
<p>Body text with <a href="#more">an underlined link</a> in the middle of a sentence.</p>
<p class="long">${'Abcdefghij'.repeat(30)}</p>
<label>Email <input type="email" name="email"></label>
<label><input type="checkbox" name="remember"> Remember me</label>
<button type="submit">Save</button>
<section class="dark-band"><div><button class="ghost">Ghost</button></div></section>`;

test('text helper catches', async ({ page }) => {
	await test.step('#777 on #fff', async () => {
		await show(page, '<p style="color: #777">Grey body text</p>');
		await expect(expectTextContrast(page)).rejects.toThrow(/color-contrast violation/);
	});

	await test.step('unallowlisted text over a background image', async () => {
		await show(page, OVER_IMAGE);
		await expect(expectTextContrast(page)).rejects.toThrow(
			/color-contrast incomplete: #over-image/
		);
		// An entry excuses only the element it names.
		await expect(
			expectTextContrast(page, { allowlist: [{ selector: '#elsewhere', reason: REASON }] })
		).rejects.toThrow(/color-contrast incomplete: #over-image/);
	});

	await test.step('link told apart by colour alone', async () => {
		await show(
			page,
			'<p>Text with <a href="#x" style="color: #333; text-decoration: none">a link</a> inside it.</p>'
		);
		await expect(expectTextContrast(page)).rejects.toThrow(/link-in-text-block/);
	});
});

test('structure helper catches', async ({ page }) => {
	await test.step('a focusable child of role=img', async () => {
		await show(page, '<div role="img" aria-label="Chart"><button>Mark</button></div>');
		await expect(expectStructure(page)).rejects.toThrow(/nested-interactive violation/);
	});

	await test.step('an unnamed svg image', async () => {
		await show(page, '<svg role="img" width="10" height="10"></svg>');
		await expect(expectStructure(page)).rejects.toThrow(/svg-img-alt violation/);
	});

	await test.step('a named svg and a plain button pass', async () => {
		await show(
			page,
			'<svg role="img" aria-label="Chart" width="10" height="10"></svg><button>Mark</button>'
		);
		await expectStructure(page);
	});
});

test('border helper catches', async ({ page }) => {
	await test.step('#ddd border on #fff', async () => {
		await show(page, '<input aria-label="Name" style="border: 1px solid #ddd">');
		await expect(controlBorderContrast(page)).rejects.toThrow(
			/input 'Name' border rgb\(221, 221, 221\) on rgb\(255, 255, 255\)/
		);
	});

	await test.step("the control's own background is not the backdrop", async () => {
		// #ddd on the input's own #000 would pass; against the page's #fff it does not.
		await show(
			page,
			'<input aria-label="Dark" style="border: 2px solid #ddd; background: #000; color: #fff">'
		);
		await expect(controlBorderContrast(page)).rejects.toThrow(
			/input 'Dark' border rgb\(221, 221, 221\) on rgb\(255, 255, 255\)/
		);
	});

	await test.step('transparent control measured against the nearest opaque ancestor', async () => {
		// The section (#fff) is two levels up; the body behind it (#222) would pass.
		await show(
			page,
			'<section style="background: #fff"><div><button style="background: transparent; border: 2px solid #ddd">Go</button></div></section>',
			'body { background: #222; }'
		);
		await expect(controlBorderContrast(page)).rejects.toThrow(
			/button 'Go' border rgb\(221, 221, 221\) on rgb\(255, 255, 255\) is 1\.\d+:1/
		);
	});
});

test('focus helper catches', async ({ page }) => {
	const oneLink = '<a href="#a">One</a>';

	await test.step('outline: none', async () => {
		await show(page, oneLink, 'a:focus-visible { outline: none; }');
		await expect(tabWalk(page)).rejects.toThrow(/a 'One' has no focus outline/);
	});

	await test.step('1px #ccc ring on #fff', async () => {
		await show(page, oneLink, 'a:focus-visible { outline: 1px solid #ccc; }');
		await expect(tabWalk(page)).rejects.toThrow(/a 'One' focus outline is 1px/);
		await expect(tabWalk(page)).rejects.toThrow(/a 'One' focus outline rgb\(204, 204, 204\)/);
	});

	await test.step('2px ring too faint', async () => {
		await show(page, oneLink, 'a:focus-visible { outline: 2px solid #ccc; }');
		await expect(tabWalk(page)).rejects.toThrow(/focus outline rgb\(204, 204, 204\) on/);
	});

	await test.step('1px ring with enough contrast', async () => {
		await show(page, oneLink, 'a:focus-visible { outline: 1px solid #000; }');
		await expect(tabWalk(page)).rejects.toThrow(/focus outline is 1px \(< 2px\)/);
	});

	await test.step('an element Tab skips over', async () => {
		await show(
			page,
			`<button id="b1">One</button><button id="b2">Two</button><button id="b3">Three</button>
<script>
document.getElementById('b1').addEventListener('keydown', (e) => {
	if (e.key === 'Tab') { e.preventDefault(); document.getElementById('b3').focus(); }
});
</script>`,
			':focus-visible { outline: 2px solid #000; }'
		);
		await expect(tabWalk(page)).rejects.toThrow(/reached 2 elements, page has 3 tabbable/);
		await expect(tabWalk(page)).rejects.toThrow(/never reached by Tab: button#b2 'Two'/);
	});

	await test.step('endless tab order is capped', async () => {
		// Each time the last button takes focus another is appended: focus never leaves.
		await show(
			page,
			`<div id="list"><button>Item</button></div>
<script>
const list = document.getElementById('list');
list.addEventListener('focusin', (e) => {
	if (e.target === list.lastElementChild) {
		const next = document.createElement('button');
		next.textContent = 'Item';
		list.append(next);
	}
});
</script>`,
			':focus-visible { outline: 2px solid #000; }'
		);
		await expect(tabWalk(page, { max: 10 })).rejects.toThrow(/did not finish within 10 steps/);
	});
});

test('overflow helper catches', async ({ page }) => {
	await test.step('600px element at 375px', async () => {
		await show(page, '<div id="wide" style="width: 600px">Wide</div>');
		await expect(expectNoOverflow(page)).rejects.toThrow(
			/page is \d+px wide in a 375px viewport; overflowing: div#wide/
		);
	});

	await test.step('unbreakable text at 375px', async () => {
		await show(page, `<p id="unbroken">${'Abcdefghij'.repeat(30)}</p>`);
		await expect(expectNoOverflow(page)).rejects.toThrow(/overflowing: p#unbroken/);
	});
});

test('no false positives', async ({ page }) => {
	for (const scheme of ['light', 'dark'] as const) {
		await test.step(`clean page, ${scheme}`, async () => {
			await useScheme(page, scheme);
			await show(page, CLEAN_BODY, CLEAN_STYLE);
			expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
				scheme === 'dark'
			);

			await expectTextContrast(page);
			await controlBorderContrast(page);
			await expectNoOverflow(page);
			const stops = await tabWalk(page);
			expect(stops.map((stop) => stop.label)).toStrictEqual([
				"a 'an underlined link'",
				"input 'Email'",
				"input 'Remember me'",
				"button 'Save'",
				"button 'Ghost'"
			]);
			expect(stops.every((stop) => stop.focusVisible)).toBe(true);
		});
	}

	await test.step('allowlisted text over a background image', async () => {
		await useScheme(page, 'light');
		await show(page, OVER_IMAGE);
		await expectTextContrast(page, { allowlist: [{ selector: '#over-image', reason: REASON }] });
	});
});

test('allowlist needs reason', async ({ page }) => {
	await show(page, '<p>Plain text</p>');
	const bad: unknown[] = [
		{ selector: '#over-image', reason: '' },
		{ selector: '#over-image', reason: '   ' },
		{ selector: '#over-image' }
	];
	for (const entry of bad) {
		await expect(
			expectTextContrast(page, { allowlist: [entry as AllowlistEntry] }),
			JSON.stringify(entry)
		).rejects.toThrow(/allowlist entry 0 \(#over-image\) has no reason/);
	}
});

test('dev only', () => {
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	expect(pkg.devDependencies?.['@axe-core/playwright']).toMatch(/^\d+\.\d+\.\d+$/);
	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
		expect(pkg[field]?.['@axe-core/playwright'], field).toBeUndefined();
	}
});
