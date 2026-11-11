// The caller-facing shop API: resolve or check any URL through the registry.
// Imported by the adapter:check CLI, so it runs under Node type stripping: no
// $app/* or $env/* imports, explicit .ts extensions, erasable syntax only.
import { amazonAdapter } from './amazon/adapter.ts';
import { getSharedClient, type RateLimitedClient } from './http-client.ts';
import { createShopRegistry } from './registry.ts';
import type { CheckDeps, CheckResult, ShopClient } from './types.ts';

export { amazonAdapter } from './amazon/adapter.ts';
export { getSharedClient } from './http-client.ts';
export { createShopRegistry, type Resolution, type ShopRegistry } from './registry.ts';
export {
	failure,
	type CheckDeps,
	type CheckFailure,
	type CheckResult,
	type CheckSuccess,
	type FailureReason,
	type ShopAdapter,
	type ShopClient
} from './types.ts';

/**
 * The real rate-limited client as the ShopClient contract adapters are written
 * against: svelte-check fails here if the two shapes drift apart.
 */
export function asShopClient(client: RateLimitedClient): ShopClient {
	return client;
}

/** Every supported shop. A new shop is one more adapter here, nothing else. */
export const defaultRegistry = createShopRegistry([amazonAdapter]);

/** Checks a URL through the default registry and, unless given one, the shared client. */
export function checkUrl(input: string, deps: Partial<CheckDeps> = {}): Promise<CheckResult> {
	return defaultRegistry.check(input, { client: deps.client ?? asShopClient(getSharedClient()) });
}
