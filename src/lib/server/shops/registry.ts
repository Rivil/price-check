// Routes a URL to the shop adapter that claims it. Imported by the adapter:check
// CLI, so it runs under Node type stripping: no $app/* or $env/* imports,
// explicit .ts extensions, erasable syntax only.
import {
	clipMessage,
	failure,
	type CheckDeps,
	type CheckFailure,
	type CheckResult,
	type ProductIdentity,
	type ShopAdapter
} from './types.ts';

export type Resolution =
	{ kind: 'adapter'; adapter: ShopAdapter; url: URL } | { kind: 'unsupported' };

/** What a URL names before any request: a product, something only a check can name, or nothing. */
export type Identification =
	| { kind: 'product'; shop: string; productId: string; canonicalUrl: string }
	| { kind: 'needs_check' }
	| { kind: 'unsupported' };

export type ShopRegistry = {
	resolve(input: string): Resolution;
	/** Never makes a request and never throws. */
	identify(input: string): Identification;
	/** Never rejects: an adapter that throws comes back as fetch_failed. */
	check(input: string, deps: CheckDeps): Promise<CheckResult>;
};

export const unsupported = (): CheckFailure => failure('unsupported', 'unsupported URL');

function parse(input: string): URL | null {
	try {
		const url = new URL(input.trim());
		return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
	} catch {
		return null;
	}
}

export function createShopRegistry(adapters: readonly ShopAdapter[]): ShopRegistry {
	const ids = new Set<string>();
	for (const adapter of adapters) {
		if (ids.has(adapter.id)) throw new Error(`duplicate shop adapter id: ${adapter.id}`);
		ids.add(adapter.id);
	}
	const registered = [...adapters];

	function resolve(input: string): Resolution {
		// Parsed once; only http(s) URLs ever reach an adapter's claims().
		const url = parse(input);
		if (url === null) return { kind: 'unsupported' };
		const adapter = registered.find((candidate) => candidate.claims(url));
		return adapter === undefined ? { kind: 'unsupported' } : { kind: 'adapter', adapter, url };
	}

	async function check(input: string, deps: CheckDeps): Promise<CheckResult> {
		let resolution: Resolution;
		try {
			resolution = resolve(input);
		} catch (error) {
			return failure('fetch_failed', clipMessage(`check failed: ${describe(error)}`));
		}
		if (resolution.kind === 'unsupported') return unsupported();
		try {
			return await resolution.adapter.check(resolution.url, deps);
		} catch (error) {
			return failure('fetch_failed', clipMessage(`check failed: ${describe(error)}`));
		}
	}

	function identify(input: string): Identification {
		let resolution: Resolution;
		try {
			resolution = resolve(input);
		} catch {
			// A claims() that throws is reported by check(); identity just isn't known.
			return { kind: 'needs_check' };
		}
		if (resolution.kind === 'unsupported') return { kind: 'unsupported' };
		const { adapter, url } = resolution;
		let identity: ProductIdentity | null;
		try {
			identity = adapter.identify?.(url) ?? null;
		} catch {
			identity = null;
		}
		return identity === null
			? { kind: 'needs_check' }
			: { kind: 'product', shop: adapter.id, ...identity };
	}

	return { resolve, check, identify };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
