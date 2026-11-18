// Removes a test's temp directory. On Windows, libsql keeps a database file locked
// after its client closes (observed on GitHub's windows-2025 runner: EPERM on every
// cleanup, even after 2s of retries). Cleanup there is best-effort: the runner's
// temp folder is discarded with the VM. Everywhere else a failure still throws.
import { rmSync } from 'node:fs';

export const REMOVE_RETRIES = 3;
export const REMOVE_RETRY_DELAY_MS = 50;
const LOCKED = new Set(['EPERM', 'EBUSY']);

export function removeTempDir(
	dir: string,
	remove: typeof rmSync = rmSync,
	platform: NodeJS.Platform = process.platform
): void {
	try {
		remove(dir, {
			recursive: true,
			force: true,
			maxRetries: REMOVE_RETRIES,
			retryDelay: REMOVE_RETRY_DELAY_MS
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (platform === 'win32' && code !== undefined && LOCKED.has(code)) return;
		throw error;
	}
}
