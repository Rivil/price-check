import { describe, expect, it } from 'vitest';
import { VARIANT_MESSAGE, classifyProductPage, isBotWall } from './classify.ts';
import { FIXTURES } from './fixtures/manifest.ts';

// Every fixture page, keyed by name without .html; recorded pages join automatically.
const pages = Object.fromEntries(
	Object.entries(
		// Stryker disable next-line all: import.meta.glob needs literal args for Vite's static transform
		import.meta.glob<string>('./fixtures/*.html', { query: '?raw', import: 'default', eager: true })
	).map(([path, html]) => [path.replace(/^\.\/fixtures\//, '').replace(/\.html$/, ''), html])
);

function page(name: string): string {
	const html = pages[name];
	if (html === undefined) throw new Error(`no fixture ${name}.html`);
	return html;
}

/** The fixture with extra markup appended to its body. */
function inject(name: string, markup: string): string {
	const html = page(name);
	expect(html).toContain('</body>');
	return html.replace('</body>', `${markup}</body>`);
}

const failureNames = Object.entries(FIXTURES)
	.filter(([, entry]) => !entry.expect.ok)
	.map(([name]) => name);

const UNSELECTED_TWISTER = `<form id="twister"><select name="dropdown_selected_size_name">
<option value="-1" selected>Select</option><option value="0,B0TESTVS01">S</option></select></form>`;
const SELECTED_TWISTER = `<form id="twister"><select name="dropdown_selected_size_name">
<option value="-1">Select</option><option value="0,B0TESTVS01" selected>S</option></select>
<ul><li class="swatchSelect">Navy</li><li class="swatchAvailable">White</li></ul></form>`;

describe('classifyProductPage', () => {
	it('manifest table', () => {
		expect(Object.keys(FIXTURES).length).toBeGreaterThan(0);

		for (const [name, { expect: expected }] of Object.entries(FIXTURES)) {
			const result = classifyProductPage(page(name));
			if (expected.ok) {
				expect(result, name).toEqual(expected);
			} else {
				expect(result, name).toMatchObject({ ok: false, reason: expected.reason });
				if (expected.message !== undefined) {
					expect(result.ok === false && result.message, name).toBe(expected.message);
				}
			}
		}
		// The traps: never the RRP, Subscribe & Save, used or voucher price.
		expect(classifyProductPage(page('synthetic-deal'))).toMatchObject({ pricePence: 2999 });
		expect(classifyProductPage(page('synthetic-plain'))).toMatchObject({ pricePence: 1999 });
		expect(classifyProductPage(page('synthetic-over-1000'))).toMatchObject({
			pricePence: 129900
		});
	});

	it('no price on failure', () => {
		expect(failureNames.length).toBeGreaterThan(0);
		for (const name of failureNames) {
			const result = classifyProductPage(page(name));
			expect(result.ok, name).toBe(false);
			expect('pricePence' in result, name).toBe(false);
			expect(Object.keys(result), name).toEqual(['ok', 'reason', 'message']);
		}
	});

	it('no buy-box', () => {
		const result = classifyProductPage(page('synthetic-no-buy-box'));

		expect(result).toStrictEqual({ ok: false, reason: 'unavailable', message: 'no buy-box offer' });
		expect(JSON.stringify(result)).not.toContain('offer-listing');
	});

	it('variant parent', () => {
		const result = classifyProductPage(page('synthetic-variant-parent'));

		expect(result).toStrictEqual({
			ok: false,
			reason: 'variant_required',
			message: VARIANT_MESSAGE
		});
		expect(VARIANT_MESSAGE).toMatch(/size/);
		expect(VARIANT_MESSAGE).toMatch(/colour/);
		expect(VARIANT_MESSAGE).toMatch(/paste the URL/);

		// A price range alone (no twister) is still a variation parent, never ok 1099.
		const rangeOnly = `<span id="productTitle">Shirt</span>
<div id="corePriceDisplay_desktop_feature_div"><span class="a-price-range">
<span class="a-price"><span class="a-offscreen">£10.99</span></span> – <span class="a-price"><span class="a-offscreen">£24.99</span></span>
</span></div>`;
		expect(classifyProductPage(rangeOnly)).toMatchObject({ reason: 'variant_required' });
	});

	it('precedence', () => {
		const captchaWithProduct = inject(
			'synthetic-captcha',
			`<span id="productTitle">Injected</span><div id="corePrice_feature_div">
<span class="a-price priceToPay"><span class="a-offscreen">£5.00</span></span></div>`
		);
		expect(classifyProductPage(captchaWithProduct)).toMatchObject({ reason: 'blocked' });

		expect(classifyProductPage(inject('synthetic-unavailable', UNSELECTED_TWISTER))).toMatchObject({
			reason: 'variant_required'
		});
		expect(classifyProductPage(inject('synthetic-unavailable', SELECTED_TWISTER))).toStrictEqual({
			ok: false,
			reason: 'unavailable',
			message: 'currently unavailable'
		});

		// A chosen variant leaves an in-stock page ok.
		expect(classifyProductPage(inject('synthetic-plain', SELECTED_TWISTER))).toMatchObject({
			ok: true,
			pricePence: 1999
		});
	});

	it('parse_failed', () => {
		const titleOnly = '<span id="productTitle">Only a title</span>';
		const priceOnly =
			'<div id="corePrice_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">£5.00</span></span></div>';

		for (const html of [titleOnly, priceOnly, '', 'not html at all <<<>>> \u0000 &&&']) {
			expect(() => classifyProductPage(html), html).not.toThrow();
			const result = classifyProductPage(html);
			expect(result, html).toMatchObject({ ok: false, reason: 'parse_failed' });
			expect('pricePence' in result, html).toBe(false);
		}
	});

	const TITLE = '<span id="productTitle">Thing</span>';
	const PRICE =
		'<div id="corePrice_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">£5.00</span></span></div>';
	const twister = (inner: string) => `<form id="twister">${inner}</form>`;
	const OK = { ok: true, title: 'Thing', pricePence: 500, imageUrl: null };
	const VARIANT = { ok: false, reason: 'variant_required', message: VARIANT_MESSAGE };

	it('swatch variants', () => {
		const unpicked = twister(
			'<ul><li class="swatchAvailable">Navy</li><li class="swatchAvailable">White</li></ul>'
		);
		expect(classifyProductPage(TITLE + PRICE + unpicked)).toStrictEqual(VARIANT);

		for (const picked of ['a-declarative swatchSelect', 'a-button-selected']) {
			const list = twister(
				`<ul><li class="${picked}">Navy</li><li class="swatchAvailable">White</li></ul>`
			);
			expect(classifyProductPage(TITLE + PRICE + list), picked).toStrictEqual(OK);
		}
		expect(classifyProductPage(TITLE + PRICE + twister('<ul></ul>'))).toStrictEqual(OK);

		const minusOne = twister(
			'<select><option value="-1" selected>Select</option><option value="0,B0X">S</option></select>'
		);
		expect(classifyProductPage(TITLE + PRICE + minusOne)).toStrictEqual(VARIANT);
		const noneSelected = twister(
			'<select><option value="0,B0X">S</option><option value="1,B0Y">M</option></select>'
		);
		expect(classifyProductPage(TITLE + PRICE + noneSelected)).toStrictEqual(VARIANT);
	});

	it('unavailable signals', () => {
		const outOfStock = { ok: false, reason: 'unavailable', message: 'currently unavailable' };
		expect(classifyProductPage(TITLE + PRICE + '<div id="outOfStock">Gone</div>')).toStrictEqual(
			outOfStock
		);
		expect(
			classifyProductPage(
				TITLE + PRICE + '<div id="availability"><span>Currently unavailable.</span></div>'
			)
		).toStrictEqual(outOfStock);

		const noOffer = { ok: false, reason: 'unavailable', message: 'no buy-box offer' };
		expect(
			classifyProductPage(TITLE + '<div id="buybox-see-all-buying-choices"><a>Other</a></div>')
		).toStrictEqual(noOffer);
		expect(
			classifyProductPage(TITLE + '<div id="buybox"><a>See All Buying Options</a></div>')
		).toStrictEqual(noOffer);

		// A buy-box price wins over the 'See all buying options' link beside it.
		expect(
			classifyProductPage(TITLE + PRICE + '<div id="buybox"><a>See All Buying Options</a></div>')
		).toStrictEqual(OK);
	});

	it('parse_failed messages', () => {
		const cases: [string, string][] = [
			['<p>nothing here</p>', 'no product title or buy-box price found'],
			[TITLE, 'no buy-box price found'],
			[PRICE, 'no product title found']
		];
		for (const [html, message] of cases) {
			expect(classifyProductPage(html), html).toStrictEqual({
				ok: false,
				reason: 'parse_failed',
				message
			});
		}
	});

	it('no image', () => {
		expect(classifyProductPage(page('synthetic-no-image'))).toEqual({
			ok: true,
			title: 'Acme AA Batteries, Pack of 12',
			pricePence: 849,
			imageUrl: null
		});
	});
});

describe('isBotWall', () => {
	it('bot wall', () => {
		expect(isBotWall(page('synthetic-captcha'))).toBe(true);
		expect(isBotWall('<p>Sorry, we just need to make sure you&#39;re not a robot.</p>')).toBe(true);
		expect(isBotWall('<form action="/errors/validateCaptcha"></form>')).toBe(true);
		expect(isBotWall('<form action="/errors_page/validateCaptcha"></form>')).toBe(true);
		expect(isBotWall('<h4>Click the button below to continue shopping</h4>')).toBe(true);
		expect(isBotWall('<a href="/">Continue shopping</a>')).toBe(false);

		for (const name of Object.keys(FIXTURES).filter((n) => FIXTURES[n].shape !== 'captcha')) {
			expect(isBotWall(page(name)), name).toBe(false);
		}
		expect(isBotWall('')).toBe(false);
		expect(isBotWall('Service Unavailable')).toBe(false);
	});
});
