import { describe, expect, it } from 'vitest';
import { ACTION_ENDPOINTS, actionUrl } from '../../e2e/action-endpoints.ts';

// c-6: the CSRF e2e can only prove what it posts to. Every action a +page.server
// declares must be in ACTION_ENDPOINTS (and nothing stale), and Kit's origin check
// must stay on (decision local_request_guard). Raw text, so no route module runs.
// Stryker disable all: import.meta.glob needs literal args for Vite's static transform
const pageServers = import.meta.glob<string>('/src/routes/**/+page.server.{ts,js}', {
	query: '?raw',
	import: 'default',
	eager: true
});
const kitConfigs = import.meta.glob<string>(['/vite.config.{ts,js}', '/svelte.config.{ts,js}'], {
	query: '?raw',
	import: 'default',
	eager: true
});
// Stryker restore all

/** A page server's URL path, Kit [param] segments kept, layout groups dropped. */
function routeOf(key: string) {
	const segments = key
		.split('/')
		.slice(3, -1)
		.filter((segment) => !/^\(.*\)$/.test(segment));
	return `/${segments.join('/')}`;
}

const PROPERTY_KEY =
	/^(?:(?:async|get|set)\s+)?(?:\*\s*)?(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*(?:[:(]|$)/;

/** One object-literal member's key; throws on a spread or computed key. */
function keyOf(member: string) {
	const match = PROPERTY_KEY.exec(member);
	if (!match) throw new Error(`action-endpoints: cannot read the action member \`${member}\``);
	return match[1] ?? match[2] ?? match[3];
}

/**
 * The action names a file's `export const actions = { ... }` declares, or null when
 * it exports no actions. Throws when it exports them in a shape this scan cannot
 * read (a re-export, a spread, a computed key), so a new form never slips past.
 */
function declaredActions(text: string): string[] | null {
	const literal = /export\s+const\s+actions\b[^=]*=\s*\{/.exec(text);
	if (!literal) {
		if (/export\s*\{[^}]*\bactions\b|export\s+(?:let|var|function)\s+actions\b/.test(text)) {
			throw new Error('action-endpoints: actions exported in an unreadable shape');
		}
		return null;
	}
	const members: string[] = [];
	let member = '';
	let depth = 1;
	for (let i = literal.index + literal[0].length; i < text.length; i++) {
		const char = text[i];
		if (char === '/' && text[i + 1] === '/') {
			i = text.indexOf('\n', i);
			if (i === -1) break;
			continue;
		}
		if (char === '/' && text[i + 1] === '*') {
			i = text.indexOf('*/', i + 2) + 1;
			if (i === 0) break;
			continue;
		}
		if (char === "'" || char === '"' || char === '`') {
			let end = i + 1;
			while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
			member += text.slice(i, end + 1);
			i = end;
			continue;
		}
		if ('{(['.includes(char)) depth++;
		if ('})]'.includes(char)) depth--;
		if (depth === 0 || (depth === 1 && char === ',')) {
			if (member.trim() !== '') members.push(member.trim());
			member = '';
			if (depth === 0) return members.map(keyOf);
			continue;
		}
		member += char;
	}
	throw new Error('action-endpoints: the actions object never closes');
}

/** The [route, action] pairs a set of page servers declares, as `route?/action` strings. */
function declaredEndpoints(files: Record<string, string>) {
	return Object.entries(files).flatMap(([key, text]) =>
		(declaredActions(text) ?? []).map((action) => `${routeOf(key)}?/${action}`)
	);
}

/** Config text that turns Kit's origin check off, trusts another origin, or pins self. */
const CSRF_WEAKENERS = [
	/\bcsrf\b/,
	/\btrustedOrigins\b/,
	/\bcheckOrigin\b/,
	/\bpaths\s*:\s*\{[^}]*\borigin\b/
];

const weakensCsrf = (text: string) => CSRF_WEAKENERS.some((pattern) => pattern.test(text));

const listed = ACTION_ENDPOINTS.map(([route, action]) => `${route}?/${action}`);

describe('action endpoints', () => {
	it('scans real page servers', () => {
		expect(Object.keys(pageServers)).toEqual(
			expect.arrayContaining([
				'/src/routes/+page.server.ts',
				'/src/routes/account/alerts/+page.server.ts',
				'/src/routes/watches/[id]/+page.server.ts'
			])
		);
	});

	it('route paths', () => {
		expect(routeOf('/src/routes/+page.server.ts')).toBe('/');
		expect(routeOf('/src/routes/account/alerts/+page.server.ts')).toBe('/account/alerts');
		expect(routeOf('/src/routes/watches/[id]/+page.server.ts')).toBe('/watches/[id]');
		expect(routeOf('/src/routes/(app)/settings/+page.server.js')).toBe('/settings');
	});

	it('action extraction fixtures', () => {
		const read: [string, string[] | null][] = [
			['export const load = () => ({});', null],
			[
				'export const actions: Actions = {\n\tadd: async ({ request }) => {\n\t\tfoo(a, { b: 1 });\n\t},\n\tremove: async () => fail(400, { x: [1, 2] })\n};',
				['add', 'remove']
			],
			['export const actions = { default: async () => {} } satisfies Actions;', ['default']],
			['export const actions = { \'quoted-name\': x, "double": y, };', ['quoted-name', 'double']],
			['export const actions = { async save() {}, check };', ['save', 'check']],
			[
				'export const actions = {\n\t// a: comment, with commas\n\t/* b: { */ go: () => "},", next: () => `{,`\n};',
				['go', 'next']
			]
		];
		for (const [text, actions] of read) {
			expect(declaredActions(text), text).toEqual(actions);
		}
		for (const text of [
			'const actions = {};\nexport { actions };',
			'export let actions = {};',
			'export const actions = { ...shared, add };',
			'export const actions = { [name]: go };',
			'export const actions = { add: () => {'
		]) {
			expect(() => declaredActions(text), text).toThrow();
		}
	});

	it('every declared action is listed', () => {
		const declared = declaredEndpoints(pageServers);

		expect(declared).toContain('/?/add');
		expect([...declared].sort()).toEqual([...listed].sort());
	});

	it('a new action fails the listing', () => {
		const files = {
			...pageServers,
			'/src/routes/new/+page.server.ts': 'export const actions = { go: async () => {} };'
		};

		expect(declaredEndpoints(files)).toContain('/new?/go');
		expect(declaredEndpoints(files).sort()).not.toEqual([...listed].sort());
	});

	it('lists each endpoint once', () => {
		expect(new Set(listed).size).toBe(listed.length);
	});

	it('action URLs', () => {
		expect(actionUrl(['/', 'add'], {})).toBe('/?/add');
		expect(actionUrl(['/watches/[id]', 'delete'], { id: 'a b' })).toBe('/watches/a%20b?/delete');
		expect(actionUrl(['/settings', 'default'], {})).toBe('/settings');
		expect(() => actionUrl(['/watches/[id]', 'check'], {})).toThrow('no value for [id]');
		expect(() => actionUrl(['/[[lang]]/x', 'go'], { lang: 'en' })).toThrow('unsupported param');
	});

	it('Kit config keeps the origin check on', () => {
		expect(Object.keys(kitConfigs)).toContain('/vite.config.ts');
		for (const [key, text] of Object.entries(kitConfigs)) {
			expect(weakensCsrf(text), key).toBe(false);
		}
	});

	it('CSRF config fixtures', () => {
		for (const text of [
			"sveltekit({ csrf: { trustedOrigins: ['*'] } })",
			"kit: { csrf: { trustedOrigins: ['https://evil.example'] } }",
			'kit: { csrf: { checkOrigin: false } }',
			"sveltekit({ paths: { origin: 'http://localhost:4173' } })"
		]) {
			expect(weakensCsrf(text), text).toBe(true);
		}
		expect(weakensCsrf("sveltekit({ adapter: adapter(), paths: { base: '' } })")).toBe(false);
	});
});
