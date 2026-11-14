import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopNotice } from '#lib/server/notify-bridge.ts';
import { createNotifier, MAX_RETAINED, type NotifierHandle } from './notifier.ts';
import type { NotificationCtor, NotificationLike } from './notify-seam.ts';

const SETTLE_MS = 4000;

type Listener = (...args: unknown[]) => void;

/** A fake Electron Notification class: records construction and show(), emits on demand. */
function fakeNotificationClass(supported = true) {
	const created: FakeNotification[] = [];

	class FakeNotification implements NotificationLike {
		private readonly listeners = new Map<string, Listener[]>();
		shows = 0;

		static isSupported(): boolean {
			return supported;
		}

		constructor(readonly options: { title: string; body: string }) {
			created.push(this);
		}

		on(event: string, listener: (...args: never[]) => void): this {
			const list = this.listeners.get(event) ?? [];
			list.push(listener as Listener);
			this.listeners.set(event, list);
			return this;
		}

		emit(event: 'show' | 'click' | 'close' | 'failed'): void {
			const args = event === 'failed' ? [{}, 'toast refused'] : [{}];
			for (const listener of this.listeners.get(event) ?? []) listener(...args);
		}

		show(): void {
			this.shows += 1;
		}
	}

	return { Notification: FakeNotification satisfies NotificationCtor, created };
}

function notice(clickPath: () => Promise<string> = async () => '/watches/w1'): DesktopNotice {
	return { title: 'Kettle is now £19.99', body: 'Target £20.00', clickPath };
}

/** Lets a click's awaited clickPath() and the handler call run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(supported = true) {
	const fake = fakeNotificationClass(supported);
	const handle: NotifierHandle = createNotifier({
		Notification: fake.Notification,
		settleMs: SETTLE_MS
	});
	const last = () => {
		const n = fake.created.at(-1);
		if (!n) throw new Error('no notification was constructed');
		return n;
	};
	return { ...fake, handle, last };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('createNotifier show()', () => {
	it('reports unsupported without constructing or showing anything (c-5)', async () => {
		const { handle, created } = setup(false);
		await expect(handle.notifier.show(notice())).resolves.toEqual({
			ok: false,
			reason: 'unsupported'
		});
		expect(created).toHaveLength(0);
		expect(handle.retainedCount()).toBe(0);
	});

	it("resolves ok on 'show' and leaves no timer armed", async () => {
		const { handle, last } = setup();
		const result = handle.notifier.show(notice());
		expect(last().shows).toBe(1);
		last().emit('show');
		await expect(result).resolves.toEqual({ ok: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resolves failed when 'failed' comes first, and leaves no timer armed", async () => {
		const { handle, last } = setup();
		const result = handle.notifier.show(notice());
		last().emit('failed');
		last().emit('show');
		await expect(result).resolves.toEqual({ ok: false, reason: 'failed' });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('counts an unreported notice as delivered at exactly settleMs, not before', async () => {
		const { handle } = setup();
		let outcome: unknown;
		void handle.notifier.show(notice()).then((r) => (outcome = r));
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
		expect(outcome).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(outcome).toEqual({ ok: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('passes title and body through untouched', async () => {
		const { handle, last } = setup();
		const title = `<b>Tom & Jerry's "mug"</b> &amp; ${'é'.repeat(300)}`;
		const body = `Now £1,299.00 <target> ${'x'.repeat(2000)}\nline two`;
		const result = handle.notifier.show({ title, body, clickPath: async () => '/' });
		expect(last().options).toEqual({ title, body });
		last().emit('show');
		await result;
	});

	it('reports failed when constructing the notification throws', async () => {
		const Throwing = class {
			static isSupported(): boolean {
				return true;
			}
			constructor() {
				throw new Error('bad options');
			}
		} as unknown as NotificationCtor;
		const handle = createNotifier({ Notification: Throwing, settleMs: SETTLE_MS });
		await expect(handle.notifier.show(notice())).resolves.toEqual({
			ok: false,
			reason: 'failed'
		});
		expect(handle.retainedCount()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('reports failed when the OS refuses show() by throwing', async () => {
		const { handle, Notification } = setup();
		vi.spyOn(Notification.prototype, 'show').mockImplementation(() => {
			throw new Error('no toast for you');
		});
		await expect(handle.notifier.show(notice())).resolves.toEqual({
			ok: false,
			reason: 'failed'
		});
		expect(handle.retainedCount()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('createNotifier retention', () => {
	it.each(['click', 'close', 'failed'] as const)(
		"holds a shown notification until '%s'",
		async (event) => {
			const { handle, last } = setup();
			void handle.notifier.show(notice());
			expect(handle.retainedCount()).toBe(1);
			last().emit('show');
			expect(handle.retainedCount()).toBe(1);
			last().emit(event);
			expect(handle.retainedCount()).toBe(0);
			await flush();
		}
	);

	it(`holds at most the newest ${MAX_RETAINED} unclicked notifications`, async () => {
		const { handle, created } = setup();
		for (let i = 0; i < 25; i += 1) {
			const result = handle.notifier.show(notice());
			created[i].emit('show');
			await result;
		}
		expect(MAX_RETAINED).toBe(20);
		expect(handle.retainedCount()).toBe(20);
		// The oldest were dropped, so closing one of them changes nothing.
		created[0].emit('close');
		expect(handle.retainedCount()).toBe(20);
		created[24].emit('close');
		expect(handle.retainedCount()).toBe(19);
	});
});

describe('createNotifier clicks', () => {
	it("calls the handler with clickPath()'s path on every click", async () => {
		const { handle, last } = setup();
		const handler = vi.fn();
		handle.setClickHandler(handler);
		void handle.notifier.show(notice());
		last().emit('show');
		last().emit('click');
		await flush();
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith('/watches/w1');
		last().emit('click');
		await flush();
		expect(handler).toHaveBeenCalledTimes(2);
		expect(handler).toHaveBeenLastCalledWith('/watches/w1');
	});

	it.each([
		['a rejecting clickPath', () => Promise.reject(new Error('db gone'))],
		['a protocol-relative path', async () => '//evil.example/x'],
		['a backslash protocol-relative path', async () => '/\\evil.example/x'],
		['an absolute URL', async () => 'https://evil.example/'],
		['a relative path', async () => 'watches/w1'],
		['an empty path', async () => '']
	])('opens / for %s', async (_label, clickPath) => {
		const { handle, last } = setup();
		const handler = vi.fn();
		handle.setClickHandler(handler);
		void handle.notifier.show(notice(clickPath));
		last().emit('show');
		last().emit('click');
		await flush();
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith('/');
	});

	it('keeps a click that came before setClickHandler and delivers it then', async () => {
		const { handle, last } = setup();
		void handle.notifier.show(notice());
		last().emit('show');
		expect(() => last().emit('click')).not.toThrow();
		await flush();
		const handler = vi.fn();
		handle.setClickHandler(handler);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith('/watches/w1');
		// Delivered once: a later handler does not get it again.
		const later = vi.fn();
		handle.setClickHandler(later);
		expect(later).not.toHaveBeenCalled();
	});

	it('survives a throwing click handler', async () => {
		const { handle, last } = setup();
		const handler = vi.fn(() => {
			throw new Error('window gone');
		});
		handle.setClickHandler(handler);
		void handle.notifier.show(notice());
		last().emit('show');
		last().emit('click');
		await flush();
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
