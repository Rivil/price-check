/**
 * Token parsing and WCAG 2.x contrast maths. Used by tokens.spec.ts to prove the
 * palette in tokens.css, and by the e2e a11y helpers on getComputedStyle output.
 */

export type Rgb = { r: number; g: number; b: number };

/** A parsed CSS colour: an opaque sRGB value, or fully transparent. */
export type ParsedColour = ({ kind: 'opaque' } & Rgb) | { kind: 'transparent' };

export type Tokens = Record<string, string>;

/** Light `:root` custom properties and the dark-scheme overrides, as written. */
export type ParsedTokens = { light: Tokens; dark: Tokens };

const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
// rgb()/rgba() in comma or space syntax, optional alpha (number or percentage).
const RGB_FN =
	/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*(?:[,/]\s*(\d*\.?\d+%?)\s*)?\)$/i;

function channel(text: string, value: string): number {
	// RGB_FN only captures unsigned decimals, so n is always finite and >= 0.
	const n = Number(text);
	if (n > 255) {
		throw new Error(`Unsupported colour "${value}": channel ${text} out of range`);
	}
	return Math.round(n);
}

/**
 * Parse a colour as written in tokens.css (#rrggbb) or as returned by
 * getComputedStyle (rgb()/rgba()). Throws on anything else — including a partial
 * alpha, since contrast against a translucent colour depends on what is beneath it.
 */
export function parseColour(value: string): ParsedColour {
	const v = value.trim();
	if (v.toLowerCase() === 'transparent') return { kind: 'transparent' };

	const hex = HEX6.exec(v) ?? HEX3.exec(v);
	if (hex) {
		const [r, g, b] = hex.slice(1, 4).map((h) => parseInt(h.length === 1 ? h + h : h, 16));
		return { kind: 'opaque', r, g, b };
	}

	const fn = RGB_FN.exec(v);
	if (fn) {
		const [, r, g, b, alphaText] = fn;
		if (alphaText !== undefined) {
			const alpha = alphaText.endsWith('%')
				? Number(alphaText.slice(0, -1)) / 100
				: Number(alphaText);
			if (alpha === 0) return { kind: 'transparent' };
			if (alpha !== 1) {
				throw new Error(`Unsupported colour "${value}": partial alpha ${alphaText}`);
			}
		}
		return { kind: 'opaque', r: channel(r, v), g: channel(g, v), b: channel(b, v) };
	}

	throw new Error(`Unsupported colour "${value}"`);
}

function toRgb(colour: string | Rgb): Rgb {
	if (typeof colour !== 'string') return colour;
	const parsed = parseColour(colour);
	if (parsed.kind === 'transparent') {
		throw new Error(`Cannot measure contrast against transparent "${colour}"`);
	}
	return parsed;
}

function linear(c: number): number {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(colour: string | Rgb): number {
	const { r, g, b } = toRgb(colour);
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.x contrast ratio, 1–21, order-independent. */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Index of the `}` closing the block whose `{` is at `open`. */
function blockEnd(css: string, open: number): number {
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === '{') depth++;
		else if (css[i] === '}' && --depth === 0) return i;
	}
	throw new Error('Unbalanced braces in tokens CSS');
}

function declarations(body: string): Tokens {
	const out: Tokens = {};
	for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
		out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
	}
	return out;
}

function rootBody(css: string, from: number, to: number): string | null {
	const at = css.slice(from, to).search(/:root\s*\{/);
	if (at === -1) return null;
	const open = css.indexOf('{', from + at);
	return css.slice(open + 1, blockEnd(css, open));
}

/**
 * Parse tokens.css: the top-level `:root` block is the light scheme; the `:root`
 * inside `@media (prefers-color-scheme: dark)` holds the dark overrides.
 */
export function parseTokens(source: string): ParsedTokens {
	const css = stripComments(source);

	let dark: Tokens = {};
	let rest = css;
	const media = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/.exec(css);
	if (media) {
		const open = media.index + media[0].length - 1;
		const close = blockEnd(css, open);
		dark = declarations(rootBody(css, open + 1, close) ?? '');
		rest = css.slice(0, media.index) + css.slice(close + 1);
	}

	const light = rootBody(rest, 0, rest.length);
	return { light: declarations(light ?? ''), dark };
}

/** The effective tokens for a scheme: light, with the dark overrides applied for dark. */
export function schemeTokens(parsed: ParsedTokens, scheme: 'light' | 'dark'): Tokens {
	return scheme === 'light' ? { ...parsed.light } : { ...parsed.light, ...parsed.dark };
}
