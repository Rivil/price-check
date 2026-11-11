import { parse } from 'node-html-parser';
import { describe, expect, it } from 'vitest';
import { extractBuyBoxPrice, extractImage, extractTitle, parsePence } from './extract.ts';

/** A rendered .a-price with screen-reader text, as Amazon emits it. */
function aPrice(text: string, extraClasses = ''): string {
	return `<span class="a-price ${extraClasses}" data-a-size="xl">
		<span class="a-offscreen">${text}</span>
		<span aria-hidden="true">${text}</span>
	</span>`;
}

/** A .a-price with no screen-reader text: symbol, whole (with decimal point) and fraction. */
function splitPrice(whole: string, fraction: string, symbol = '£', extraClasses = ''): string {
	return `<span class="a-price ${extraClasses}">
		<span aria-hidden="true">
			<span class="a-price-symbol">${symbol}</span><span class="a-price-whole">${whole}<span class="a-price-decimal">.</span></span><span class="a-price-fraction">${fraction}</span>
		</span>
	</span>`;
}

function priceIn(html: string): number | null {
	return extractBuyBoxPrice(parse(html));
}

describe('parsePence', () => {
	it('parsePence valid', () => {
		const table: [string, number][] = [
			['£19.99', 1999],
			['£0.29', 29],
			['£0.99', 99],
			['£1,299.99', 129999],
			['£12,345.00', 1234500],
			['£1,000,000.01', 100000001],
			['£1299.99', 129999],
			['£5', 500],
			['£10', 1000],
			['  £19.99\n', 1999]
		];
		for (const [text, pence] of table) {
			expect(parsePence(text), text).toBe(pence);
		}

		const decoded = parse('<span>&pound;7.50</span>').text;
		expect(decoded).toBe('£7.50');
		expect(parsePence(decoded)).toBe(750);
	});

	it('parsePence invalid', () => {
		for (const text of [
			'€19.99',
			'€5,00',
			'$19.99',
			'£10.99 - £24.99',
			'£',
			'',
			'£1.2.3',
			'£5.5',
			'£0.00',
			'£0',
			'£19.999',
			'£1,29.99',
			'£1,2999.99',
			'£,299.99',
			'£ 19.99',
			'19.99',
			'£19.99 each',
			'&pound;7.50',
			'£99999999999999999.99'
		]) {
			expect(parsePence(text), text).toBeNull();
		}
	});
});

