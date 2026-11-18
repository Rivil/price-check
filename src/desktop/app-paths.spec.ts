import { basename, dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { migrationsFolder } from '#lib/server/db/migrate.ts';
import { desktopPaths, resolveUserDataDir, serverCwdFor } from './app-paths.ts';
import mainSource from './main.ts?raw';

const APP_DATA = join('/', 'Users', 'u', 'Library', 'Application Support');
const OVERRIDE = join('/', 'tmp', 'e2e-user-data');

describe('resolveUserDataDir', () => {
	it('is exactly <appData>/price-check', () => {
		const dir = resolveUserDataDir({ appData: APP_DATA, isPackaged: true, env: {} });

		expect(dir).toBe(join(APP_DATA, 'price-check'));
		expect(basename(dir)).toBe('price-check');
		expect(dirname(dir)).toBe(APP_DATA);
	});

	it('ignores PRICE_CHECK_USER_DATA when packaged', () => {
		const dir = resolveUserDataDir({
			appData: APP_DATA,
			isPackaged: true,
			env: { PRICE_CHECK_USER_DATA: OVERRIDE }
		});

		expect(dir).toBe(join(APP_DATA, 'price-check'));
	});

	it('honours PRICE_CHECK_USER_DATA when unpackaged', () => {
		const dir = resolveUserDataDir({
			appData: APP_DATA,
			isPackaged: false,
			env: { PRICE_CHECK_USER_DATA: OVERRIDE }
		});

		expect(dir).toBe(resolve(OVERRIDE));
	});

	it('resolves a relative override to an absolute path', () => {
		const dir = resolveUserDataDir({
			appData: APP_DATA,
			isPackaged: false,
			env: { PRICE_CHECK_USER_DATA: 'rel/data' }
		});

		expect(dir).toBe(resolve('rel/data'));
	});

	it.each([undefined, '', '   '])(
		'falls back to <appData>/price-check unpackaged with override %j',
		(value) => {
			const dir = resolveUserDataDir({
				appData: APP_DATA,
				isPackaged: false,
				env: { PRICE_CHECK_USER_DATA: value }
			});

			expect(dir).toBe(join(APP_DATA, 'price-check'));
		}
	);
});

describe('desktopPaths', () => {
	it('puts the DB and the key in userData', () => {
		const userData = join(APP_DATA, 'price-check');

		expect(desktopPaths(userData)).toEqual({
			userData,
			dbFile: join(userData, 'price-check.db'),
			keyFile: join(userData, 'alerts.key')
		});
	});
});

describe('serverCwdFor', () => {
	it.each([
		[
			'/A/Price Check.app/Contents/Resources/app.asar',
			'/A/Price Check.app/Contents/Resources/app.asar.unpacked'
		],
		[
			'C:\\Users\\u\\AppData\\Local\\Programs\\price-check\\resources\\app.asar',
			'C:\\Users\\u\\AppData\\Local\\Programs\\price-check\\resources\\app.asar.unpacked'
		],
		['/tmp/.mount_x/resources/app.asar', '/tmp/.mount_x/resources/app.asar.unpacked']
	])('maps the packaged root %s to its app.asar.unpacked sibling', (root, cwd) => {
		expect(serverCwdFor(root)).toBe(cwd);
	});

	it.each([
		'/repo',
		'/x/app.asar.unpacked',
		'/x/app.asarx',
		'/home/u/x.asar.d/app',
		'/x/my-app.asar'
	])('leaves %s as is (unpackaged dev and e2e keep the repo root)', (root) => {
		expect(serverCwdFor(root)).toBe(root);
	});

	it('puts the packaged migrations in app.asar.unpacked/drizzle', () => {
		// Built with this OS's separators, as APP_ROOT is (resolve()).
		const resources = join(resolve('/A'), 'Price Check.app', 'Contents', 'Resources');
		const packagedRoot = join(resources, 'app.asar');
		expect(migrationsFolder(serverCwdFor(packagedRoot))).toBe(
			join(resources, 'app.asar.unpacked', 'drizzle')
		);
	});
});

describe('main wires serverCwdFor', () => {
	const sf = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'loadAdapterHandler'
		) {
			calls.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	it('main wires serverCwdFor: loadAdapterHandler runs in serverCwdFor(APP_ROOT)', () => {
		expect(calls).toHaveLength(1);
		const cwd = calls[0].arguments[2];
		expect(cwd).toBeDefined();
		// Either inline or through one const initialised to it; never APP_ROOT itself.
		const text = cwd.getText(sf);
		expect(text).not.toBe('APP_ROOT');
		const initialiser = new RegExp(
			`\\bconst\\s+${text}\\s*=\\s*serverCwdFor\\(\\s*APP_ROOT\\s*\\)`
		);
		expect(text === 'serverCwdFor(APP_ROOT)' || initialiser.test(mainSource)).toBe(true);
	});
});
