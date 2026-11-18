import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerRuntime } from './runtime-bridge.ts';

const KEY = Symbol.for('price-check.runtime');

/** A fresh copy of the module, as each of the two bundles (server and main) holds one. */
async function freshBridge() {
	vi.resetModules();
	return import('./runtime-bridge.ts');
}

function fakeRuntime(): ServerRuntime {
	return { requestPass: vi.fn(), stop: vi.fn(async () => {}), closeDb: vi.fn(async () => {}) };
}

function clear() {
	delete (globalThis as { [KEY]?: unknown })[KEY];
}

describe('runtime-bridge', () => {
	beforeEach(clear);
	afterEach(clear);

	it('two module instances share the published runtime', async () => {
		const server = await freshBridge();
		const main = await freshBridge();
		expect(main).not.toBe(server);
		const runtime = fakeRuntime();

		server.publishRuntime(runtime);

		expect(main.readRuntime()).toBe(runtime);
		expect(server.readRuntime()).toBe(runtime);
	});

	it('lives under the registry symbol', async () => {
		const { publishRuntime } = await freshBridge();
		const runtime = fakeRuntime();

		publishRuntime(runtime);

		expect((globalThis as { [KEY]?: unknown })[KEY]).toBe(runtime);
	});

	it('reading before publish throws', async () => {
		const { readRuntime } = await freshBridge();

		expect(() => readRuntime()).toThrow(new Error('server runtime not published'));
	});

	it('a later publish replaces the earlier one', async () => {
		const { publishRuntime, readRuntime } = await freshBridge();
		const first = fakeRuntime();
		const second = fakeRuntime();

		publishRuntime(first);
		publishRuntime(second);

		expect(readRuntime()).toBe(second);
	});
});

describe('closeOnce', () => {
	it('closes the client once, however often it is called', async () => {
		const { closeOnce } = await import('./runtime-bridge.ts');
		const close = vi.fn();
		const closeDb = closeOnce(close);

		expect(close).not.toHaveBeenCalled();
		await closeDb();
		await closeDb();

		expect(close).toHaveBeenCalledOnce();
	});

	it('a failing close rejects, and is not retried', async () => {
		const { closeOnce } = await import('./runtime-bridge.ts');
		const close = vi.fn(() => {
			throw new Error('locked');
		});
		const closeDb = closeOnce(close);

		await expect(closeDb()).rejects.toThrow('locked');
		await expect(closeDb()).resolves.toBeUndefined();
		expect(close).toHaveBeenCalledOnce();
	});
});
