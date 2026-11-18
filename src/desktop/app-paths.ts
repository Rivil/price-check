// Where the desktop app keeps its state (spec c-1): one userData dir holding the
// SQLite DB and the alerts key. Electron's own default would follow package.json's
// name; the app pins its own so a rename never strands a user's data.
//
// Runs in the Electron main bundle: no $app/* imports, no electron import.
import { join, resolve } from 'node:path';

/** The userData folder's name under the OS app-data dir. */
export const APP_DIR_NAME = 'price-check';
export const DB_FILE_NAME = 'price-check.db';
export const KEY_FILE_NAME = 'alerts.key';

export type UserDataInput = {
	/** Electron's app.getPath('appData'). */
	appData: string;
	/** Electron's app.isPackaged. */
	isPackaged: boolean;
	env: NodeJS.ProcessEnv;
};

/**
 * <appData>/price-check. An unpackaged run (dev, e2e) may point it elsewhere with
 * PRICE_CHECK_USER_DATA; a packaged app never reads that variable, so a stray
 * environment cannot move a real user's data.
 */
export function resolveUserDataDir({ appData, isPackaged, env }: UserDataInput): string {
	const override = env.PRICE_CHECK_USER_DATA?.trim();
	if (!isPackaged && override) return resolve(override);
	return join(appData, APP_DIR_NAME);
}

/**
 * The cwd the SvelteKit server runs in (05-release c-1). A packaged app's root is
 * <resources>/app.asar, an archive: process.chdir into it throws ENOTDIR, and the
 * server's migrations (drizzle/, resolved against the cwd) ship asarUnpack'd in the
 * app.asar.unpacked sibling. So a root whose last segment is app.asar maps there,
 * with either separator and the rest of the path kept as is; any other root
 * (unpackaged dev, the e2e suite: the repo root) stays as it is.
 */
export function serverCwdFor(appRoot: string): string {
	return /(^|[\\/])app\.asar$/.test(appRoot) ? `${appRoot}.unpacked` : appRoot;
}

export type DesktopPaths = { userData: string; dbFile: string; keyFile: string };

export function desktopPaths(userData: string): DesktopPaths {
	return {
		userData,
		dbFile: join(userData, DB_FILE_NAME),
		keyFile: join(userData, KEY_FILE_NAME)
	};
}
