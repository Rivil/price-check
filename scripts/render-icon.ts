// pnpm icon:render
//
// Rasterises the app icon's source, build-resources/icon.svg, into the 1024x1024
// build-resources/icon.png that electron-builder turns into the macOS icns, the
// Windows ico and the Linux icons, and copies the same SVG to the web favicon.
// Playwright's Chromium draws it at a fixed viewport and scale with a transparent
// background, so re-running it on one Chromium build rewrites the same bytes.
// Run it by hand after editing the SVG and commit all three files.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ICON_PNG, ICON_SIZE, ICON_SVG, ROOT } from './package-desktop.ts';

const FAVICON_SVG = 'src/lib/assets/favicon.svg';

const svg = readFileSync(join(ROOT, ICON_SVG), 'utf8');
const browser = await chromium.launch();
try {
	const page = await browser.newPage({
		viewport: { width: ICON_SIZE, height: ICON_SIZE },
		deviceScaleFactor: 1
	});
	await page.setContent(
		`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`
	);
	const png = await page.screenshot({ omitBackground: true, type: 'png' });
	writeFileSync(join(ROOT, ICON_PNG), png);
} finally {
	await browser.close();
}
copyFileSync(join(ROOT, ICON_SVG), join(ROOT, FAVICON_SVG));
