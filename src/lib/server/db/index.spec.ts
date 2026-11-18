// Pins the build-time guard in index.ts: `vite build` must never open a libsql
// client (an open client at exit crashed Windows builds intermittently).
import { afterEach, describe, expect, it, vi } from 'vitest';

const createDb = vi.fn(() => ({ marker: 'client' }));

async function load(building: boolean, url: string) {
	vi.resetModules();
	vi.doMock('$app/env', () => ({ building }));
	vi.doMock('$app/env/private', () => ({ DATABASE_URL: url }));
	vi.doMock('./client.ts', () => ({ createDb }));
	return import('./index.ts');
}

afterEach(() => {
	createDb.mockClear();
	vi.doUnmock('$app/env');
	vi.doUnmock('$app/env/private');
	vi.doUnmock('./client.ts');
});

describe('db', () => {
	it('opens no client while building, even without DATABASE_URL', async () => {
		const { db } = await load(true, '');
		expect(createDb).not.toHaveBeenCalled();
		expect(() => db.select).toThrow(/not available while vite build/);
	});

	it('opens the client from DATABASE_URL at runtime', async () => {
		const { db } = await load(false, 'file:test.db');
		expect(createDb).toHaveBeenCalledWith('file:test.db');
		expect(db).toEqual({ marker: 'client' });
	});

	it('refuses to start at runtime without DATABASE_URL', async () => {
		await expect(load(false, '')).rejects.toThrow('DATABASE_URL is not set');
		expect(createDb).not.toHaveBeenCalled();
	});
});
