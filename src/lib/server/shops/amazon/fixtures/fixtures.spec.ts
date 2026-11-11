import { describe, expect, it } from 'vitest';
import { parse } from 'node-html-parser';
import { parsePence } from '../extract.ts';
import { FIXTURES, type FixtureShape } from './manifest.ts';

// Every fixture page in this directory, as raw text, keyed by name without .html.
const files = Object.fromEntries(
	Object.entries(
		// Stryker disable next-line all: import.meta.glob needs literal args for Vite's static transform
		import.meta.glob<string>('./*.html', { query: '?raw', import: 'default', eager: true })
	).map(([path, html]) => [path.replace(/^\.\//, '').replace(/\.html$/, ''), html])
);

const SYNTHETIC_MARKER = '<!-- synthetic:';

function html(name: string): string {
	const text = files[name];
	if (text === undefined) throw new Error(`no fixture file ${name}.html`);
	return text;
}

/** The page markup without the leading provenance comment, which names prices itself. */
function markup(name: string): string {
	const text = html(name);
	return text.startsWith(SYNTHETIC_MARKER) ? text.slice(text.indexOf('-->') + 3) : text;
}

function named(shape: FixtureShape) {
	return Object.entries(FIXTURES).filter(([, entry]) => entry.shape === shape);
}

/** '£1,299.00' for 129900: the exact text a page shows for that price. */
function formatPence(pence: number): string {
	const pounds = Math.floor(pence / 100).toLocaleString('en-GB');
	return `£${pounds}.${String(pence % 100).padStart(2, '0')}`;
}

function expectedPence(name: string): number {
	const expected = FIXTURES[name].expect;
	if (!expected.ok) throw new Error(`${name} is not an ok fixture`);
	return expected.pricePence;
}

describe('amazon fixtures', () => {
	it('bijection', () => {
		const orphanFiles = Object.keys(files).filter((name) => !(name in FIXTURES));
		const orphanEntries = Object.keys(FIXTURES).filter((name) => !(name in files));

		expect(orphanFiles, 'fixture files with no manifest entry').toEqual([]);
		expect(orphanEntries, 'manifest entries with no fixture file').toEqual([]);
		expect(Object.keys(files).length).toBeGreaterThan(0);
	});

	it('provenance', () => {
		for (const [name, entry] of Object.entries(FIXTURES)) {
			if (entry.provenance === 'synthetic') {
				expect(html(name).startsWith(SYNTHETIC_MARKER), name).toBe(true);
			} else {
				expect(html(name).includes(SYNTHETIC_MARKER), name).toBe(false);
			}
		}
	});

	it('required set', () => {
		const okWith = (shape: FixtureShape) => named(shape).filter(([, e]) => e.expect.ok);
		for (const shape of ['plain', 'deal', 'over-1000'] as const) {
			expect(okWith(shape).length, `ok ${shape} fixture`).toBeGreaterThan(0);
		}
		expect(
			Object.values(FIXTURES).some((e) => e.expect.ok && e.expect.imageUrl === null),
			'ok fixture with no image'
		).toBe(true);

		const failing = (shape: FixtureShape) =>
			named(shape).map(([, e]) => (e.expect.ok ? null : e.expect));
		expect(failing('captcha')).toContainEqual(expect.objectContaining({ reason: 'blocked' }));
		expect(failing('out-of-stock')).toContainEqual(
			expect.objectContaining({ reason: 'unavailable' })
		);
		expect(failing('no-buy-box')).toContainEqual({
			ok: false,
			reason: 'unavailable',
			message: 'no buy-box offer'
		});
		expect(failing('variant-parent')).toContainEqual(
			expect.objectContaining({ reason: 'variant_required' })
		);
		expect(failing('no-price')).toContainEqual(expect.objectContaining({ reason: 'parse_failed' }));
	});

	it('traps armed', () => {
		// Deal: the struck-through RRP precedes the buy price and is higher.
		const deal = markup('synthetic-deal');
		const rrp = parse(deal).querySelector('.a-text-price .a-offscreen');
		const rrpPence = rrp === null ? null : parsePence(rrp.text);
		const dealPrice = formatPence(expectedPence('synthetic-deal'));
		expect(rrpPence).not.toBeNull();
		expect(rrpPence).toBeGreaterThan(expectedPence('synthetic-deal'));
		expect(deal.indexOf(rrp?.text ?? '')).toBeLessThan(deal.indexOf(dealPrice));

		// Plain: the voucher, Subscribe & Save and used prices all come first.
		const plain = markup('synthetic-plain');
		const plainPrice = formatPence(expectedPence('synthetic-plain'));
		expect(plainPrice).toBe('£19.99');
		const plainRoot = parse(plain);
		const decoys = [
			plainRoot.querySelector('#promoPriceBlockMessage_feature_div')?.text,
			plainRoot.querySelector('#snsAccordionRowMiddle .a-offscreen')?.text,
			plainRoot.querySelector('#usedAccordionRow .a-offscreen')?.text
		];
		expect(decoys).toEqual([expect.stringContaining('£2.00'), '£17.99', '£12.00']);
		for (const decoy of ['£2.00 voucher', '£17.99', '£12.00']) {
			expect(plain.indexOf(decoy), decoy).toBeGreaterThan(-1);
			expect(plain.indexOf(decoy), decoy).toBeLessThan(plain.indexOf(plainPrice));
		}

		// Over-1000: four figures with a thousands separator.
		const over = expectedPence('synthetic-over-1000');
		expect(over).toBeGreaterThanOrEqual(100000);
		expect(markup('synthetic-over-1000')).toContain(formatPence(over));
		expect(formatPence(over)).toContain(',');
	});

	it('c-3 recorded set', () => {
		const recordedOk = (shape: FixtureShape) =>
			named(shape).filter(([, e]) => e.provenance === 'recorded' && e.expect.ok);

		// A missing shape fails here; it never skips.
		for (const shape of ['plain', 'deal', 'over-1000'] as const) {
			const entries = recordedOk(shape);
			expect(entries.length, `recorded ok ${shape} fixture`).toBeGreaterThan(0);
			for (const [name] of entries) expect(files[name], `${name}.html present`).toBeDefined();
		}

		expect(
			recordedOk('over-1000').some(([name]) => expectedPence(name) >= 100000),
			'recorded price >= £1,000'
		).toBe(true);

		// The recorded deal shows a struck-through RRP in the buy box, above the buy price.
		const dealsWithRrp = recordedOk('deal').filter(([name]) => {
			const buyBox = parse(markup(name)).querySelectorAll(
				'#corePrice_feature_div, #corePriceDisplay_desktop_feature_div, #apex_desktop'
			);
			return buyBox.some((container) =>
				container
					.querySelectorAll('.a-text-price .a-offscreen')
					.some((rrp) => (parsePence(rrp.text) ?? 0) > expectedPence(name))
			);
		});
		expect(dealsWithRrp.length, 'recorded deal with an RRP above its buy price').toBeGreaterThan(0);
	});

	it('recorded hygiene', () => {
		// A cookie token with a value; an empty `session-id=` assignment in page JS is fine.
		const SESSION_TOKEN = /(?:session-id|ubid-acbuk)=[\w-]{6,}/i;
		expect(SESSION_TOKEN.test('session-id=262-1234567-7654321')).toBe(true);
		expect(SESSION_TOKEN.test('ubid-acbuk=259-7654321-1234567')).toBe(true);
		expect(SESSION_TOKEN.test('document.cookie = "session-id=; expires=0"')).toBe(false);
		expect(`${SYNTHETIC_MARKER} hand-built -->`.includes(SYNTHETIC_MARKER)).toBe(true);

		const recorded = Object.entries(FIXTURES).filter(([, e]) => e.provenance === 'recorded');
		expect(recorded.length).toBeGreaterThan(0);

		for (const [name, entry] of Object.entries(FIXTURES)) {
			expect(name.startsWith(`${entry.provenance}-`), `${name} named for its provenance`).toBe(
				true
			);
		}
		for (const [name] of recorded) {
			const body = html(name);
			// Booleans only: a failure message must never echo the token itself.
			expect(SESSION_TOKEN.test(body), `${name} embeds a session token`).toBe(false);
			expect(body.includes(SYNTHETIC_MARKER), `${name} carries the synthetic marker`).toBe(false);
		}
	});

	it('decoys present', () => {
		for (const name of [
			'synthetic-unavailable',
			'synthetic-no-buy-box',
			'synthetic-variant-parent'
		]) {
			const body = parse(html(name)).querySelector('body')?.text ?? '';
			expect(body, name).toMatch(/£\d/);
		}
	});
});
