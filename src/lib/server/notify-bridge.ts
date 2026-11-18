// The hand-off for desktop notifications, runtime-bridge in reverse: the Electron
// main process publishes a notifier before it imports the server handler, and the
// server's desktop driver reads it. Two bundles hold two copies of this module, so
// the notifier lives on globalThis under a registry symbol both copies resolve to
// the same key. No imports at all: main bundles this file, and it refuses $app/*
// and libsql, and the server bundle must never pull in electron.

const NOTIFIER_KEY = Symbol.for('price-check.notifier');

/** One notification to show. clickPath resolves the in-app path a click opens. */
export type DesktopNotice = {
	title: string;
	body: string;
	clickPath(): Promise<string>;
};

/** Why a desktop send failed: no OS support, or the OS reported a failure. */
export type DesktopFailure = 'unsupported' | 'failed';

/** What main publishes: shows a notice, resolving once the OS accepts or refuses it. */
export type DesktopNotifier = {
	show(notice: DesktopNotice): Promise<{ ok: true } | { ok: false; reason: DesktopFailure }>;
};

type NotifierHolder = { [NOTIFIER_KEY]?: DesktopNotifier };

/** Publishes main's notifier; called before main imports the server handler. */
export function publishNotifier(notifier: DesktopNotifier): void {
	(globalThis as NotifierHolder)[NOTIFIER_KEY] = notifier;
}

/** The published notifier, or undefined outside Electron (pnpm dev, browser e2e). */
export function readNotifier(): DesktopNotifier | undefined {
	return (globalThis as NotifierHolder)[NOTIFIER_KEY];
}
