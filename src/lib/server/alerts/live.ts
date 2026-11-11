// The real alert hooks: after a check, decide (alertAfterSuccess, alertAfterFailure)
// and deliver through each channel's driver over the platform fetch, with the key
// the server installed at startup. Callers pass them as afterSuccess and afterFailure.
import type { Db } from '../db/client.ts';
import type { CheckFailure } from '../shops/types.ts';
import { alertAfterFailure, alertAfterSuccess, type AlertDeps } from './alerts.ts';
import { alertsKey } from './crypto.ts';

// Looked up per call, not captured at import, so a stubbed global fetch applies.
const fetchNow = (input: string, init: RequestInit) => globalThis.fetch(input, init);

// The key too: it is installed after this module loads, and read inside the hooks'
// never-throw guard.
const liveDeps: AlertDeps = { key: alertsKey, fetch: fetchNow };

export function liveAfterSuccess(db: Db): (watchId: string) => Promise<unknown> {
	return (watchId) => alertAfterSuccess(db, watchId, liveDeps);
}

export function liveAfterFailure(
	db: Db
): (watchId: string, result: CheckFailure) => Promise<unknown> {
	return (watchId, result) => alertAfterFailure(db, watchId, result, liveDeps);
}
