// The one HTTP client every live shop request goes through (rule r-01). Imported
// by the adapter:check CLI, so it runs under Node type stripping: no $app/* or
// $env/* imports, explicit .ts extensions, erasable syntax only.
//
// One global FIFO queue with a single request in flight. Each host remembers when
// its last request settled; the next request to that host starts no sooner than
// minGapMs + random() * jitterMs after that. Other hosts are not delayed by it.

export type ClientErrorKind = 'timeout' | 'network';

export class ClientError extends Error {
	readonly kind: ClientErrorKind;

	constructor(kind: ClientErrorKind, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'ClientError';
		this.kind = kind;
	}
}

export type ClientRequestOptions = {
	method?: 'GET' | 'HEAD';
	headers?: Record<string, string>;
	redirect?: 'follow' | 'manual' | 'error';
	/** false: return as soon as headers arrive and cancel the body stream. Default true. */
	readBody?: boolean;
};

export type ClientResponse = {
	status: number;
	/** The response URL (the request URL unless fetch followed a redirect). */
	url: string;
	headers: Headers;
	body: string | null;
};

export type RateLimitedClient = {
	request(url: string, options?: ClientRequestOptions): Promise<ClientResponse>;
};

export type ClientConfig = {
	minGapMs: number;
	jitterMs: number;
	timeoutMs: number;
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ClientDeps = {
	fetch?: FetchLike;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
};

const DEFAULTS: ClientConfig = { minGapMs: 5000, jitterMs: 2000, timeoutMs: 15000 };

/** The longest delay setTimeout honours (2^31 - 1 ms). */
const MAX_TIMER_MS = 2147483647;

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRateLimitedClient(
	options: Partial<ClientConfig> & ClientDeps = {}
): RateLimitedClient {
	const { minGapMs, jitterMs, timeoutMs } = { ...DEFAULTS, ...definedOnly(options) };
	const fetchImpl = options.fetch ?? defaultFetch;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const random = options.random ?? Math.random;

	const lastSettled = new Map<string, number>();
	let tail: Promise<unknown> = Promise.resolve();

	async function waitForHost(host: string) {
		const last = lastSettled.get(host);
		if (last === undefined) return;
		const startAt = last + minGapMs + random() * jitterMs;
		const wait = startAt - now();
		if (wait > 0) await sleep(wait);
	}

	async function exchange(
		url: string,
		opts: ClientRequestOptions,
		signal: AbortSignal
	): Promise<ClientResponse> {
		const response = await fetchImpl(url, {
			method: opts.method ?? 'GET',
			headers: opts.headers,
			redirect: opts.redirect ?? 'follow',
			signal
		});
		let body: string | null = null;
		if (opts.readBody === false) {
			await response.body?.cancel().catch(() => undefined);
		} else {
			body = await response.text();
		}
		return { status: response.status, url: response.url || url, headers: response.headers, body };
	}

	/** One request with a deadline covering headers and body. */
	async function perform(url: string, opts: ClientRequestOptions): Promise<ClientResponse> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new ClientError('timeout', `request timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});
		try {
			return await Promise.race([exchange(url, opts, controller.signal), deadline]);
		} catch (error) {
			if (error instanceof ClientError) throw error;
			const detail = error instanceof Error ? error.message : String(error);
			throw new ClientError('network', `request failed: ${detail}`, { cause: error });
		} finally {
			clearTimeout(timer);
		}
	}

	async function run(url: string, opts: ClientRequestOptions): Promise<ClientResponse> {
		let host: string;
		try {
			host = new URL(url).host;
		} catch (error) {
			throw new ClientError('network', `invalid URL: ${url}`, { cause: error });
		}
		await waitForHost(host);
		try {
			return await perform(url, opts);
		} finally {
			lastSettled.set(host, now());
		}
	}

	return {
		request(url, opts = {}) {
			const result = tail.then(() => run(url, opts));
			// A rejected request must never wedge the queue.
			tail = result.catch(() => undefined);
			return result;
		}
	};
}

function definedOnly(options: Partial<ClientConfig>): Partial<ClientConfig> {
	const out: Partial<ClientConfig> = {};
	if (options.minGapMs !== undefined) out.minGapMs = options.minGapMs;
	if (options.jitterMs !== undefined) out.jitterMs = options.jitterMs;
	if (options.timeoutMs !== undefined) out.timeoutMs = options.timeoutMs;
	return out;
}

function readMs(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	allowZero: boolean
): number {
	const raw = env[name];
	if (raw === undefined) return fallback;
	const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
	// setTimeout fires after ~1ms for delays past MAX_TIMER_MS, which would void the gap and timeout.
	if (!(value <= MAX_TIMER_MS) || (!allowZero && value === 0)) {
		const kind = allowZero ? 'a non-negative' : 'a positive';
		throw new Error(
			`${name} must be ${kind} whole number of milliseconds up to ${MAX_TIMER_MS}, got "${raw}"`
		);
	}
	return value;
}

/** SHOP_MIN_GAP_MS (5000), SHOP_JITTER_MS (2000), SHOP_TIMEOUT_MS (15000). */
export function clientConfigFromEnv(env: Record<string, string | undefined>): ClientConfig {
	return {
		minGapMs: readMs(env, 'SHOP_MIN_GAP_MS', DEFAULTS.minGapMs, false),
		jitterMs: readMs(env, 'SHOP_JITTER_MS', DEFAULTS.jitterMs, true),
		timeoutMs: readMs(env, 'SHOP_TIMEOUT_MS', DEFAULTS.timeoutMs, false)
	};
}

let shared: RateLimitedClient | undefined;

/** The process-wide client: one queue for every caller. */
export function getSharedClient(): RateLimitedClient {
	shared ??= createRateLimitedClient(clientConfigFromEnv(process.env));
	return shared;
}
