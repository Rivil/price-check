import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

// c-3: the auth stack is deleted, not hidden. Every non-test source under src/, as raw
// text: route files say which URLs answer, no source may still reach for the deleted
// modules, and none may mention the auth library or its secret (c-2). Test files are
// excluded because they name what they assert is gone (this file included).
// Stryker disable all: import.meta.glob needs literal args for Vite's static transform
const sources = import.meta.glob<string>(
	['/src/**/*.{ts,js,svelte}', '!**/*.{spec,test,e2e}.{ts,js}'],
	{ query: '?raw', import: 'default', eager: true }
);
// Stryker restore all

/** URLs that must 404 (decision removed_routes): no route may answer any of them. */
const REMOVED_PATHS = [
	'/login',
	'/logout',
	'/account/password',
	'/admin',
	'/admin/users',
	'/admin/users/x/password',
	'/api/auth',
	'/api/auth/get-session',
	'/api/auth/sign-in/email'
];

/** Route trees that must hold no page or endpoint at any depth. */
const REMOVED_TREES = ['login', 'logout', 'account/password', 'admin', 'api/auth'];

/** The deleted modules, extension dropped. */
const DELETED_MODULES = [
	'/src/lib/server/access',
	'/src/lib/server/accounts',
	'/src/lib/server/admin-bootstrap',
	'/src/lib/server/auth',
	'/src/lib/server/auth-factory',
	'/src/lib/server/login-limiter',
	'/src/lib/server/own-password',
	'/src/lib/server/cli/admin-create',
	'/src/lib/server/db/auth.schema',
	'/src/lib/server/testing/auth-harness'
];

/**
 * Any mention of the auth library or its secret, full text: comments and doc links
 * included (c-2). Better Auth, betterAuth and BETTER_AUTH_SECRET alike; a different
 * word that merely starts with it (better-authz) is not a mention.
 */
const AUTH_TEXT = /better[-_ ]?auth(?![a-z])/i;

const TEXT_PATTERNS = [/locals\.user/, /\/api\/auth/, AUTH_TEXT];

