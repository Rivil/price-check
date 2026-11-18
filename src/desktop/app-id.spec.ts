import { describe, expect, it } from 'vitest';
import appIdSource from './app-id.ts?raw';
import { APP_ID, appUserModelIdFor } from './app-id.ts';

const EXEC_PATH = 'C:\\Users\\me\\price-check\\node_modules\\electron\\dist\\electron.exe';

describe('APP_ID', () => {
	it('is the shared reverse-DNS app ID', () => {
		expect(APP_ID).toBe('io.github.rivil.price-check');
	});

	it("has no imports at all: 05's electron-builder config reads it", () => {
		expect(appIdSource).not.toMatch(/^\s*import\b/m);
		expect(appIdSource).not.toMatch(/\bimport\s*\(/);
		expect(appIdSource).not.toMatch(/\brequire\s*\(/);
		expect(appIdSource).not.toMatch(/^\s*export\b[^;]*\bfrom\s*['"]/m);
	});
});

describe('appUserModelIdFor', () => {
	it.each([
		{ platform: 'win32', isPackaged: true, expected: APP_ID },
		{ platform: 'win32', isPackaged: false, expected: EXEC_PATH },
		{ platform: 'darwin', isPackaged: true, expected: null },
		{ platform: 'darwin', isPackaged: false, expected: null },
		{ platform: 'linux', isPackaged: true, expected: null },
		{ platform: 'linux', isPackaged: false, expected: null }
	] as const)(
		'$platform, packaged $isPackaged -> $expected',
		({ platform, isPackaged, expected }) => {
			expect(appUserModelIdFor({ platform, isPackaged, execPath: EXEC_PATH })).toBe(expected);
		}
	);
});
