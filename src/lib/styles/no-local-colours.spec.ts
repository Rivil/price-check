/**
 * Guard for c-1: colour values live only in tokens.css. Scans src/ for colour
 * literals and scheme blocks outside it, and for literal spacing/type in
 * component <style> blocks (those must come from var(--space-*) / type tokens).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const TOKENS_FILE = 'tokens.css';
const SKIP_DIRS = new Set(['node_modules', 'build', '.svelte-kit']);
const SCANNED = /\.(svelte|css)$/;

/**
 * Files the guard reads: .svelte and .css under `root` (except tokens.css), plus
 * the root app.html. Other .html under src/ are recorded shop pages (r-01 fixtures).
 */
function scannedFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
			} else if (
				(SCANNED.test(entry.name) && entry.name !== TOKENS_FILE) ||
				(dir === root && entry.name === 'app.html')
			) {
				out.push(join(dir, entry.name));
			}
		}
	};
	walk(root);
	return out.sort();
}

// prettier-ignore
const NAMED_COLOURS = new Set([
	'aliceblue','antiquewhite','aqua','aquamarine','azure','beige','bisque','black','blanchedalmond',
	'blue','blueviolet','brown','burlywood','cadetblue','chartreuse','chocolate','coral',
	'cornflowerblue','cornsilk','crimson','cyan','darkblue','darkcyan','darkgoldenrod','darkgray',
	'darkgreen','darkgrey','darkkhaki','darkmagenta','darkolivegreen','darkorange','darkorchid',
	'darkred','darksalmon','darkseagreen','darkslateblue','darkslategray','darkslategrey',
	'darkturquoise','darkviolet','deeppink','deepskyblue','dimgray','dimgrey','dodgerblue',
	'firebrick','floralwhite','forestgreen','fuchsia','gainsboro','ghostwhite','gold','goldenrod',
	'gray','green','greenyellow','grey','honeydew','hotpink','indianred','indigo','ivory','khaki',
	'lavender','lavenderblush','lawngreen','lemonchiffon','lightblue','lightcoral','lightcyan',
	'lightgoldenrodyellow','lightgray','lightgreen','lightgrey','lightpink','lightsalmon',
	'lightseagreen','lightskyblue','lightslategray','lightslategrey','lightsteelblue','lightyellow',
	'lime','limegreen','linen','magenta','maroon','mediumaquamarine','mediumblue','mediumorchid',
	'mediumpurple','mediumseagreen','mediumslateblue','mediumspringgreen','mediumturquoise',
	'mediumvioletred','midnightblue','mintcream','mistyrose','moccasin','navajowhite','navy',
	'oldlace','olive','olivedrab','orange','orangered','orchid','palegoldenrod','palegreen',
	'paleturquoise','palevioletred','papayawhip','peachpuff','peru','pink','plum','powderblue',
	'purple','rebeccapurple','red','rosybrown','royalblue','saddlebrown','salmon','sandybrown',
	'seagreen','seashell','sienna','silver','skyblue','slateblue','slategray','slategrey','snow',
	'springgreen','steelblue','tan','teal','thistle','tomato','turquoise','violet','wheat','white',
	'whitesmoke','yellow','yellowgreen',
	// CSS system colours resolve to UA palette values, not tokens.
	'canvas','canvastext','linktext','visitedtext','activetext','buttonface','buttontext',
	'buttonborder','field','fieldtext','highlight','highlighttext','graytext','mark','marktext',
	'accentcolor','accentcolortext'
]);

