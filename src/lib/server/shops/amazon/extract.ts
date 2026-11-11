// Buy-box price, title and image extraction from an amazon.co.uk product page.
// Imported by the adapter:check CLI, so it runs under Node type stripping: no
// $app/* or $env/* imports, explicit .ts extensions, erasable syntax only.

import type { HTMLElement } from 'node-html-parser';

/**
 * '£19.99', '£1,299.99' or '£5' — GBP only, thousands separators only in full
 * groups of three, and either no pence or exactly two digits.
 */
const GBP_PRICE = /^£(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?$/;

/**
 * A displayed GBP price as integer pence, or null for anything that isn't one
 * exact positive GBP amount (other currencies, ranges, malformed text, £0.00).
 * String arithmetic only: '£19.99' is 19 * 100 + 99, never 19.99 * 100.
 */
export function parsePence(text: string): number | null {
	const match = GBP_PRICE.exec(text.trim());
	if (match === null) return null;

	const pounds = Number(match[1].replaceAll(',', ''));
	const pence = match[2] === undefined ? 0 : Number(match[2]);
	const total = pounds * 100 + pence;

	return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/**
 * Where the buy-box price lives, most specific layout first. Nothing outside
 * these is ever read, so carousels and sponsored tiles can't leak a price in.
 */
const BUY_BOX_CONTAINERS = [
	'#corePrice_feature_div',
	'#corePriceDisplay_desktop_feature_div',
	'#apex_desktop .priceToPay',
	'.apexPriceToPay'
];

/** The price the buyer pays; trusted even where the layout styles it as a text price. */
const PAY_PRICE = '.priceToPay, .apexPriceToPay';

/**
 * An id or class marking a region whose price isn't the plain buy price: a
 * coupon, Subscribe & Save, a used offer, a unit price, or a variant price range.
 */
const SKIPPED_REGION = /coupon|promoPriceBlock|subscribe|^sns|^used|pricePerUnit|price-range/i;

function classes(element: HTMLElement): string[] {
	return (element.getAttribute('class') ?? '').split(/\s+/).filter((name) => name !== '');
}

function marksSkippedRegion(element: HTMLElement): boolean {
	return [element.id, ...classes(element)].some((name) => SKIPPED_REGION.test(name));
}

/**
 * Whether a price element must be skipped: a struck-through RRP/was/list price
 * (.a-text-price, unless it is the pay price), or anything inside a skipped
 * region. The walk runs to the document root, not just the container: a
 * page-wide .apexPriceToPay match can itself sit in a used or S&S accordion row.
 */
function isExcluded(price: HTMLElement): boolean {
	if (classes(price).includes('a-text-price') && !price.matches(PAY_PRICE)) return true;

	for (let node: HTMLElement | null = price; node !== null; node = node.parentNode) {
		if (marksSkippedRegion(node)) return true;
	}
	return false;
}

/** The pence shown by one .a-price element: its screen-reader text, else whole + fraction. */
function priceOf(price: HTMLElement): number | null {
	const offscreen = price.querySelector('.a-offscreen');
	const fromOffscreen = offscreen === null ? null : parsePence(offscreen.text);
	if (fromOffscreen !== null) return fromOffscreen;

	const whole = price.querySelector('.a-price-whole');
	if (whole === null) return null;

	const symbol = price.querySelector('.a-price-symbol')?.text.trim() ?? '£';
	// The decimal point sits inside .a-price-whole ('1,299.'), not with the fraction.
	const pounds = whole.text.trim().replace(/\.$/, '');
	const fraction = price.querySelector('.a-price-fraction');
	return parsePence(
		fraction === null ? `${symbol}${pounds}` : `${symbol}${pounds}.${fraction.text.trim()}`
	);
}

/** Price elements in a container, the pay price first; the container itself counts. */
function candidates(container: HTMLElement): HTMLElement[] {
	const self = container.matches('.a-price') ? [container] : [];
	const all = [...self, ...container.querySelectorAll('.a-price')];
	const pay = all.filter((element) => element.matches(PAY_PRICE));
	return [...pay, ...all.filter((element) => !pay.includes(element))];
}

/**
 * The buy-box price in pence, read only inside the buy-box containers, or null
 * when the page has none (no buy-box offer, price range, unparseable text).
 */
export function extractBuyBoxPrice(root: HTMLElement): number | null {
	for (const selector of BUY_BOX_CONTAINERS) {
		for (const container of root.querySelectorAll(selector)) {
			for (const price of candidates(container)) {
				if (isExcluded(price)) continue;
				const pence = priceOf(price);
				if (pence !== null) return pence;
			}
		}
	}
	return null;
}

/** The product title, entities decoded and whitespace collapsed, or null if absent/blank. */
export function extractTitle(root: HTMLElement): string | null {
	const title = root.querySelector('#productTitle')?.text.replace(/\s+/g, ' ').trim();
	return title === undefined || title === '' ? null : title;
}

function httpsUrl(value: string | undefined): string | null {
	if (value === undefined) return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === 'https:' ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * The main product image: #landingImage's hi-res data-old-hires, else its src.
 * Only https URLs count; anything else (data: URI, http, missing) is null.
 */
export function extractImage(root: HTMLElement): string | null {
	const image = root.querySelector('#landingImage');
	if (image === null) return null;
	return httpsUrl(image.getAttribute('data-old-hires')) ?? httpsUrl(image.getAttribute('src'));
}
