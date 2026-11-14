import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopPaths, resolveUserDataDir } from './app-paths.ts';

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
