// Classifies a fetched amazon.co.uk product page into a typed outcome. Pure: no
// status codes, no requests. Imported by the adapter:check CLI, so it runs under
// Node type stripping: no $app/* or $env/* imports, explicit .ts extensions,
// erasable syntax only.
import { parse, type HTMLElement } from 'node-html-parser';
import { failure, type CheckFailure } from '../types.ts';
import { extractBuyBoxPrice, extractImage, extractTitle } from './extract.ts';

/** The page-level part of a successful check; the adapter adds shop, ASIN and URL. */
export type PageSuccess = { ok: true; title: string; pricePence: number; imageUrl: string | null };

export type PageOutcome = PageSuccess | CheckFailure;

export const VARIANT_MESSAGE =
	'pick a size/colour on Amazon, then paste the URL of that exact variant';

const BOT_WALL_TEXT = [
	/make sure you(?:'|&#39;|’)re not a robot/i,
	/enter the characters you see below/i,
	/type the characters you see in this image/i,
	/click the button below to continue shopping/i
];

const PRICE_RANGE =
	'#corePrice_feature_div .a-price-range, #corePriceDisplay_desktop_feature_div .a-price-range, #apex_desktop .a-price-range';

function root(html: string): HTMLElement {
	return parse(html);
}

function isBotWallPage(page: HTMLElement): boolean {
	if (page.querySelector('form[action*="validateCaptcha"]') !== null) return true;
	const text = page.text;
	return BOT_WALL_TEXT.some((pattern) => pattern.test(text));
}

/** Whether the body is Amazon's captcha / robot-check wall, whatever the HTTP status. */
export function isBotWall(html: string): boolean {
	return isBotWallPage(root(html));
}

function classNames(element: HTMLElement): string[] {
	return (element.getAttribute('class') ?? '').split(/\s+/);
}

/** A variation parent: a price range, or a twister dimension with nothing chosen. */
function needsVariant(page: HTMLElement): boolean {
	if (page.querySelector(PRICE_RANGE) !== null) return true;

	const twister = page.querySelector('#twister');
	if (twister === null) return false;

	for (const select of twister.querySelectorAll('select')) {
		const chosen = select
			.querySelectorAll('option')
			.find((option) => option.getAttribute('selected') !== undefined);
		if (chosen === undefined || chosen.getAttribute('value') === '-1') return true;
	}
	for (const list of twister.querySelectorAll('ul')) {
		const swatches = list.querySelectorAll('li');
		const picked = swatches.some((li) =>
			classNames(li).some((name) => name === 'swatchSelect' || name === 'a-button-selected')
		);
		if (swatches.length > 0 && !picked) return true;
	}
	return false;
}

function isOutOfStock(page: HTMLElement): boolean {
	if (page.querySelector('#outOfStock') !== null) return true;
	const availability = page.querySelector('#availability')?.text ?? '';
	return /currently unavailable/i.test(availability);
}

function offersOnlyBuyingOptions(page: HTMLElement): boolean {
	if (page.querySelector('#buybox-see-all-buying-choices') !== null) return true;
	return /see all buying options/i.test(page.querySelector('#buybox')?.text ?? '');
}

/**
 * Fixed precedence: blocked → variant_required → unavailable → ok → parse_failed.
 * A failure never carries a price, even when the page shows one elsewhere.
 */
export function classifyProductPage(html: string): PageOutcome {
	const page = root(html);

	if (isBotWallPage(page)) return failure('blocked', 'Amazon served a robot-check (captcha) page');
	if (needsVariant(page)) return failure('variant_required', VARIANT_MESSAGE);
	if (isOutOfStock(page)) return failure('unavailable', 'currently unavailable');

	const pricePence = extractBuyBoxPrice(page);
	if (pricePence === null && offersOnlyBuyingOptions(page)) {
		return failure('unavailable', 'no buy-box offer');
	}

	const title = extractTitle(page);
	if (title !== null && pricePence !== null) {
		return { ok: true, title, pricePence, imageUrl: extractImage(page) };
	}

	if (title === null && pricePence === null) {
		return failure('parse_failed', 'no product title or buy-box price found');
	}
	return failure(
		'parse_failed',
		title === null ? 'no product title found' : 'no buy-box price found'
	);
}
