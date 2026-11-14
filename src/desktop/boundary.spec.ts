// Pins the desktop import boundary (spec c-1, c-7). main.ts is the only module that
// imports electron's values: everything else takes Electron injected, so it runs
// under vitest. The SvelteKit app never reaches into Electron or src/desktop. The
// desktop main modules never import SvelteKit's virtual modules or a libsql client:
// a second client would hold its own handle on the DB file (locked on Windows).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = join(ROOT, 'src', 'desktop');
const LIB = join(ROOT, 'src', 'lib');
const ROUTES = join(ROOT, 'src', 'routes');
const MAIN = join(DESKTOP, 'main.ts');
const TESTING = join(DESKTOP, 'testing');
const DB_DIR = join(LIB, 'server', 'db');

type ModuleRef = { specifier: string; typeOnly: boolean };

const CODE = /\.(ts|js|mts|cts|mjs|cjs)$/;
const SPEC = /\.(spec|test)\.[^.]+$/;

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

/** The script blocks of a .svelte file; any other file as is. */
function scriptSource(file: string, text: string): string {
	if (!file.endsWith('.svelte')) return text;
	return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

/**
 * Every module a source names: static imports and re-exports, import = require,
 * dynamic import(), require() and import('x') types. Only `import type` /
 * `export type` and import types count as type-only: `import { type X } from 'm'`
 * still loads m at runtime.
 */
function moduleRefs(source: string, fileName = 'file.ts'): ModuleRef[] {
	const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const refs: ModuleRef[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			refs.push({
				specifier: node.moduleSpecifier.text,
				typeOnly: node.importClause?.isTypeOnly === true
			});
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			refs.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			ts.isStringLiteral(node.moduleReference.expression)
		) {
			refs.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly });
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
			node.arguments.length > 0 &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			refs.push({ specifier: node.arguments[0].text, typeOnly: false });
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal)
		) {
			refs.push({ specifier: node.argument.literal.text, typeOnly: true });
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return refs;
}

