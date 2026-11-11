// The shop-adapter contract. Imported by the adapter:check CLI, so it runs under
// Node type stripping: no $app/* or $env/* imports, explicit .ts extensions,
// erasable syntax only.

/**
 * The HTTP client an adapter is handed. Declared here, not imported from
 * http-client.ts, so adapters depend on the shape only; index.ts asserts the real
 * client is assignable to it.
 */
export type ShopRequestOptions = {
	method?: 'GET' | 'HEAD';
	headers?: Record<string, string>;
	redirect?: 'follow' | 'manual' | 'error';
	readBody?: boolean;
};

export type ShopResponse = {
	status: number;
	url: string;
	headers: Headers;
	body: string | null;
};

export type ShopClient = {
	/** Rejects with an Error carrying `kind: 'timeout' | 'network'` (see clientErrorKind). */
	request(url: string, options?: ShopRequestOptions): Promise<ShopResponse>;
};

export type ShopClientErrorKind = 'timeout' | 'network';

/** The kind of a client rejection, read structurally so fakes need not import ClientError. */
export function clientErrorKind(error: unknown): ShopClientErrorKind | null {
	if (!(error instanceof Error) || !('kind' in error)) return null;
	return error.kind === 'timeout' || error.kind === 'network' ? error.kind : null;
}

export type FailureReason =
	| 'unsupported'
	| 'blocked'
	| 'unavailable'
	| 'variant_required'
	| 'parse_failed'
	| 'not_found'
	| 'fetch_failed';

const FAILURE_REASONS = {
	unsupported: true,
	blocked: true,
	unavailable: true,
	variant_required: true,
	parse_failed: true,
	not_found: true,
	fetch_failed: true
} satisfies Record<FailureReason, true>;

export const MAX_FAILURE_MESSAGE = 120;

export type CheckSuccess = {
	ok: true;
	shop: string;
	productId: string;
	canonicalUrl: string;
	title: string;
	pricePence: number;
	imageUrl: string | null;
};

/** A failure never carries a price: exactly these three keys. */
export type CheckFailure = { ok: false; reason: FailureReason; message: string };

export type CheckResult = CheckSuccess | CheckFailure;

export type CheckDeps = { client: ShopClient };

/** A product named from its URL alone, with no request made. */
export type ProductIdentity = { productId: string; canonicalUrl: string };

export type ShopAdapter = {
	id: string;
	/** Absolute path of this adapter's recorded/synthetic HTML fixtures. */
	fixturesDir: string;
	/** Whether this adapter handles the URL. Must not make requests. */
	claims(url: URL): boolean;
	check(url: URL, deps: CheckDeps): Promise<CheckResult>;
	/**
	 * Names the product a claimed URL points at without making any request, or
	 * null when only a check can tell (e.g. a short link). Optional: an adapter
	 * without it is always "needs a check".
	 */
	identify?(url: URL): ProductIdentity | null;
};

export function failure(reason: FailureReason, message: string): CheckFailure {
	if (!Object.hasOwn(FAILURE_REASONS, reason)) {
		throw new Error(`unknown failure reason: ${String(reason)}`);
	}
	if (message.trim() === '') throw new Error('failure message must not be empty');
	if (message.length > MAX_FAILURE_MESSAGE) {
		throw new Error(`failure message longer than ${MAX_FAILURE_MESSAGE} chars: ${message}`);
	}
	return { ok: false, reason, message };
}

/** Shortens free text (e.g. an error message) to fit a failure message. */
export function clipMessage(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim() || 'unknown error';
	return flat.length <= MAX_FAILURE_MESSAGE ? flat : `${flat.slice(0, MAX_FAILURE_MESSAGE - 1)}…`;
}
