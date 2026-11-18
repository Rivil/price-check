// The hand-off between the SvelteKit server and the Electron main process. They
// are two bundles with two copies of this module, so the runtime lives on
// globalThis under a registry symbol both copies resolve to the same key. No
// $app/* imports: the main bundle has no SvelteKit runtime.

const RUNTIME_KEY = Symbol.for('price-check.runtime');

/** The controls the server publishes once it is up, for main to drive. */
export type ServerRuntime = {
	/** Runs a scheduler pass now, or queues one if a pass is running (OS resume). */
	requestPass(): void;
	/** Stops the scheduler, waiting for the pass in flight at most drainMs. */
	stop(drainMs?: number): Promise<void>;
	/** Closes the database client; a second call does nothing. */
	closeDb(): Promise<void>;
};

type RuntimeHolder = { [RUNTIME_KEY]?: ServerRuntime };

/** Publishes the server's runtime; called once by the server's init hook. */
export function publishRuntime(runtime: ServerRuntime): void {
	(globalThis as RuntimeHolder)[RUNTIME_KEY] = runtime;
}

/** The published runtime; throws if the server has not published one yet. */
export function readRuntime(): ServerRuntime {
	const runtime = (globalThis as RuntimeHolder)[RUNTIME_KEY];
	if (runtime === undefined) throw new Error('server runtime not published');
	return runtime;
}

/**
 * Wraps a client's close so only the first call reaches it: quit may close the
 * database more than once, and a second libsql close must not run.
 */
export function closeOnce(close: () => void): () => Promise<void> {
	let closed = false;
	return async () => {
		if (closed) return;
		closed = true;
		close();
	};
}