describe('extractBuyBoxPrice', () => {
	it('RRP decoy', () => {
		const deal = `<div id="corePriceDisplay_desktop_feature_div">
			<span class="a-size-small">RRP:</span>
			${aPrice('£49.99', 'a-text-price')}
			<span class="savingsPercentage">-40%</span>
			${aPrice('£29.99', 'priceToPay')}
		</div>`;
		expect(priceIn(deal)).toBe(2999);

		// The struck-through price is skipped even when the pay price isn't marked.
		const unmarked = `<div id="corePrice_feature_div">
			${aPrice('£49.99', 'a-text-price')}
			${aPrice('£29.99')}
		</div>`;
		expect(priceIn(unmarked)).toBe(2999);

		// With only an RRP there is no price to trust.
		const rrpOnly = `<div id="corePrice_feature_div">${aPrice('£49.99', 'a-text-price')}</div>`;
		expect(priceIn(rrpOnly)).toBeNull();

		// The older table layout styles the pay price as a text price; it still counts.
		const table = `<div id="corePrice_feature_div">
			<span class="a-price a-text-price a-size-base" data-a-strike="true"><span class="a-offscreen">£49.99</span></span>
			${aPrice('£31.50', 'a-text-price apexPriceToPay')}
		</div>`;
		expect(priceIn(table)).toBe(3150);
	});

	it('no buy-box', () => {
		const carousel = `<div id="sp_detail" class="a-carousel-container">
			<div class="a-carousel-card">Sponsored ${aPrice('£9.99')}</div>
		</div>`;

		const noBuyBox = `<span id="productTitle">Thing</span>
			${carousel}
			<div id="buybox-see-all-buying-choices"><a>See All Buying Options</a></div>`;
		expect(priceIn(noBuyBox)).toBeNull();

		// A pay-price class outside the apex block is not a buy box either.
		expect(priceIn(`${carousel}${aPrice('£8.99', 'priceToPay')}`)).toBeNull();

		// The carousel comes first in the page, yet only the buy box is read.
		const withBuyBox = `${carousel}<div id="corePrice_feature_div">${aPrice('£24.00')}</div>`;
		expect(priceIn(withBuyBox)).toBe(2400);
	});

	it('split price', () => {
		expect(priceIn(`<div id="corePrice_feature_div">${splitPrice('1,299', '99')}</div>`)).toBe(
			129999
		);

		// An empty screen-reader span falls back to the visible parts.
		const emptyOffscreen = `<div id="corePrice_feature_div">
			<span class="a-price priceToPay">
				<span class="a-offscreen"> </span>
				<span class="a-price-symbol">£</span><span class="a-price-whole">7<span class="a-price-decimal">.</span></span><span class="a-price-fraction">05</span>
			</span>
		</div>`;
		expect(priceIn(emptyOffscreen)).toBe(705);

		const noSymbol = `<div id="corePrice_feature_div"><span class="a-price">
			<span class="a-price-whole">12<span class="a-price-decimal">.</span></span><span class="a-price-fraction">34</span>
		</span></div>`;
		expect(priceIn(noSymbol)).toBe(1234);

		const noFraction = `<div id="corePrice_feature_div"><span class="a-price">
			<span class="a-price-symbol">£</span><span class="a-price-whole">15</span>
		</span></div>`;
		expect(priceIn(noFraction)).toBe(1500);

		const euro = `<div id="corePrice_feature_div">${splitPrice('19', '99', '€')}</div>`;
		expect(priceIn(euro)).toBeNull();

		const noWhole = `<div id="corePrice_feature_div"><span class="a-price">
			<span class="a-price-symbol">£</span><span class="a-price-fraction">99</span>
		</span></div>`;
		expect(priceIn(noWhole)).toBeNull();
	});

	it('container selectors', () => {
		expect(priceIn(`<div id="corePrice_feature_div">${aPrice('£1.01')}</div>`)).toBe(101);
		expect(priceIn(`<div id="corePriceDisplay_desktop_feature_div">${aPrice('£1.02')}</div>`)).toBe(
			102
		);
		expect(priceIn(`<div id="apex_desktop">${aPrice('£1.03', 'priceToPay')}</div>`)).toBe(103);
		expect(priceIn(aPrice('£1.04', 'apexPriceToPay'))).toBe(104);

		// Inside #apex_desktop only the pay price is a container.
		expect(priceIn(`<div id="apex_desktop">${aPrice('£1.05')}</div>`)).toBeNull();

		// The first container with a usable price wins; one without falls through.
		const ordered = `${aPrice('£2.00', 'apexPriceToPay')}
			<div id="corePrice_feature_div">${aPrice('£3.00')}</div>`;
		expect(priceIn(ordered)).toBe(300);
		const fallThrough = `<div id="corePrice_feature_div"><span>Currently unavailable.</span></div>
			<div id="corePriceDisplay_desktop_feature_div">${aPrice('£4.00')}</div>`;
		expect(priceIn(fallThrough)).toBe(400);
	});

	it('skipped offers', () => {
		const regions = [
			`<div id="couponFeature">${aPrice('£1.00')}</div>`,
			`<div id="promoPriceBlockMessage_feature_div">${aPrice('£1.10')}</div>`,
			`<div class="a-section couponLabelText">${aPrice('£1.20')}</div>`,
			`<div id="snsAccordionRowMiddle">${aPrice('£1.30')}</div>`,
			`<div class="sns-base-price">${aPrice('£1.40')}</div>`,
			`<div id="subscribeAndSave">${aPrice('£1.50')}</div>`,
			`<div id="usedAccordionRow">${aPrice('£1.60')}</div>`,
			`<div id="usedBuySection">${aPrice('£1.70')}</div>`,
			`<span class="a-size-mini pricePerUnit">(${aPrice('£1.80')} / 100 g)</span>`,
			`<span class="a-price-range">${aPrice('£1.90')} - ${aPrice('£2.90')}</span>`
		];

		for (const region of regions) {
			const html = `<div id="corePrice_feature_div">${region}</div>`;
			expect(priceIn(html), region).toBeNull();
			expect(
				priceIn(`<div id="corePrice_feature_div">${region}${aPrice('£9.00')}</div>`),
				region
			).toBe(900);
		}
	});

	it('skipped region anchors', () => {
		// 'sns' and 'used' only mark a region when a name starts with them.
		for (const wrapper of [
			'<div class="a-section focused">',
			'<div id="lessnsBox">',
			'<div class="lessnsBox">'
		]) {
			const html = `<div id="corePrice_feature_div">${wrapper}${aPrice('£11.00')}</div></div>`;
			expect(priceIn(html), wrapper).toBe(1100);
		}
		for (const wrapper of [
			'<div id="snsAccordionRowMiddle">',
			'<div class="snsAccordionRowMiddle">',
			'<div id="usedAccordionRow">',
			'<div class="usedAccordionRow">'
		]) {
			const html = `<div id="corePrice_feature_div">${wrapper}${aPrice('£11.00')}</div></div>`;
			expect(priceIn(html), wrapper).toBeNull();
		}
	});

	it('class list', () => {
		const rrp = `<span class="  a-price   a-text-price " data-a-strike="true"><span class="a-offscreen">£49.99</span></span>`;
		expect(priceIn(`<div id="corePrice_feature_div">${rrp}</div>`)).toBeNull();
		expect(priceIn(`<div id="corePrice_feature_div">${rrp}${aPrice('£29.99')}</div>`)).toBe(2999);
	});

	it('whole fraction fallback', () => {
		// Whitespace around every part, the decimal point inside the whole.
		const spaced = `<div id="corePrice_feature_div"><span class="a-price">
			<span class="a-price-symbol"> £ </span><span class="a-price-whole"> 1,299<span class="a-price-decimal">.</span> </span><span class="a-price-fraction"> 99 </span>
		</span></div>`;
		expect(priceIn(spaced)).toBe(129999);

		const wholeWithPoint = `<div id="corePrice_feature_div"><span class="a-price">
			<span class="a-price-symbol">£</span><span class="a-price-whole">12<span class="a-price-decimal">.</span></span>
		</span></div>`;
		expect(priceIn(wholeWithPoint)).toBe(1200);

		const noSymbolNoFraction = `<div id="corePrice_feature_div"><span class="a-price">
			<span class="a-price-whole">8<span class="a-price-decimal">.</span></span>
		</span></div>`;
		expect(priceIn(noSymbolNoFraction)).toBe(800);

		// A candidate with neither screen-reader text nor a whole part is skipped, not final.
		const unreadableFirst = `<div id="corePrice_feature_div">
			<span class="a-price"><span class="a-price-fraction">99</span></span>
			${aPrice('£6.50')}
		</div>`;
		expect(priceIn(unreadableFirst)).toBe(650);
	});

	it('pay price first', () => {
		const html = `<div id="corePrice_feature_div">
			${aPrice('£49.99')}
			${aPrice('£39.99', 'priceToPay')}
		</div>`;
		expect(priceIn(html)).toBe(3999);
	});

	it('accordion containers', () => {
		// A page-wide pay-price match inside a skipped accordion row is not the buy box.
		const snsOnly = `<div id="buyBoxAccordion">
			<div id="snsAccordionRowMiddle"><div class="a-row">${aPrice('£8.50', 'apexPriceToPay')}</div></div>
		</div>`;
		expect(priceIn(snsOnly)).toBeNull();

		const usedOnly = `<div id="buyBoxAccordion">
			<div id="usedAccordionRow"><div class="a-row">${aPrice('£6.25', 'apexPriceToPay')}</div></div>
		</div>`;
		expect(priceIn(usedOnly)).toBeNull();

		const couponOnly = `<div class="couponFeature">${aPrice('£7.75', 'apexPriceToPay')}</div>`;
		expect(priceIn(couponOnly)).toBeNull();

		// The S&S row comes first in the page; the one-time purchase price is returned.
		const both = `<div id="buyBoxAccordion">
			<div id="snsAccordionRowMiddle">${aPrice('£8.50', 'apexPriceToPay')}</div>
			<div id="newAccordionRow_0">${aPrice('£9.99', 'apexPriceToPay')}</div>
		</div>`;
		expect(priceIn(both)).toBe(999);

		// The same holds for the id-scoped containers.
		const usedCore = `<div id="usedAccordionRow">
			<div id="corePrice_feature_div">${aPrice('£5.00')}</div>
		</div>`;
		expect(priceIn(usedCore)).toBeNull();
		const usedApex = `<div id="usedAccordionRow">
			<div id="apex_desktop">${aPrice('£5.00', 'priceToPay')}</div>
		</div>`;
		expect(priceIn(usedApex)).toBeNull();
	});
});