const HEX = /#[0-9a-f]{3,8}\b/i;
const COLOUR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\(/i;
// Properties whose values can carry a named colour keyword.
const COLOUR_PROP =
	/(?:^|-)(?:color|background|border|outline|fill|stroke|shadow|caret|decoration|rule)(?:-|$)|^(?:color|background|border|outline|fill|stroke)$/;
// SVG presentation attributes that take a colour, as a whitespace-preceded markup attribute.
const COLOUR_ATTR =
	/(?<=\s)(fill|stroke|color|stop-color|flood-color|lighting-color)\s*=\s*(["'])([\s\S]*?)\2/gi;
const SPACING_TYPE_PROP =
	/^(?:gap|row-gap|column-gap|margin(?:-[a-z-]+)?|padding(?:-[a-z-]+)?|font-size|font-family)$/;

type Finding = { line: number; rule: 'colour' | 'scheme' | 'spacing-type'; text: string };

/** Replace comments with spaces so offsets (and line numbers) survive. */
function blankComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

function lineAt(source: string, offset: number): number {
	return source.slice(0, offset).split('\n').length;
}

function colourIn(prop: string, value: string): string | null {
	// Custom-property references are tokens, not literals: drop `var(--name)` with no fallback.
	const bare = value.replace(/var\(\s*--[\w-]+\s*\)/g, ' ').replace(/(['"]).*?\1/g, ' ');
	const hex = HEX.exec(bare);
	if (hex) return hex[0];
	const fn = COLOUR_FN.exec(bare);
	if (fn) return fn[0];
	if (prop.startsWith('--') || COLOUR_PROP.test(prop)) {
		for (const word of bare.match(/(?<![-\w])[a-z]+(?![-\w(])/gi) ?? []) {
			if (NAMED_COLOURS.has(word.toLowerCase())) return word;
		}
	}
	return null;
}

function spacingTypeLiteral(value: string): boolean {
	return (
		value
			.replace(/var\(\s*--[\w-]+\s*\)/g, ' ')
			.replace(/\b(?:0|auto)\b/g, ' ')
			.trim() !== ''
	);
}

/**
 * Check one stretch of CSS (a stylesheet, a <style> body or an inline style)
 * that starts at `base` in `source`.
 */
function scanCss(
	source: string,
	css: string,
	base: number,
	opts: { spacingType: boolean; inline: boolean }
): Finding[] {
	const text = blankComments(css);
	const found: Finding[] = [];

	for (const m of text.matchAll(/prefers-color-scheme/g)) {
		found.push({ line: lineAt(source, base + m.index), rule: 'scheme', text: m[0] });
	}

	// A declaration: after `{`, `;` or (inline) the start, ending at `;` or `}` / end.
	const decl = opts.inline
		? /(?:^|;)\s*([-\w]+)\s*:\s*([^;]+)/g
		: /(?<=[{;]\s*)([-\w]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g;
	for (const m of text.matchAll(decl)) {
		const prop = m[1].toLowerCase();
		const value = m[2].replace(/\s*!important\s*$/i, '').trim();
		const at = base + m.index + m[0].indexOf(m[1]);
		const colour = colourIn(prop, value);
		if (colour) found.push({ line: lineAt(source, at), rule: 'colour', text: `${prop}: ${value}` });
		if (opts.spacingType && SPACING_TYPE_PROP.test(prop) && spacingTypeLiteral(value)) {
			found.push({ line: lineAt(source, at), rule: 'spacing-type', text: `${prop}: ${value}` });
		}
	}
	return found;
}

/** All findings for one file's contents; `kind` decides how it is read. */
function scanSource(source: string, kind: 'svelte' | 'html' | 'css'): Finding[] {
	if (kind === 'css') return scanCss(source, source, 0, { spacingType: false, inline: false });

	const found: Finding[] = [];
	for (const m of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
		const base = m.index + m[0].indexOf('>') + 1;
		found.push(...scanCss(source, m[1], base, { spacingType: kind === 'svelte', inline: false }));
	}
	for (const m of source.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
		const base = m.index + m[0].indexOf(m[1]) + 1;
		found.push(...scanCss(source, m[2], base, { spacingType: false, inline: true }));
	}
	// Svelte style directives: style:color="red"
	for (const m of source.matchAll(/\bstyle:([-\w]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
		const colour = colourIn(m[1].toLowerCase(), m[3]);
		if (colour) found.push({ line: lineAt(source, m.index), rule: 'colour', text: m[0] });
	}
	// SVG colour presentation attributes in markup: <path fill="#c00">. Script and
	// style bodies are blanked first so `let color = 'red'` is not read as markup.
	const markup = source.replace(
		/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi,
		(_m, open: string, _tag: string, body: string, close: string) =>
			open + body.replace(/[^\n]/g, ' ') + close
	);
	for (const m of markup.matchAll(COLOUR_ATTR)) {
		// url(#id) references a paint server, not a colour (and #fade would read as hex).
		const colour = colourIn(m[1].toLowerCase(), m[3].replace(/url\([^)]*\)/gi, ' '));
		if (colour) found.push({ line: lineAt(source, m.index), rule: 'colour', text: m[0] });
	}
	return found.sort((a, b) => a.line - b.line);
}

function kindOf(file: string): 'svelte' | 'html' | 'css' {
	return file.endsWith('.svelte') ? 'svelte' : file.endsWith('.html') ? 'html' : 'css';
}

function scanTree(root: string): string[] {
	return scannedFiles(root).flatMap((file) =>
		scanSource(readFileSync(file, 'utf8'), kindOf(file)).map(
			(f) => `${relative(root, file)}:${f.line} [${f.rule}] ${f.text}`
		)
	);
}

describe('no local colours', () => {
	it('src/ holds no colour literal or scheme block outside tokens.css', () => {
		const offenders = scanTree(SRC).filter((f) => !f.includes('[spacing-type]'));
		expect(offenders).toStrictEqual([]);
	});

	it('the scan actually reads the app (not vacuous)', () => {
		const files = scannedFiles(SRC).map((f) => relative(SRC, f).split(sep).join('/'));
		expect(files).toContain('app.html');
		expect(files).toContain('routes/+page.svelte');
		expect(files).toContain('routes/watches/[id]/+page.svelte');
		expect(files).not.toContain('lib/styles/tokens.css');
	});

	const svelte = (css: string) => `<p>x</p>\n<style>\n\tp { ${css} }\n</style>\n`;

	it.each([
		['hex #rgb', 'color: #fff;'],
		['hex #rrggbb', 'background: #0b5cad;'],
		['hex #rrggbbaa', 'border-color: #00000080;'],
		['rgb()', 'color: rgb(0, 0, 0);'],
		['rgba()', 'background-color: rgba(0, 0, 0, 0.5);'],
		['hsl()', 'color: hsl(210 50% 40%);'],
		['hsla()', 'color: hsla(210, 50%, 40%, 1);'],
		['oklch()', 'color: oklch(60% 0.1 250);'],
		['named colour', 'color: red;'],
		['named colour in a shorthand', 'border: 1px solid tomato;'],
		['named colour in outline', 'outline: 2px solid black;'],
		['named colour as var() fallback', 'color: var(--text, navy);'],
		['system colour', 'background: Canvas;'],
		['local token redefinition', '--accent: #123456;']
	])('catches %s', (_name, css) => {
		const found = scanSource(svelte(css), 'svelte');
		expect(found.map((f) => [f.rule, f.line])).toContainEqual(['colour', 3]);
	});

	it('catches a colour in a .css file and in an inline style, naming the line', () => {
		expect(
			scanSource('a {\n\tcolor: var(--accent);\n}\nb {\n\tcolor: #f00;\n}\n', 'css')
		).toStrictEqual([{ line: 5, rule: 'colour', text: 'color: #f00' }]);
		expect(scanSource('<div>\n<p style="color: red">x</p>\n</div>', 'html')).toMatchObject([
			{ line: 2, rule: 'colour' }
		]);
		expect(scanSource('<p\n\tstyle:color="blue">x</p>', 'svelte')).toMatchObject([
			{ line: 2, rule: 'colour' }
		]);
	});

	it('catches a local prefers-color-scheme block', () => {
		const source =
			'<style>\n\t@media (prefers-color-scheme: dark) {\n\t\tp { color: var(--text); }\n\t}\n</style>';
		expect(scanSource(source, 'svelte')).toMatchObject([{ line: 2, rule: 'scheme' }]);
		expect(scanSource('@media (prefers-color-scheme: light) {}', 'css')).toMatchObject([
			{ line: 1, rule: 'scheme' }
		]);
	});

	it.each([
		'color: transparent;',
		'color: currentColor;',
		'border-color: currentcolor;',
		'color: inherit;',
		'background: none;',
		'color: initial;',
		'outline-color: unset;',
		'color: var(--text);',
		'border: var(--border-width) solid var(--border);'
	])('does not flag %s', (css) => {
		expect(scanSource(svelte(css), 'svelte')).toStrictEqual([]);
	});

	it("does not flag app.html's style='display: contents' or hex-looking selectors and markup", () => {
		expect(
			scanSource('<div style="display: contents">%sveltekit.body%</div>', 'html')
		).toStrictEqual([]);
		const markup =
			'{#each items as i}{#if i}<p>{i}</p>{/if}{/each}\n<style>\n\t#fade { opacity: 0; }\n\ta:hover { color: var(--accent); }\n</style>';
		expect(scanSource(markup, 'svelte')).toStrictEqual([]);
	});

	const icon = (attrs: string) =>
		`<p>x</p>\n<svg viewBox="0 0 8 8">\n\t<path d="M0 0h8" ${attrs} />\n</svg>\n`;

	it.each([
		['hex fill', 'fill="#c00"'],
		['named stroke', 'stroke="red"'],
		['rgb() stop-color', 'stop-color="rgb(0, 0, 0)"'],
		['single-quoted flood-color', "flood-color='tomato'"],
		['color attribute', 'color="#123456"']
	])('catches an SVG %s attribute, naming the line', (_name, attrs) => {
		expect(scanSource(icon(attrs), 'svelte')).toMatchObject([{ line: 3, rule: 'colour' }]);
		expect(scanSource(icon(attrs), 'html')).toMatchObject([{ line: 3, rule: 'colour' }]);
	});

	it.each([
		'fill="none"',
		'fill="currentColor"',
		'stroke="var(--accent)"',
		'fill="url(#fade)"',
		'stroke-width="2" stroke-linecap="round"',
		'fill={colour}'
	])('does not flag SVG %s', (attrs) => {
		expect(scanSource(icon(attrs), 'svelte')).toStrictEqual([]);
	});

	it('does not read script or style bodies as markup attributes', () => {
		const source =
			'<script>\n\tlet color = \'red\';\n\tconst fill = "#c00";\n</script>\n<p style:color="var(--text)">x</p>\n<style>\n\tp { color: var(--text); }\n</style>';
		expect(scanSource(source, 'svelte')).toStrictEqual([]);
	});

	it('ignores commented-out colours', () => {
		expect(scanSource(svelte('/* color: red; */ color: var(--text);'), 'svelte')).toStrictEqual([]);
	});
});

describe('no literal spacing or type', () => {
	it('component <style> blocks use spacing and type tokens only', () => {
		const offenders = scanTree(SRC).filter((f) => f.includes('[spacing-type]'));
		expect(offenders).toStrictEqual([]);
	});

	const svelte = (css: string) => `<p>x</p>\n<style>\n\tp {\n\t\t${css}\n\t}\n</style>\n`;

	it.each([
		'gap: 1rem;',
		'row-gap: 4px;',
		'margin: 1rem;',
		'margin-block: 1rem;',
		'margin-inline-start: 2px;',
		'padding: 0 1rem;',
		'padding-top: var(--space-2, 8px);',
		'font-size: 14px;',
		'font-size: calc(var(--text-base) * 2);',
		'font-family: Georgia, serif;'
	])('catches %s, naming the line', (css) => {
		expect(scanSource(svelte(css), 'svelte')).toMatchObject([{ line: 4, rule: 'spacing-type' }]);
	});

	it.each([
		'gap: var(--space-4);',
		'margin: 0;',
		'margin: 0 auto;',
		'margin-block: var(--space-4) 0;',
		'padding: var(--space-2) var(--space-3);',
		'font-size: var(--text-sm);',
		'font-family: var(--font-mono);',
		'width: 1px;',
		'list-style: none;'
	])('allows %s', (css) => {
		expect(scanSource(svelte(css), 'svelte')).toStrictEqual([]);
	});

	it('applies to .svelte only — base stylesheets may set literal type', () => {
		expect(scanSource('p { font-size: 1rem; }', 'css')).toStrictEqual([]);
	});
});

describe('scanner scope', () => {
	const root = mkdtempSync(join(tmpdir(), 'scanner-scope-'));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it('skips node_modules/, build/ and .svelte-kit/, and tokens.css', () => {
		for (const dir of [
			'node_modules/pkg',
			'build/client',
			'.svelte-kit/output',
			'lib/styles',
			'routes'
		]) {
			mkdirSync(join(root, dir), { recursive: true });
		}
		writeFileSync(join(root, 'node_modules/pkg/x.css'), 'a { color: red; }');
		writeFileSync(join(root, 'build/client/x.css'), 'a { color: red; }');
		writeFileSync(join(root, '.svelte-kit/output/x.svelte'), '<style>a { color: red; }</style>');
		writeFileSync(join(root, 'lib/styles/tokens.css'), ':root { --bg: #fff; }');
		writeFileSync(join(root, 'routes/ok.svelte'), '<p>x</p>');
		writeFileSync(join(root, 'routes/bad.css'), 'a { color: red; }');
		writeFileSync(join(root, 'routes/notes.ts'), "const c = '#fff';");
		writeFileSync(join(root, 'app.html'), '<div style="display: contents"></div>');
		writeFileSync(join(root, 'routes/recorded-page.html'), '<p style="color: red">x</p>');

		expect(scannedFiles(root).map((f) => relative(root, f).split(sep).join('/'))).toStrictEqual([
			'app.html',
			'routes/bad.css',
			'routes/ok.svelte'
		]);
		expect(scanTree(root)).toStrictEqual([`routes${sep}bad.css:1 [colour] color: red`]);
	});
});
