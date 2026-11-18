import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { removeTempDir, REMOVE_RETRIES, REMOVE_RETRY_DELAY_MS } from './temp-dir.ts';

const failing = (code: string) =>
	vi.fn(() => {
		throw Object.assign(new Error(code), { code });
	}) as unknown as typeof rmSync;

describe('removeTempDir', () => {
	it('removes a directory and its files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'apc-tempdir-'));
		writeFileSync(join(dir, 'x.db'), 'x');
		removeTempDir(dir);
		expect(existsSync(dir)).toBe(false);
	});

	it('asks rmSync to retry lock errors', () => {
		const remove = vi.fn() as unknown as typeof rmSync;
		removeTempDir('/tmp/somewhere', remove, 'linux');
		expect(remove).toHaveBeenCalledWith('/tmp/somewhere', {
			recursive: true,
			force: true,
			maxRetries: REMOVE_RETRIES,
			retryDelay: REMOVE_RETRY_DELAY_MS
		});
	});

	it.each(['EPERM', 'EBUSY'])('tolerates a Windows file lock (%s)', (code) => {
		expect(() => removeTempDir('C:\\t', failing(code), 'win32')).not.toThrow();
	});

	it.each([
		['EPERM off Windows', 'EPERM', 'linux'],
		['EBUSY on macOS', 'EBUSY', 'darwin'],
		['any other error on Windows', 'ENOTDIR', 'win32']
	] as const)('still throws %s', (_name, code, platform) => {
		expect(() => removeTempDir('/t', failing(code), platform)).toThrow(code);
	});
});