describe('extractTitle', () => {
	it('title', () => {
		expect(extractTitle(parse('<span id="productTitle">  Foo &amp; Bar\n   Baz </span>'))).toBe(
			'Foo & Bar Baz'
		);
		expect(extractTitle(parse('<h1><span id="productTitle">Plain</span></h1>'))).toBe('Plain');
		expect(extractTitle(parse('<span id="title">Not the title</span>'))).toBeNull();
		expect(extractTitle(parse('<span id="productTitle"> \n\t </span>'))).toBeNull();
		expect(extractTitle(parse('<span id="productTitle"></span>'))).toBeNull();
	});
});

describe('extractImage', () => {
	const HIRES = 'https://m.media-amazon.com/images/I/81hires._AC_SL1500_.jpg';
	const SRC = 'https://m.media-amazon.com/images/I/81src._AC_SX425_.jpg';

	function imageOf(attributes: string): string | null {
		return extractImage(
			parse(`<div id="imgTagWrapperId"><img id="landingImage" ${attributes}></div>`)
		);
	}

	it('image', () => {
		expect(imageOf(`data-old-hires="${HIRES}" src="${SRC}"`)).toBe(HIRES);
		expect(imageOf(`data-old-hires="" src="${SRC}"`)).toBe(SRC);
		expect(imageOf(`src="${SRC}"`)).toBe(SRC);
		expect(imageOf(`data-old-hires="  ${HIRES} " src="${SRC}"`)).toBe(HIRES);
		// A non-https hi-res still falls back to an https src.
		expect(imageOf(`data-old-hires="http://m.media-amazon.com/a.jpg" src="${SRC}"`)).toBe(SRC);

		expect(imageOf('src="data:image/gif;base64,R0lGODlhAQABAAAAACw="')).toBeNull();
		expect(
			imageOf('data-old-hires="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="')
		).toBeNull();
		expect(imageOf('src="http://m.media-amazon.com/images/I/81src.jpg"')).toBeNull();
		expect(imageOf('src="not a url"')).toBeNull();
		expect(imageOf('')).toBeNull();
		expect(extractImage(parse('<img id="otherImage" src="' + SRC + '">'))).toBeNull();
		expect(extractImage(parse(''))).toBeNull();
	});
});
