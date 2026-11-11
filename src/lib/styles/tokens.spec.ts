import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	contrastRatio,
	parseColour,
	parseTokens,
	relativeLuminance,
	schemeTokens
} from './tokens.ts';

const source = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const parsed = parseTokens(source);
const schemes = ['light', 'dark'] as const;

const COLOUR_TOKENS = [
	'--bg',
	'--surface',
	'--text',
	'--text-muted',
	'--accent',
	'--accent-text',
	'--border',
	'--focus',
	'--ok',
	'--danger'
];

const isColourValue = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

describe('tokens present', () => {
	it.each(COLOUR_TOKENS)('%s is an opaque #rrggbb in light :root', (name) => {
		expect(parsed.light[name], `${name} missing from light :root`).toMatch(/^#[0-9a-f]{6}$/i);
	});

	it('font token is a system font stack', () => {
		expect(parsed.light['--font-sans']).toMatch(/system-ui/);
		expect(parsed.light['--font-sans']).toMatch(/sans-serif$/);
	});

	it('spacing scale --space-1..--space-6 is defined and ascending', () => {
		const rems = [1, 2, 3, 4, 5, 6].map((n) => {
			const value = parsed.light[`--space-${n}`];
			expect(value, `--space-${n} missing`).toMatch(/^\d*\.?\d+rem$/);
			return parseFloat(value);
		});
		expect(rems).toStrictEqual([...rems].sort((a, b) => a - b));
	});
});

describe('token parity', () => {
	it('every light colour token is redefined in the dark block', () => {
		const lightColours = Object.keys(parsed.light).filter((k) => isColourValue(parsed.light[k]));
		const missing = lightColours.filter((k) => !(k in parsed.dark));
		expect(missing, 'light colour tokens with no dark value').toStrictEqual([]);
	});

	it('the dark block only redefines light colour tokens', () => {
		const extra = Object.keys(parsed.dark).filter(
			(k) => !(k in parsed.light) || !isColourValue(parsed.dark[k])
		);
		expect(extra, 'dark tokens with no light colour counterpart').toStrictEqual([]);
	});

	it('parity check catches a one-sided token', () => {
		const lopsided = parseTokens(`
			:root { --bg: #ffffff; --extra: #000000; }
			@media (prefers-color-scheme: dark) { :root { --bg: #000000; --only-dark: #111111; } }
		`);
		expect(Object.keys(lopsided.light).filter((k) => !(k in lopsided.dark))).toStrictEqual([
			'--extra'
		]);
		expect(Object.keys(lopsided.dark).filter((k) => !(k in lopsided.light))).toStrictEqual([
			'--only-dark'
		]);
	});
});

describe('token contrast', () => {
	const text = ['--text', '--text-muted', '--accent', '--danger', '--ok'];
	const nonText = ['--border', '--focus'];
	const grounds = ['--bg', '--surface'];

	const pairs = schemes.flatMap((scheme) => [
		...text.flatMap((fg) => grounds.map((bg) => ({ scheme, fg, bg, min: 4.5 }))),
		{ scheme, fg: '--accent-text', bg: '--accent', min: 4.5 },
		...nonText.flatMap((fg) => grounds.map((bg) => ({ scheme, fg, bg, min: 3 })))
	]);

	it.each(pairs)('$scheme: $fg on $bg >= $min:1', ({ scheme, fg, bg, min }) => {
		const t = schemeTokens(parsed, scheme);
		const ratio = contrastRatio(t[fg], t[bg]);
		expect(ratio, `${fg} on ${bg} in ${scheme} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
			min
		);
	});
});

describe('contrast math', () => {
	it('black on white is 21:1', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
		expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 10);
	});

	it('is order-independent and 1:1 for identical colours', () => {
		expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 10);
		expect(contrastRatio('#0b5cad', '#0b5cad')).toBe(1);
	});

	it('#767676 on white passes 4.5:1, #777777 does not', () => {
		expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
	});

	it('accepts rgb() channels', () => {
		expect(contrastRatio('rgb(0, 0, 0)', { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 10);
	});

	it('refuses to measure against transparent', () => {
		expect(() => contrastRatio('transparent', '#ffffff')).toThrow(/transparent/);
	});
});

describe('parse colour', () => {
	it.each([
		['#0b5cad', { kind: 'opaque', r: 11, g: 92, b: 173 }],
		['#FFFFFF', { kind: 'opaque', r: 255, g: 255, b: 255 }],
		['rgb(11, 92, 173)', { kind: 'opaque', r: 11, g: 92, b: 173 }],
		['rgba(11, 92, 173, 1)', { kind: 'opaque', r: 11, g: 92, b: 173 }],
		['rgb(11 92 173)', { kind: 'opaque', r: 11, g: 92, b: 173 }],
		['rgba(0, 0, 0, 0)', { kind: 'transparent' }],
		['rgba(255, 255, 255, 0)', { kind: 'transparent' }],
		['transparent', { kind: 'transparent' }]
	])('%s', (input, expected) => {
		expect(parseColour(input)).toStrictEqual(expected);
	});

	it.each(['rgba(0, 0, 0, 0.5)', 'rgba(11, 92, 173, 0.99)', 'rgb(0 0 0 / 50%)'])(
		'rejects partial alpha %s',
		(input) => {
			expect(() => parseColour(input)).toThrow(/partial alpha/);
		}
	);

	it.each(['red', 'hsl(0, 0%, 0%)', '#12345', 'rgb(300, 0, 0)', ''])(
		'rejects unsupported %s',
		(input) => {
			expect(() => parseColour(input)).toThrow(/Unsupported colour/);
		}
	);
});

// Inputs beyond the repo's own tokens.css. Every parse runs inside a test, so a
// mutant in the parser is measured per test rather than once at import time.
describe('parse colour edge input', () => {
	it.each([
		['rgb(255, 255, 255)', { kind: 'opaque', r: 255, g: 255, b: 255 }],
		[' #fff ', { kind: 'opaque', r: 255, g: 255, b: 255 }],
		['RGB(11,92,173)', { kind: 'opaque', r: 11, g: 92, b: 173 }],
		['rgb( 11 , 92 , 173 )', { kind: 'opaque', r: 11, g: 92, b: 173 }],
		['rgb(10.25, 20.25, 30.75)', { kind: 'opaque', r: 10, g: 20, b: 31 }],
		['rgb(11 92 173 / 100%)', { kind: 'opaque', r: 11, g: 92, b: 173 }],
		['rgb(11 92 173 / 0%)', { kind: 'transparent' }]
	])('%s', (input, expected) => {
		expect(parseColour(input)).toStrictEqual(expected);
	});

	it.each(['x#0b5cad', '#0b5cad00', 'x#fff', 'xrgb(0, 0, 0)', 'rgb(0, 0, 0)x', 'rgb(256, 0, 0)'])(
		'rejects %s',
		(input) => {
			expect(() => parseColour(input)).toThrow(/Unsupported colour/);
		}
	);

	it('dark channels use the linear sRGB segment', () => {
		expect(relativeLuminance('#0a0a0a')).toBeCloseTo(10 / 255 / 12.92, 12);
	});
});

describe('parse tokens edge input', () => {
	it('compact :root and dark block', () => {
		const css =
			':root{--a:#111111;--b : #222222 ;}@media(prefers-color-scheme:dark){:root{--a:#333333;}}';
		expect(parseTokens(css)).toStrictEqual({
			light: { '--a': '#111111', '--b': '#222222' },
			dark: { '--a': '#333333' }
		});
	});

	it('spacious dark block written before the light :root', () => {
		const css = [
			'@media  ( prefers-color-scheme : dark )  {',
			'  :root {',
			'    --a: #333333;',
			'  }',
			'}',
			':root {',
			'  --a: #111111;',
			'  --font: system-ui,',
			'    sans-serif;',
			'}'
		].join('\n');
		expect(parseTokens(css)).toStrictEqual({
			light: { '--a': '#111111', '--font': 'system-ui, sans-serif' },
			dark: { '--a': '#333333' }
		});
	});

	it('ignores comments, including one inside a value and one holding a fake :root', () => {
		const css = '/* :root { --ghost: #000000; } */\n:root {\n  --a: /* note */ #111111;\n}';
		expect(parseTokens(css)).toStrictEqual({ light: { '--a': '#111111' }, dark: {} });
	});

	it('no :root anywhere yields no tokens', () => {
		expect(parseTokens('')).toStrictEqual({ light: {}, dark: {} });
		expect(
			parseTokens('@media (prefers-color-scheme: dark) { .x { --a: #000000; } }')
		).toStrictEqual({ light: {}, dark: {} });
	});

	it('refuses unbalanced braces', () => {
		expect(() => parseTokens(':root { --a: #111111;')).toThrow(/Unbalanced braces/);
	});

	it('schemeTokens applies dark overrides only for dark', () => {
		const tokens = { light: { '--a': '1', '--b': '2' }, dark: { '--a': '3' } };
		expect(schemeTokens(tokens, 'light')).toStrictEqual({ '--a': '1', '--b': '2' });
		expect(schemeTokens(tokens, 'dark')).toStrictEqual({ '--a': '3', '--b': '2' });
	});
});
