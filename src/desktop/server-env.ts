// The environment the adapter-node handler is imported under (spec c-1): the
// desktop owns DATABASE_URL, ALERTS_ENCRYPTION_KEY and PROTOCOL_HEADER, so a user's
// shell (or a self-hosted .env habit) can never point the app at another DB or key.
// The wrapper (decision desktop_server_wrapper) sets X-Forwarded-Proto: http on every
// request, so PROTOCOL_HEADER makes adapter-node build an http origin on the live
// port; ORIGIN and the other proxy headers would override that and are dropped.
// Everything else (SCHEDULER_DISABLED, CHECK_INTERVAL_HOURS, PATH...) passes through.
//
// Runs in the Electron main bundle: no $app/* imports, no electron import, and no
// #lib/server/db/* import (the server bundle owns the only libsql client).
import { resolve } from 'node:path';

/** Inherited variables that would override the wrapper's origin handling. */
const DROPPED = new Set(['ORIGIN', 'HOST_HEADER', 'PORT_HEADER', 'ADDRESS_HEADER']);

export type ServerEnvInput = { dbFile: string; key: Buffer };

/**
 * A libsql file: URL for an absolute path. libsql percent-decodes the path and cuts
 * it at '?' and '#', so those three characters are escaped; everything else (spaces,
 * non-ASCII, Windows backslashes and drive letters) is passed through as is.
 */
export function databaseUrl(dbFile: string): string {
	return `file:${resolve(dbFile).replace(/[%?#]/g, encodeURIComponent)}`;
}

export function serverEnv(
	inherited: NodeJS.ProcessEnv,
	{ dbFile, key }: ServerEnvInput
): Record<string, string> {
	const own: Record<string, string> = {
		DATABASE_URL: databaseUrl(dbFile),
		ALERTS_ENCRYPTION_KEY: key.toString('base64'),
		PROTOCOL_HEADER: 'x-forwarded-proto'
	};
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(inherited)) {
		if (value === undefined) continue;
		// Windows env names are case-insensitive: 'Origin' is ORIGIN there.
		const upper = name.toUpperCase();
		if (DROPPED.has(upper) || upper in own) continue;
		env[name] = value;
	}
	return { ...env, ...own };
}
