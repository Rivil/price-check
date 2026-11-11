// Removes a test's temp directory. On Windows, SQLite (libsql) can keep a database
// file locked for a moment after its client closes, so a plain rmSync fails with
// EPERM/EBUSY. Node's rmSync retries exactly those errors when maxRetries is set.
import { rmSync } from 'node:fs';

export const REMOVE_RETRIES = 20;
export const REMOVE_RETRY_DELAY_MS = 100;

export function removeTempDir(dir: string, remove: typeof rmSync = rmSync): void {
	remove(dir, {
		recursive: true,
		force: true,
		maxRetries: REMOVE_RETRIES,
		retryDelay: REMOVE_RETRY_DELAY_MS
	});
}