/** The file a local specifier points at (relative, $lib, #lib, /src); null for a package. */
function localTarget(specifier: string, fromFile: string): string | null {
	if (specifier.startsWith('./') || specifier.startsWith('../')) {
		return resolve(dirname(fromFile), specifier);
	}
	const lib = /^[$#]lib(\/.*)?$/.exec(specifier);
	if (lib) return join(LIB, lib[1] ?? '');
	if (specifier.startsWith('/src/')) return join(ROOT, specifier);
	return null;
}

function within(path: string, dir: string): boolean {
	const rel = relative(dir, path);
	return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

const isElectron = (specifier: string) =>
	specifier === 'electron' || specifier.startsWith('electron/');

/** Why `specifier` breaks the SvelteKit side of the boundary, or null. */
function appSideViolation(specifier: string, fromFile: string): string | null {
	if (isElectron(specifier)) return 'imports electron';
	const target = localTarget(specifier, fromFile);
	if (target !== null && within(target, DESKTOP)) return 'imports src/desktop';
	return null;
}

/** Why `specifier` breaks the desktop main side of the boundary, or null. */
function desktopSideViolation(specifier: string, fromFile: string): string | null {
	if (specifier === '$app' || specifier.startsWith('$app/')) return 'imports a $app module';
	if (specifier === '@libsql/client' || specifier.startsWith('@libsql/client/')) {
		return 'imports @libsql/client';
	}
	const target = localTarget(specifier, fromFile);
	if (target !== null && within(target, DB_DIR)) return 'imports #lib/server/db';
	return null;
}

function refsOf(file: string): ModuleRef[] {
	return moduleRefs(scriptSource(file, readFileSync(file, 'utf8')), file);
}

const rel = (file: string) => relative(ROOT, file).split(sep).join('/');

const desktopSources = walk(DESKTOP).filter((f) => CODE.test(f) && !SPEC.test(f));

describe('import scanner', () => {
	it('tells type-only imports from value imports', () => {
		const refs = moduleRefs(
			[
				"import type { App } from 'a';",
				"import { type B } from 'b';",
				"import { c } from 'c';",
				"import 'd';",
				"export type { E } from 'e';",
				"export { f } from 'f';",
				"import g = require('g');",
				"const h = await import('h');",
				"const i = require('i');",
				"let j: import('j').J;"
			].join('\n')
		);
		expect(refs).toEqual([
			{ specifier: 'a', typeOnly: true },
			{ specifier: 'b', typeOnly: false },
			{ specifier: 'c', typeOnly: false },
			{ specifier: 'd', typeOnly: false },
			{ specifier: 'e', typeOnly: true },
			{ specifier: 'f', typeOnly: false },
			{ specifier: 'g', typeOnly: false },
			{ specifier: 'h', typeOnly: false },
			{ specifier: 'i', typeOnly: false },
			{ specifier: 'j', typeOnly: true }
		]);
	});

	it('reads the script blocks of a .svelte file', () => {
		const svelte = [
			'<script module lang="ts">',
			"\timport { a } from 'electron';",
			'</script>',
			'<script lang="ts">',
			"\timport b from '$lib/../desktop/main.ts';",
			'</script>',
			"<p>import x from 'not-code';</p>"
		].join('\n');
		expect(moduleRefs(scriptSource('x.svelte', svelte)).map((r) => r.specifier)).toEqual([
			'electron',
			'$lib/../desktop/main.ts'
		]);
	});

	it('flags electron and src/desktop on the app side', () => {
		const from = join(LIB, 'server', 'x.ts');
		expect(appSideViolation('electron', from)).toBe('imports electron');
		expect(appSideViolation('electron/main', from)).toBe('imports electron');
		expect(appSideViolation('../../desktop/main.ts', from)).toBe('imports src/desktop');
		expect(appSideViolation('$lib/../desktop/window.ts', from)).toBe('imports src/desktop');
		expect(appSideViolation('/src/desktop/tray.ts', from)).toBe('imports src/desktop');
		expect(appSideViolation('#lib/server/runtime-bridge.ts', from)).toBeNull();
		expect(appSideViolation('../../desktop-notes/x.ts', from)).toBeNull();
		expect(appSideViolation('electron-store', from)).toBeNull();
	});

	it('flags $app, @libsql/client and the db modules on the desktop side', () => {
		const from = join(DESKTOP, 'x.ts');
		expect(desktopSideViolation('$app/env', from)).toBe('imports a $app module');
		expect(desktopSideViolation('$app/env/private', from)).toBe('imports a $app module');
		expect(desktopSideViolation('@libsql/client', from)).toBe('imports @libsql/client');
		expect(desktopSideViolation('#lib/server/db/index.ts', from)).toBe('imports #lib/server/db');
		expect(desktopSideViolation('$lib/server/db/client.ts', from)).toBe('imports #lib/server/db');
		expect(desktopSideViolation('../lib/server/db/schema.ts', from)).toBe('imports #lib/server/db');
		expect(desktopSideViolation('#lib/server/runtime-bridge.ts', from)).toBeNull();
		expect(desktopSideViolation('#lib/server/db-notes.ts', from)).toBeNull();
		expect(desktopSideViolation('node:fs', from)).toBeNull();
	});
});

describe('desktop import boundary', () => {
	it('scans the desktop modules, main.ts included', () => {
		expect(desktopSources).toContain(MAIN);
		// The window, tray, login-item, lifecycle, server, key, env and paths modules.
		expect(desktopSources.length).toBeGreaterThanOrEqual(9);
	});

	it("main.ts is the only module that imports electron's values", () => {
		const valueImporters = desktopSources
			.filter((file) => refsOf(file).some((r) => isElectron(r.specifier) && !r.typeOnly))
			.map(rel);
		expect(valueImporters).toEqual([rel(MAIN)]);
	});

	it('the SvelteKit app never imports electron or src/desktop', () => {
		const files = [...walk(LIB), ...walk(ROUTES)].filter(
			(f) => CODE.test(f) || f.endsWith('.svelte')
		);
		expect(files.length).toBeGreaterThan(0);
		const violations = files.flatMap((file) =>
			refsOf(file).flatMap((r) => {
				const why = appSideViolation(r.specifier, file);
				return why ? [`${rel(file)} ${why} (${r.specifier})`] : [];
			})
		);
		expect(violations).toEqual([]);
	});

	it('desktop modules never import $app/*, @libsql/client or #lib/server/db/*', () => {
		const files = desktopSources.filter((f) => !within(f, TESTING));
		const violations = files.flatMap((file) =>
			refsOf(file).flatMap((r) => {
				const why = desktopSideViolation(r.specifier, file);
				return why ? [`${rel(file)} ${why} (${r.specifier})`] : [];
			})
		);
		expect(violations).toEqual([]);
	});
});

// 05-release c-1, c-5, c-6: main.ts is the only module that loads electron-updater,
// builds and publishes the updater only when packaged, and reads the predecessor PID
// before loadAdapterHandler replaces process.env.
const isUpdater = (specifier: string) =>
	specifier === 'electron-updater' || specifier.startsWith('electron-updater/');

const FEED_OVERRIDE = /setFeedURL|forceDevUpdateConfig|updateConfigPath/;

const mainSource = readFileSync(MAIN, 'utf8');
const mainFile = ts.createSourceFile(MAIN, mainSource, ts.ScriptTarget.Latest, true);

function callsTo(name: string): ts.CallExpression[] {
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === name
		) {
			calls.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(mainFile);
	return calls;
}

/** The value of property `name` in an object literal: assigned, shorthand or a method. */
function propertyOf(object: ts.Node | undefined, name: string): ts.Node | undefined {
	if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
	for (const p of object.properties) {
		if (p.name?.getText(mainFile) !== name) continue;
		if (ts.isPropertyAssignment(p)) return p.initializer;
		if (ts.isShorthandPropertyAssignment(p)) return p.name;
		if (ts.isMethodDeclaration(p)) return p;
	}
	return undefined;
}

/** True when `condition` holds only if app.isPackaged does (itself or an && operand). */
function requiresPackaged(condition: ts.Expression, sf: ts.SourceFile = mainFile): boolean {
	if (ts.isParenthesizedExpression(condition)) return requiresPackaged(condition.expression, sf);
	if (condition.getText(sf) === 'app.isPackaged') return true;
	return (
		ts.isBinaryExpression(condition) &&
		condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
		(requiresPackaged(condition.left, sf) || requiresPackaged(condition.right, sf))
	);
}

/** True when `node` runs only on a branch an app.isPackaged condition guards. */
function inPackagedBranch(node: ts.Node): boolean {
	for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (ts.isIfStatement(parent) && parent.thenStatement === child) {
			if (requiresPackaged(parent.expression)) return true;
		}
		if (ts.isConditionalExpression(parent) && parent.whenTrue === child) {
			if (requiresPackaged(parent.condition)) return true;
		}
	}
	return false;
}

describe('desktop updater wiring', () => {
	it('main.ts is the only module that value-imports electron-updater', () => {
		const valueImporters = desktopSources
			.filter((file) => refsOf(file).some((r) => isUpdater(r.specifier) && !r.typeOnly))
			.map(rel);
		expect(valueImporters).toEqual([rel(MAIN)]);
	});

	it('no runtime feed override: no desktop module names one', () => {
		const offenders = desktopSources
			.filter((file) => FEED_OVERRIDE.test(readFileSync(file, 'utf8')))
			.map(rel);
		expect(offenders).toEqual([]);
	});

	it('reads PRICE_CHECK_PREDECESSOR_PID before the loadAdapterHandler call', () => {
		const [load] = callsTo('loadAdapterHandler');
		expect(load).toBeDefined();
		expect(mainSource).toMatch(/process\.env\[PREDECESSOR_PID_ENV\]/);
		const mentions = [...mainSource.matchAll(/PREDECESSOR_PID/g)].map((m) => m.index);
		expect(mentions.length).toBeGreaterThan(0);
		for (const at of mentions) expect(at).toBeLessThan(load.getStart(mainFile));
	});

	it('builds and publishes the updater only in an app.isPackaged branch', () => {
		const calls = [...callsTo('createUpdater'), ...callsTo('publishUpdaterHandle')];
		expect(calls.map((c) => c.expression.getText(mainFile)).sort()).toEqual([
			'createUpdater',
			'publishUpdaterHandle'
		]);
		for (const call of calls) expect(inPackagedBranch(call), call.getText(mainFile)).toBe(true);
	});

	it('the guard accepts only conditions that need app.isPackaged', () => {
		for (const [text, expected] of [
			['app.isPackaged', true],
			['app.isPackaged && updater', true],
			['updater && (app.isPackaged)', true],
			['app.isPackaged || updater', false],
			['!app.isPackaged', false],
			['updater', false]
		] as const) {
			const sf = ts.createSourceFile('c.ts', `${text};`, ts.ScriptTarget.Latest, true);
			const statement = sf.statements[0] as ts.ExpressionStatement;
			expect(requiresPackaged(statement.expression, sf), text).toBe(expected);
		}
	});

	it('publishes status, the tray restart action and checkNow', () => {
		const [publish] = callsTo('publishUpdaterHandle');
		const handle = publish.arguments[0];
		expect(propertyOf(handle, 'status')).toBeDefined();
		expect(propertyOf(handle, 'checkNow')).toBeDefined();

		// restart is the very action runDesktop handed the tray (c-5 tray item reachable).
		const restart = propertyOf(handle, 'restart');
		expect(restart && ts.isIdentifier(restart)).toBe(true);
		const [run] = callsTo('runDesktop');
		const trayFactory = propertyOf(run.arguments[0], 'createTray');
		expect(trayFactory && ts.isArrowFunction(trayFactory)).toBe(true);
		const factory = trayFactory as ts.ArrowFunction;
		const actions = factory.parameters[0].name.getText(mainFile);
		const factoryText = factory.getText(mainFile);
		expect(factoryText).toMatch(
			new RegExp(`\\b${restart?.getText(mainFile)}\\s*=\\s*${actions}\\.restartToUpdate\\b`)
		);
		const [trayCall] = callsTo('createTray');
		const trayActions = trayCall.arguments[1];
		expect(trayActions && ts.isObjectLiteralExpression(trayActions)).toBe(true);
		const spreads = (trayActions as ts.ObjectLiteralExpression).properties
			.filter(ts.isSpreadAssignment)
			.map((s) => s.expression.getText(mainFile));
		expect(spreads).toContain(actions);
		expect(propertyOf(trayActions, 'restartToUpdate')).toBeUndefined();
	});

	it('builds the updater with the existing notifier and an onReady that shows the tray item', () => {
		const [create] = callsTo('createUpdater');
		const input = create.arguments[0];
		const [load] = callsTo('loadAdapterHandler');
		const serverNotifier = propertyOf(load.arguments[3], 'notifier');
		expect(serverNotifier).toBeDefined();
		expect(propertyOf(input, 'notifier')?.getText(mainFile)).toBe(
			serverNotifier?.getText(mainFile)
		);
		expect(propertyOf(input, 'onReady')?.getText(mainFile)).toMatch(
			/\btray\??\.setUpdateReady\(\s*true\s*\)/
		);
	});
});
