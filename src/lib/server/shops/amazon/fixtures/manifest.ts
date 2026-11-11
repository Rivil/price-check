// The Amazon fixture corpus: one entry per <name>.html in this directory, and the
// outcome a check must produce for it. Data only. Tests run every entry, so a
// recorded page added here joins the classification table automatically.
import type { FailureReason } from '../../types.ts';

export type FixtureShape =
	| 'plain'
	| 'deal'
	| 'over-1000'
	| 'no-image'
	| 'captcha'
	| 'out-of-stock'
	| 'no-buy-box'
	| 'variant-parent'
	| 'no-price';

export type FixtureExpect =
	| { ok: true; title: string; pricePence: number; imageUrl: string | null }
	| { ok: false; reason: Exclude<FailureReason, 'unsupported'>; message?: string };

export type FixtureEntry = {
	/** synthetic: hand-built, opens with `<!-- synthetic:`; recorded: saved by adapter:check. */
	provenance: 'synthetic' | 'recorded';
	shape: FixtureShape;
	expect: FixtureExpect;
};

export const FIXTURES: Record<string, FixtureEntry> = {
	'synthetic-plain': {
		provenance: 'synthetic',
		shape: 'plain',
		expect: {
			ok: true,
			title: 'Acme Stainless Steel Water Bottle 750ml & Carry Loop',
			pricePence: 1999,
			imageUrl: 'https://m.media-amazon.com/images/I/71TestPlnA._AC_SL1500_.jpg'
		}
	},
	'synthetic-deal': {
		provenance: 'synthetic',
		shape: 'deal',
		expect: {
			ok: true,
			title: 'Acme Wireless Over-Ear Headphones, 40h Battery',
			pricePence: 2999,
			imageUrl: 'https://m.media-amazon.com/images/I/61TestDelA._AC_SL1500_.jpg'
		}
	},
	'synthetic-over-1000': {
		provenance: 'synthetic',
		shape: 'over-1000',
		expect: {
			ok: true,
			title: 'Acme 65 Inch 4K OLED Smart TV',
			pricePence: 129900,
			imageUrl: 'https://m.media-amazon.com/images/I/81TestK00A._AC_SL1500_.jpg'
		}
	},
	'synthetic-no-image': {
		provenance: 'synthetic',
		shape: 'no-image',
		expect: { ok: true, title: 'Acme AA Batteries, Pack of 12', pricePence: 849, imageUrl: null }
	},
	'synthetic-captcha': {
		provenance: 'synthetic',
		shape: 'captcha',
		expect: { ok: false, reason: 'blocked' }
	},
	'synthetic-unavailable': {
		provenance: 'synthetic',
		shape: 'out-of-stock',
		expect: { ok: false, reason: 'unavailable', message: 'currently unavailable' }
	},
	'synthetic-no-buy-box': {
		provenance: 'synthetic',
		shape: 'no-buy-box',
		expect: { ok: false, reason: 'unavailable', message: 'no buy-box offer' }
	},
	'synthetic-variant-parent': {
		provenance: 'synthetic',
		shape: 'variant-parent',
		expect: { ok: false, reason: 'variant_required' }
	},
	'synthetic-no-price': {
		provenance: 'synthetic',
		shape: 'no-price',
		expect: { ok: false, reason: 'parse_failed' }
	},

	// Recorded: saved raw by adapter:check; expectations read by a human from the
	// saved page in a browser, never from the CLI output.
	'recorded-plain': {
		provenance: 'recorded',
		shape: 'plain',
		expect: {
			ok: true,
			title: 'Tassimo Kenco Americano Grande XL Coffee Pods x16 (Pack of 5, Total 80 Drinks)',
			pricePence: 1899,
			imageUrl: 'https://m.media-amazon.com/images/I/61GpRnRev8L._AC_SL1000_.jpg'
		}
	},
	'recorded-plain2': {
		provenance: 'recorded',
		shape: 'plain',
		expect: {
			ok: true,
			title:
				'GREENER WALKER Poo Bags for Dog Waste, 540 Extra Thick Strong 100% Leak Proof Biodegradable Dog Poo Bags (Green)',
			pricePence: 1428,
			imageUrl: 'https://m.media-amazon.com/images/I/71INpRu5oqL._AC_SL1500_.jpg'
		}
	},
	'recorded-over-1000': {
		provenance: 'recorded',
		shape: 'over-1000',
		expect: {
			ok: true,
			title: 'Apple MacBook Pro 14.2-inch Laptop with M6 chip, 1TB SSD; Space Grey',
			pricePence: 219900,
			imageUrl: 'https://m.media-amazon.com/images/I/61uR4PwJCcL._AC_SL1500_.jpg'
		}
	},
	'recorded-parent2-variant': {
		provenance: 'recorded',
		shape: 'plain',
		expect: {
			ok: true,
			title:
				'Strongway® Multi Gym with Weights 72KG 100KG Weight Stack Included - Multifunction Home Gym Cable Pulley Preacher Pad Butterfly Press Strength Training',
			pricePence: 99900,
			// This page's #landingImage has no data-old-hires, so the src thumbnail is the image.
			imageUrl: 'https://m.media-amazon.com/images/I/4135PTZOFIL._AC_SY300_SX300_QL70_ML2_.jpg'
		}
	},
	'recorded-parent': {
		provenance: 'recorded',
		shape: 'variant-parent',
		expect: { ok: false, reason: 'variant_required' }
	},
	'recorded-parent2': {
		provenance: 'recorded',
		shape: 'variant-parent',
		expect: { ok: false, reason: 'variant_required' }
	},
	// The click-through wall: no captcha image, a form on /errors_page/, HTTP 200.
	'recorded-captcha-continue': {
		provenance: 'recorded',
		shape: 'captcha',
		expect: { ok: false, reason: 'blocked' }
	},
	'recorded-deal': {
		provenance: 'recorded',
		shape: 'deal',
		expect: {
			ok: true,
			title: 'INIU 45W Fast Charging Power Bank, 40% Smaller 10000mAh Portable Charger',
			pricePence: 2198,
			imageUrl: 'https://m.media-amazon.com/images/I/71S7sOrJfxL._AC_SL1500_.jpg'
		}
	}
};
