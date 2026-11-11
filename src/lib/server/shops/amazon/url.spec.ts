import { describe, expect, it } from 'vitest';
import { normaliseAmazonUrl } from './url.ts';

const X = 'B0ABC12345';
const CANONICAL = `https://www.amazon.co.uk/dp/${X}`;

function expectUnsupported(input: string) {
	expect(normaliseAmazonUrl(input), input).toEqual({ kind: 'unsupported' });
}

describe('normaliseAmazonUrl', () => {
	it('canonical table', () => {
		const variants = [
			`https://www.amazon.co.uk/dp/${X}`,
			`https://www.amazon.co.uk/gp/product/${X}`,
			`https://www.amazon.co.uk/Some-Title-Here/dp/${X}`,
			`https://www.amazon.co.uk/dp/${X}/ref=sr_1_1`,
			`https://www.amazon.co.uk/Some-Title/dp/${X}/ref=sr_1_1?keywords=x&qid=1`,
			`https://www.amazon.co.uk/dp/${X}?tag=foo-21&psc=1&th=1`,
			`https://www.amazon.co.uk/gp/product/${X}?tag=foo-21&psc=1&th=1`,
			`https://www.amazon.co.uk/dp/${X}#customerReviews`,
			`https://www.amazon.co.uk/dp/${X}/`,
			`http://www.amazon.co.uk/dp/${X}`,
			`https://amazon.co.uk/dp/${X}`,
			`https://smile.amazon.co.uk/dp/${X}`,
			`https://WWW.AMAZON.CO.UK/dp/${X}`,
			`  https://www.amazon.co.uk/dp/${X}  `
		];

		for (const input of variants) {
			expect(normaliseAmazonUrl(input), input).toEqual({
				kind: 'product',
				asin: X,
				canonicalUrl: CANONICAL
			});
		}
	});

	it('asin shape', () => {
		expect(normaliseAmazonUrl('https://www.amazon.co.uk/dp/b0abc12345')).toEqual({
			kind: 'product',
			asin: 'B0ABC12345',
			canonicalUrl: 'https://www.amazon.co.uk/dp/B0ABC12345'
		});
		// Books use their ISBN-10 as the ASIN.
		expect(normaliseAmazonUrl('https://www.amazon.co.uk/dp/0123456789')).toEqual({
			kind: 'product',
			asin: '0123456789',
			canonicalUrl: 'https://www.amazon.co.uk/dp/0123456789'
		});
		expectUnsupported('https://www.amazon.co.uk/dp/B0ABC1234');
		expectUnsupported('https://www.amazon.co.uk/dp/B0ABC123456');
		expectUnsupported('https://www.amazon.co.uk/gp/product/B0ABC1234');
		expectUnsupported('https://www.amazon.co.uk/Title/dp/B0ABC123456');
		expectUnsupported('https://www.amazon.co.uk/dp/B0ABC-2345');
		expectUnsupported('https://www.amazon.co.uk/gp/product/');
	});

	it('host spoofing', () => {
		for (const input of [
			`https://amazon.co.uk.evil.com/dp/${X}`,
			`https://evilamazon.co.uk/dp/${X}`,
			`https://www.amazon.co.uk@evil.com/dp/${X}`,
			`https://user:pass@www.amazon.co.uk/dp/${X}`,
			`https://www.amazon.co.uk:8443/dp/${X}`,
			`https://m.amazon.co.uk/dp/${X}`,
			`https://www.amazon.com/dp/${X}`,
			`https://amazon.com/dp/${X}`,
			`https://www.amazon.de/dp/${X}`,
			`https://shop.example/dp/${X}`
		]) {
			expectUnsupported(input);
		}
	});

	it('non-product pages', () => {
		for (const input of [
			'https://www.amazon.co.uk/s?k=x&url=%2Fdp%2FB0ABC12345',
			`https://www.amazon.co.uk/?asin=${X}`,
			`https://www.amazon.co.uk/s?asin=${X}`,
			'https://www.amazon.co.uk/b?node=123',
			'https://www.amazon.co.uk/gp/bestsellers',
			'https://www.amazon.co.uk/stores/Brand/page/0A1B2C3D-0000-1111-2222-333344445555',
			'https://www.amazon.co.uk/gp/cart/view.html',
			'https://www.amazon.co.uk/',
			`https://www.amazon.co.uk/#/dp/${X}`
		]) {
			expectUnsupported(input);
		}
	});

	it('non-product paths', () => {
		// Only /dp/<ASIN>, /gp/product/<ASIN> and /<slug>/dp/<ASIN> carry a product.
		for (const input of [
			`https://www.amazon.co.uk/gp/offer-listing/${X}`,
			`https://www.amazon.co.uk/gp/aw/${X}`,
			`https://www.amazon.co.uk/Slug/product/${X}`,
			`https://www.amazon.co.uk/Slug/gp/${X}`,
			`https://www.amazon.co.uk/a/b/${X}`
		]) {
			expectUnsupported(input);
		}
		for (const input of [
			`https://www.amazon.co.uk/gp/product/${X}`,
			`https://www.amazon.co.uk/Slug/dp/${X}`
		]) {
			expect(normaliseAmazonUrl(input), input).toEqual({
				kind: 'product',
				asin: X,
				canonicalUrl: CANONICAL
			});
		}
	});

	it('credentials', () => {
		// Either credential part alone is still a credential.
		expectUnsupported(`https://user@www.amazon.co.uk/dp/${X}`);
		expectUnsupported(`https://:pw@www.amazon.co.uk/dp/${X}`);
	});

	it('garbage input', () => {
		for (const input of [
			'',
			'   ',
			'not a url',
			'javascript:alert(1)',
			`ftp://www.amazon.co.uk/dp/${X}`,
			`file:///dp/${X}`,
			`data:text/html,https://www.amazon.co.uk/dp/${X}`,
			X
		]) {
			expect(() => normaliseAmazonUrl(input), input).not.toThrow();
			expectUnsupported(input);
		}
	});

	it('short links', () => {
		expect(normaliseAmazonUrl('https://amzn.eu/d/AbC123')).toEqual({
			kind: 'short',
			url: 'https://amzn.eu/d/AbC123'
		});
		expect(normaliseAmazonUrl('https://amzn.to/3xYz')).toEqual({
			kind: 'short',
			url: 'https://amzn.to/3xYz'
		});
		expectUnsupported('https://amzn.eu/');
		expectUnsupported('https://amzn.eu/d/');
		expectUnsupported('https://amzn.to/');
		expectUnsupported('https://amzn.com/dp/B0ABC12345');
		expectUnsupported('https://amzn.com/3xYz');
		expectUnsupported('https://amzn.eu.evil.com/d/AbC123');
		expectUnsupported('ftp://amzn.to/3xYz');
	});
});
