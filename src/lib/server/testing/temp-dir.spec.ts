import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { removeTempDir, REMOVE_RETRIES, REMOVE_RETRY_DELAY_MS } from './temp-dir.ts';

describe('removeTempDir', () => {
	it('removes a directory and its files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'apc-tempdir-'));
		writeFileSync(join(dir, 'x.db'), 'x');
		removeTempDir(dir);
		expect(existsSync(dir)).toBe(false);
	});

	it('retries, so a Windows file lock released after close does not fail cleanup', () => {
		const remove = vi.fn() as unknown as typeof rmSync;
		removeTempDir('/tmp/somewhere', remove);
		expect(remove).toHaveBeenCalledWith('/tmp/somewhere', {
			recursive: true,
			force: true,
			maxRetries: REMOVE_RETRIES,
			retryDelay: REMOVE_RETRY_DELAY_MS
		});
		expect(REMOVE_RETRIES * REMOVE_RETRY_DELAY_MS).toBeGreaterThanOrEqual(1000);
	});
});
