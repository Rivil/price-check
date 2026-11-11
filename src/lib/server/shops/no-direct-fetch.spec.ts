import { describe, expect, it } from 'vitest';

// Rule r-01: every live shop request goes through the rate-limited client. Every
// non-test source under the shop adapters and the CLIs, as raw text; only
// http-client.ts may talk to the network directly.
// Stryker disable all: import.meta.glob needs literal args for Vite's static transform
const sources = import.meta.glob<string>(
	[
		'/src/lib/server/shops/**/*.{ts,js}',
		'/src/lib/server/cli/**/*.{ts,js}',
		'!**/*.spec.ts',
		'!**/*.e2e.ts'
	],
	{ query: '?raw', import: 'default', eager: true }
);
// Stryker restore all

const CLIENT = '/src/lib/server/shops/http-client.ts';

const NETWORK_PATTERNS: { pattern: RegExp; fixtures: string[] }[] = [
	{
		// The global fetch, called or aliased; a property of another object (options.fetch) or
		// an object key ({ fetch: ... }) is not the global, but a ternary branch (? fetch :) is.
		pattern: /(?<![.\w$])(?<![{,]\s*)fetch\b|(?<![.\w$])fetch\b(?!\s*:)/,
		fixtures: [
			"const res = await fetch('https://www.amazon.co.uk/dp/X');",
			'const f = fetch;',
			'const { request } = { request: fetch };',
			'const f = cond ? fetch : x;',
			"const accept = 'text/html,*/*;q=0.8';\nconst r = fetch(u);\n/* end */"
		]
	},
	{
		pattern: /\b(?:globalThis|window|self|global)\s*(?:\??\.\s*fetch\b|\[\s*['"`]fetch['"`]\s*\])/,
		fixtures: ['globalThis.fetch(u);', "globalThis['fetch'](u);", 'const f = window?.fetch;']
	},
	{
		// A renaming destructure off the global ({ fetch: f } = globalThis): the object-key
		// lookarounds above skip it. The same destructure off any other object is allowed.
		pattern:
			/\{[^{}]*(?<![.\w$])fetch\s*:[^{}]*\}\s*=\s*(?:globalThis|window|self|global)\b(?!\s*\??\.)/,
		fixtures: [
			'const { fetch: f } = globalThis;',
			'const { fetch: get, other } = window;',
			'let { fetch: f } = self;'
		]
	},
	{
		// Node's network modules by specifier, with or without node:, however loaded.
		pattern: /(['"`])(?:node:)?(?:https?|http2|net|tls|dgram)\1/,
		fixtures: [
			"import { get } from 'node:https';",
			"import { get } from 'node:http';",
			"import x from 'http';",
			"const https = require('https');",
			"const h2 = await import('node:http2');",
			"import { connect } from 'node:net';",
			'import { connect } from "tls";'
		]
	},
	{ pattern: /\bundici\b/, fixtures: ["import { request } from 'undici';"] },
	{ pattern: /playwright/, fixtures: ["import { chromium } from 'playwright';"] }
];

/**
 * Source text without comments, so prose like "fetch never follows" can't trip a
 * pattern. A small scanner, not a regex: string and regex literals are copied
 * through untouched, so a '*' + '/' or '//' inside one ('*' + '/*;q=0.8',
 * 'https://…', /^https?:\/\//) never opens a fake comment that hides real code.
 */
function code(text: string): string {
	let out = '';
	let i = 0;
	// The last significant character copied; decides whether '/' opens a regex literal.
	let last = '';
	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (c === '/' && next === '/') {
			const end = text.indexOf('\n', i);
			i = end === -1 ? text.length : end;
			continue;
		}
		if (c === '/' && next === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 2;
			out += ' ';
			continue;
		}
		const regex = c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last));
		if (c === "'" || c === '"' || c === '`' || regex) {
			const close = c;
			let inClass = false;
			let j = i + 1;
			while (j < text.length) {
				const d = text[j];
				if (d === '\\') {
					j += 2;
					continue;
				}
				if (regex && d === '\n') break;
				if (regex && d === '[') inClass = true;
				else if (regex && d === ']') inClass = false;
				else if (d === close && !inClass) break;
				j++;
			}
			out += text.slice(i, j + 1);
			i = j + 1;
			last = close;
			continue;
		}
		out += c;
		if (!/\s/.test(c)) last = c;
		i++;
	}
	return out;
}

function offenders(files: Record<string, string>) {
	return Object.entries(files)
		.filter(([path]) => path !== CLIENT)
		.flatMap(([path, text]) =>
			NETWORK_PATTERNS.filter(({ pattern }) => pattern.test(code(text))).map(
				({ pattern }) => `${path} matches ${pattern}`
			)
		);
}

const BAD = '/src/lib/server/shops/bad.ts';

describe('no direct fetch', () => {
	it('scans real sources', () => {
		const keys = Object.keys(sources);

		expect(keys).toContain(CLIENT);
		expect(keys).toContain('/src/lib/server/cli/admin-create.ts');
		expect(keys.filter((key) => /\.(spec|e2e)\.ts$/.test(key))).toEqual([]);

		// The adapter's accept header holds '*' + '/*'; the code after it must still be scanned.
		const adapter = code(sources['/src/lib/server/shops/amazon/adapter.ts']);
		expect(adapter).toContain('function isAmazonUk');
		expect(adapter).toContain('function landing');
		expect(adapter).not.toContain('Where the fetched page actually landed');
	});

	it('patterns match their fixtures', () => {
		for (const { pattern, fixtures } of NETWORK_PATTERNS) {
			for (const fixture of fixtures) {
				expect(pattern.test(fixture), `${pattern} should match ${fixture}`).toBe(true);
				expect(offenders({ [BAD]: fixture }), fixture).toContain(`${BAD} matches ${pattern}`);
				// Only the client itself is exempt.
				expect(offenders({ [CLIENT]: fixture }), fixture).toEqual([]);
			}
		}
	});

	it('near misses', () => {
		for (const fixture of [
			'// fetch never follows redirects',
			'/* fetch(x) */ const a = 1;',
			'const a = 1; // then globalThis.fetch(u)',
			'options.fetch(u);',
			'const f = deps.fetch ?? x;',
			'const options = { fetch: fakeFetch };',
			'const options = {\n\tretries: 1,\n\tfetch: fakeFetch\n};',
			'const { fetch: f } = options;',
			'const { fetch: f } = deps;',
			'const { fetch: f } = window.deps;',
			'const { fetch: f } = globalThis?.deps;',
			'const host = /^https?:\\/\\//; // fetch here is prose',
			"stderr.write('nothing was fetched');",
			"const home = 'https://www.amazon.co.uk/';",
			"if (url.protocol === 'https:' || url.protocol === 'http:') ok();",
			"import { getSharedClient } from './http-client.ts';"
		]) {
			expect(offenders({ [BAD]: fixture }), fixture).toEqual([]);
		}
	});

	it('only the client talks to the network', () => {
		expect(offenders(sources)).toEqual([]);
	});
});
