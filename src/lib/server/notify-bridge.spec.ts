import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bridgeSource from './notify-bridge.ts?raw';
import type { DesktopNotifier } from './notify-bridge.ts';
import type { ServerRuntime } from './runtime-bridge.ts';

const KEY = Symbol.for('price-check.notifier');
const RUNTIME_KEY = Symbol.for('price-check.runtime');

type Holder = { [KEY]?: unknown; [RUNTIME_KEY]?: unknown };

/** A fresh copy of the module, as each of the two bundles (server and main) holds one. */
async function freshBridge() {
	vi.resetModules();
	return import('./notify-bridge.ts');
}

function fakeNotifier(): DesktopNotifier {
	return { show: vi.fn(async () => ({ ok: true as const })) };
}

function fakeRuntime(): ServerRuntime {
	return { requestPass: vi.fn(), stop: vi.fn(async () => {}), closeDb: vi.fn(async () => {}) };
}

function clear() {
	delete (globalThis as Holder)[KEY];
	delete (globalThis as Holder)[RUNTIME_KEY];
}

describe('notify-bridge', () => {
	beforeEach(clear);
	afterEach(clear);

	it('two module instances share the published notifier', async () => {
		const main = await freshBridge();
		const server = await freshBridge();
		expect(server).not.toBe(main);
		const notifier = fakeNotifier();

		main.publishNotifier(notifier);

		expect(server.readNotifier()).toBe(notifier);
		expect(main.readNotifier()).toBe(notifier);
	});

	it('lives under the price-check.notifier registry symbol', async () => {
		const { publishNotifier } = await freshBridge();
		const notifier = fakeNotifier();

		publishNotifier(notifier);

		expect((globalThis as Holder)[KEY]).toBe(notifier);
	});

	it('reading before any publish returns undefined, without throwing (not in Electron)', async () => {
		const { readNotifier } = await freshBridge();

		expect(() => readNotifier()).not.toThrow();
		expect(readNotifier()).toBeUndefined();
	});

	it('a later publish replaces the earlier one', async () => {
		const { publishNotifier, readNotifier } = await freshBridge();
		const first = fakeNotifier();
		const second = fakeNotifier();

		publishNotifier(first);
		publishNotifier(second);

		expect(readNotifier()).toBe(second);
	});

	it("does not share runtime-bridge's key: publishing one never clobbers the other", async () => {
		expect(KEY).not.toBe(RUNTIME_KEY);
		const { publishNotifier, readNotifier } = await freshBridge();
		const { publishRuntime, readRuntime } = await import('./runtime-bridge.ts');
		const notifier = fakeNotifier();
		const runtime = fakeRuntime();

		publishNotifier(notifier);
		expect((globalThis as Holder)[RUNTIME_KEY]).toBeUndefined();
		publishRuntime(runtime);

		expect(readNotifier()).toBe(notifier);
		expect(readRuntime()).toBe(runtime);
	});

	it('has no imports at all: main bundles it and refuses $app/* and libsql', () => {
		expect(bridgeSource).not.toMatch(/^\s*import\b/m);
		expect(bridgeSource).not.toMatch(/\bimport\s*\(/);
		expect(bridgeSource).not.toMatch(/\brequire\s*\(/);
		expect(bridgeSource).not.toMatch(/^\s*export\b[^;]*\bfrom\s*['"]/m);
	});
});