// Static, re-export, side-effect and dynamic imports alike.
const SPECIFIER = /\b(?:from|import)\s*\(?\s*(['"])([^'"\n]+)\1/g;

const isRouteFile = (key: string) => /^\/src\/routes\/(?:.*\/)?\+(?:page|server)[^/]*$/.test(key);

/** A route file's URL segments: layout groups dropped, the +file name cut off. */
function routeSegments(key: string) {
	return key
		.split('/')
		.slice(3, -1)
		.filter((segment) => !/^\(.*\)$/.test(segment));
}

/** Whether a route with these segments could answer `path` (Kit's matching, over-approximated). */
function answers(segments: string[], path: string[]): boolean {
	if (segments.length === 0) return path.length === 0;
	const [head, ...rest] = segments;
	// A rest parameter takes any number of segments, none included.
	if (/^\[\.\.\..*\]$/.test(head))
		return path.some((_, i) => answers(rest, path.slice(i))) || answers(rest, []);
	if (/^\[\[.*\]\]$/.test(head)) {
		return answers(rest, path) || (path.length > 0 && answers(rest, path.slice(1)));
	}
	if (path.length === 0) return false;
	// Any segment with a parameter in it matches any one segment.
	if (head.includes('[')) return answers(rest, path.slice(1));
	return head === path[0] && answers(rest, path.slice(1));
}

function removedRoutes(keys: string[]) {
	return keys.filter(isRouteFile).filter((key) => {
		const segments = routeSegments(key);
		const url = segments.join('/');
		return (
			REMOVED_TREES.some((tree) => url === tree || url.startsWith(`${tree}/`)) ||
			REMOVED_PATHS.some((path) => answers(segments, path.split('/').slice(1)))
		);
	});
}

const stripExtension = (path: string) => path.replace(/\.(?:[cm]?[jt]s|svelte)$/, '');

/** Where `specifier`, imported from `from`, points: a src path, or the bare package name. */
function resolve(from: string, specifier: string) {
	if (/^[#$]lib\//.test(specifier)) return `/src/lib/${specifier.slice(5)}`;
	if (specifier.startsWith('.')) return posix.join(posix.dirname(from), specifier);
	return specifier;
}

const isBetterAuth = (specifier: string) => /^@?better-auth(?:\/|$)/.test(specifier);

function offenders(files: Record<string, string>) {
	return Object.entries(files).flatMap(([path, text]) => [
		...[...text.matchAll(SPECIFIER)]
			.map((match) => match[2])
			.filter(
				(specifier) =>
					isBetterAuth(specifier) ||
					DELETED_MODULES.includes(stripExtension(resolve(path, specifier)))
			)
			.map((specifier) => `${path} imports ${specifier}`),
		...TEXT_PATTERNS.filter((pattern) => pattern.test(text)).map(
			(pattern) => `${path} matches ${pattern}`
		)
	]);
}

describe('removed routes', () => {
	it('scans real sources', () => {
		const keys = Object.keys(sources);

		expect(keys).toContain('/src/routes/+page.svelte');
		expect(keys).toContain('/src/routes/watches/[id]/+page.server.ts');
		expect(keys).toContain('/src/hooks.server.ts');
		expect(keys).toContain('/src/app.d.ts');
		expect(keys.filter((key) => /\.(?:spec|test|e2e)\.[jt]s$/.test(key))).toEqual([]);
	});

	it('route matching fixtures', () => {
		const answering = [
			'/src/routes/login/+page.svelte',
			'/src/routes/logout/+server.ts',
			'/src/routes/account/password/+page.server.ts',
			'/src/routes/(app)/admin/users/+page.svelte',
			'/src/routes/admin/users/[id]/password/+page.svelte',
			'/src/routes/admin/settings/+page.svelte',
			'/src/routes/api/auth/[...all]/+server.ts',
			'/src/routes/[...rest]/+page.svelte',
			'/src/routes/[slug]/+page.svelte',
			'/src/routes/[[lang]]/login/+page.svelte',
			'/src/routes/api/[...path]/+server.js'
		];
		for (const key of answering) {
			expect(removedRoutes([key]), key).toEqual([key]);
		}
		const safe = [
			'/src/routes/+page.svelte',
			'/src/routes/+layout.svelte',
			'/src/routes/login/+layout.svelte',
			'/src/routes/account/alerts/+page.svelte',
			'/src/routes/watches/[id]/+page.server.ts',
			'/src/routes/health/+server.ts',
			'/src/routes/loginx/+page.svelte'
		];
		expect(removedRoutes(safe)).toEqual([]);
	});

	it('no route answers a removed path', () => {
		expect(removedRoutes(Object.keys(sources))).toEqual([]);
	});

	it('scanner fixtures', () => {
		const bad: [string, string][] = [
			['/src/lib/server/x.ts', "export * from './db/auth.schema.ts';"],
			['/src/lib/server/db/x.ts', "import { createAuth } from '../auth-factory.ts';"],
			['/src/routes/x/+page.server.ts', "import { auth } from '#lib/server/auth.ts';"],
			['/src/routes/x/+page.server.ts', "import { auth } from '$lib/server/auth';"],
			['/src/lib/x.ts', "const m = await import('#lib/server/accounts.ts');"],
			['/src/lib/x.ts', "import '../lib/server/testing/auth-harness.ts';"],
			['/src/routes/x/+page.svelte', '<script>const u = data.locals.user;</script>'],
			['/src/lib/x.ts', "await fetch('/api/auth/get-session');"],
			['/src/lib/server/x.ts', '// docs: https://www.better-auth.com/docs'],
			['/src/env.ts', "BETTER_AUTH_SECRET: { description: 'Secret used to sign tokens.' }"],
			['/src/env.ts', "description: 'See [Better Auth installation](https://example.com)'"],
			['/src/lib/x.ts', 'const auth = betterAuth({});'],
			['/src/routes/x/+page.svelte', '<!-- Signs in through BetterAuth. -->']
		];
		for (const [path, text] of bad) {
			expect(offenders({ [path]: text }), text).toHaveLength(1);
		}
		// An auth-library import is both an import and a mention.
		for (const text of [
			"import { betterAuth } from 'better-auth/minimal';",
			"import type { BetterAuthPlugin } from 'better-auth';"
		]) {
			expect(offenders({ '/src/lib/server/x.ts': text }), text).toHaveLength(2);
		}
		const fine: [string, string][] = [
			['/src/lib/server/x.ts', "import { x } from './auth-something.ts';"],
			['/src/lib/server/x.ts', "import { x } from 'better-authz';"],
			['/src/lib/server/x.ts', "import { x } from './local-request.ts';"],
			['/src/lib/server/db/x.ts', "import { watch } from './watch.schema.ts';"],
			['/src/lib/server/x.ts', 'const user = locals;'],
			['/src/lib/server/x.ts', '// a better authoring flow; ALERTS_ENCRYPTION_KEY'],
			['/src/lib/x.ts', 'const betterAuthority = 1;']
		];
		for (const [path, text] of fine) {
			expect(offenders({ [path]: text }), text).toEqual([]);
		}
	});

	// The t-6 review found a scan that missed `import 'x'`: every form, every target.
	it('every import form is caught', () => {
		const forms = [
			(specifier: string) => `import { x } from '${specifier}';`,
			(specifier: string) => `export * from "${specifier}";`,
			(specifier: string) => `import '${specifier}';`,
			(specifier: string) => `import "${specifier}"`,
			(specifier: string) => `const m = await import('${specifier}');`,
			(specifier: string) => `const m = await import( "${specifier}" );`
		];
		const targets = [
			'better-auth',
			'better-auth/svelte-kit',
			'better-auth/plugins/admin',
			...DELETED_MODULES.map((module) => `${module.replace('/src/lib/', '#lib/')}.ts`)
		];
		for (const form of forms) {
			for (const target of targets) {
				const text = form(target);
				expect(offenders({ '/src/lib/x.ts': text }), text).toEqual([
					`/src/lib/x.ts imports ${target}`,
					// A library import also names the library.
					...(isBetterAuth(target) ? [`/src/lib/x.ts matches ${AUTH_TEXT}`] : [])
				]);
			}
		}
	});

	it('no source reaches the auth stack', () => {
		expect(offenders(sources)).toEqual([]);
	});

	it('deleted modules are gone', () => {
		const left = Object.keys(sources).filter((key) =>
			DELETED_MODULES.includes(stripExtension(key))
		);

		expect(left).toEqual([]);
	});
});
