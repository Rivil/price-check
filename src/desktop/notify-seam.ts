// The e2e seam for desktop notifications (spec c-1, c-2, c-5). An unpackaged run
// (pnpm dev, the Electron e2e suite) started with PRICE_CHECK_E2E_NOTIFY=record or
// =unsupported swaps Electron's Notification class for a recorder, so the suite can
// read what was shown and click it on every OS, with no notification daemon and no
// OS permission prompt. 'unsupported' also makes isSupported() false, to drive the
// Send test failure path.
//
// A packaged app never reads the variable: isPackaged is checked first, so a stray
// environment cannot silence a real user's notifications.
//
// The records live on globalThis under a registry symbol, so the e2e suite reaches
// them through electronApp.evaluate:
//   globalThis[Symbol.for('price-check.e2e-notifications')].shown  -> {title, body}[]
//   globalThis[Symbol.for('price-check.e2e-notifications')].click(i) -> Promise<void>
//
// Runs in the Electron main bundle: no imports, Electron is injected structurally.

export const E2E_NOTIFY_ENV = 'PRICE_CHECK_E2E_NOTIFY';
export const E2E_NOTIFICATIONS_KEY = Symbol.for('price-check.e2e-notifications');

/** The slice of an Electron Notification instance the notifier uses. */
export type NotificationLike = {
	on(event: 'show' | 'click' | 'close', listener: () => void): unknown;
	on(event: 'failed', listener: (event: unknown, error: string) => void): unknown;
	show(): void;
};

/** The slice of Electron's Notification class the notifier uses. */
export type NotificationCtor = {
	isSupported(): boolean;
	new (options: { title: string; body: string }): NotificationLike;
};

export type ShownNotification = { title: string; body: string };

/** What the recorder publishes for the e2e suite. */
export type E2eNotifications = {
	/** Every show(), in order: title and body exactly as given. */
	readonly shown: ShownNotification[];
	/** Emits 'click' on the index-th shown notification; rejects for an index never shown. */
	click(index: number): Promise<void>;
};

type SeamMode = 'record' | 'unsupported';

export type NotificationClassInput<C extends NotificationCtor> = {
	/** Electron's app.isPackaged. */
	isPackaged: boolean;
	env: NodeJS.ProcessEnv;
	/** Electron's real Notification class. */
	Notification: C;
};

function seamMode(isPackaged: boolean, env: NodeJS.ProcessEnv): SeamMode | null {
	if (isPackaged) return null;
	const value = env[E2E_NOTIFY_ENV];
	return value === 'record' || value === 'unsupported' ? value : null;
}

type Listener = (...args: unknown[]) => void;

function createRecorder(mode: SeamMode): NotificationCtor {
	const shown: ShownNotification[] = [];
	const shownInstances: RecordingNotification[] = [];

	class RecordingNotification {
		private readonly listeners = new Map<string, Listener[]>();

		static isSupported(): boolean {
			return mode !== 'unsupported';
		}

		constructor(private readonly options: { title: string; body: string }) {}

		on(event: string, listener: (...args: never[]) => void): this {
			const list = this.listeners.get(event) ?? [];
			list.push(listener as Listener);
			this.listeners.set(event, list);
			return this;
		}

		emit(event: string): void {
			for (const listener of [...(this.listeners.get(event) ?? [])]) listener({});
		}

		show(): void {
			shown.push({ title: this.options.title, body: this.options.body });
			shownInstances.push(this);
			// Electron reports 'show' asynchronously, after show() returns.
			queueMicrotask(() => this.emit('show'));
		}
	}

	const records: E2eNotifications = {
		shown,
		async click(index) {
			const target = Number.isInteger(index) ? shownInstances[index] : undefined;
			if (!target) {
				throw new Error(
					`no e2e notification at index ${String(index)} (${shownInstances.length} shown)`
				);
			}
			target.emit('click');
		}
	};
	(globalThis as { [E2E_NOTIFICATIONS_KEY]?: E2eNotifications })[E2E_NOTIFICATIONS_KEY] = records;

	return RecordingNotification;
}

/**
 * Electron's Notification class, or the recorder when this is an unpackaged run with
 * PRICE_CHECK_E2E_NOTIFY set to 'record' or 'unsupported'. Any other value, and any
 * packaged run, gets the real class.
 */
export function notificationClassFor<C extends NotificationCtor>({
	isPackaged,
	env,
	Notification
}: NotificationClassInput<C>): C {
	const mode = seamMode(isPackaged, env);
	if (mode === null) return Notification;
	return createRecorder(mode) as C;
}
