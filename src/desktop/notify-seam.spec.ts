import type { Notification as ElectronNotification } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';
import {
	E2E_NOTIFICATIONS_KEY,
	E2E_NOTIFY_ENV,
	notificationClassFor,
	type E2eNotifications,
	type NotificationCtor,
	type NotificationLike
} from './notify-seam.ts';

// Compile-time only (pnpm check): Electron's real Notification class must satisfy
// the structural slice main.ts passes in.
const realClassFits = (n: typeof ElectronNotification): NotificationCtor => n;
void realClassFits;

/** Stands in for Electron's class: identity is all these tests compare. */
class RealNotification implements NotificationLike {
	static isSupported(): boolean {
		return true;
	}
	constructor(readonly options: { title: string; body: string }) {}
	on(): this {
		return this;
	}
	show(): void {}
}

type Holder = { [E2E_NOTIFICATIONS_KEY]?: E2eNotifications };

function records(): E2eNotifications {
	const found = (globalThis as Holder)[E2E_NOTIFICATIONS_KEY];
	if (!found) throw new Error('recorder did not publish its records');
	return found;
}

function seam(isPackaged: boolean, value: string | undefined): NotificationCtor {
	const env: NodeJS.ProcessEnv = value === undefined ? {} : { [E2E_NOTIFY_ENV]: value };
	return notificationClassFor({ isPackaged, env, Notification: RealNotification });
}

afterEach(() => {
	delete (globalThis as Holder)[E2E_NOTIFICATIONS_KEY];
});

describe('notificationClassFor', () => {
	it('reads the documented variable and registry key', () => {
		expect(E2E_NOTIFY_ENV).toBe('PRICE_CHECK_E2E_NOTIFY');
		expect(E2E_NOTIFICATIONS_KEY).toBe(Symbol.for('price-check.e2e-notifications'));
	});

	it.each(['record', 'unsupported'])(
		'a packaged run ignores PRICE_CHECK_E2E_NOTIFY=%s and gets the real class',
		(value) => {
			expect(seam(true, value)).toBe(RealNotification);
			expect((globalThis as Holder)[E2E_NOTIFICATIONS_KEY]).toBeUndefined();
		}
	);

	it.each([
		['unset', undefined],
		['empty', ''],
		['yes', 'yes'],
		['RECORD', 'RECORD'],
		['padded', ' record ']
	])('an unpackaged run with the variable %s gets the real class', (_label, value) => {
		expect(seam(false, value)).toBe(RealNotification);
		expect((globalThis as Holder)[E2E_NOTIFICATIONS_KEY]).toBeUndefined();
	});

	it.each(['record', 'unsupported'])('an unpackaged run with %s gets the recorder', (value) => {
		const Notification = seam(false, value);

		expect(Notification).not.toBe(RealNotification);
		expect(records().shown).toEqual([]);
	});
});

describe('record mode', () => {
	it('reports notifications supported', () => {
		expect(seam(false, 'record').isSupported()).toBe(true);
	});

	it('appends each show() with its exact title and body, in order', () => {
		const Notification = seam(false, 'record');
		const title = 'Price drop: <b>Kettle</b> & "Toaster"';
		const body = '£9.00 — target £10.00\nsecond line';

		new Notification({ title, body }).show();
		new Notification({ title: 'second', body: '' }).show();

		expect(records().shown).toEqual([
			{ title, body },
			{ title: 'second', body: '' }
		]);
	});

	it('records nothing for a notification constructed but never shown', () => {
		const Notification = seam(false, 'record');

		new Notification({ title: 't', body: 'b' });

		expect(records().shown).toEqual([]);
	});

	it("emits 'show' to the instance's listener after show() returns", async () => {
		const Notification = seam(false, 'record');
		const n = new Notification({ title: 't', body: 'b' });
		let shows = 0;
		n.on('show', () => shows++);

		n.show();
		expect(shows).toBe(0);
		await Promise.resolve();

		expect(shows).toBe(1);
	});

	it("click(i) fires 'click' on the i-th shown instance only", async () => {
		const Notification = seam(false, 'record');
		const clicks = [0, 0, 0];
		for (const i of [0, 1, 2]) {
			const n = new Notification({ title: `n${i}`, body: '' });
			n.on('click', () => clicks[i]++);
			n.show();
		}

		await records().click(1);
		expect(clicks).toEqual([0, 1, 0]);

		await records().click(1);
		await records().click(2);
		expect(clicks).toEqual([0, 2, 1]);
	});

	it('indexes click by show order, not construction order', async () => {
		const Notification = seam(false, 'record');
		const first = new Notification({ title: 'built first', body: '' });
		const second = new Notification({ title: 'built second', body: '' });
		const clicked: string[] = [];
		first.on('click', () => clicked.push('first'));
		second.on('click', () => clicked.push('second'));
		second.show();
		first.show();

		await records().click(0);

		expect(records().shown[0].title).toBe('built second');
		expect(clicked).toEqual(['second']);
	});

	it('calls every click listener on that instance, and none for other events', async () => {
		const Notification = seam(false, 'record');
		const n = new Notification({ title: 't', body: 'b' });
		const calls: string[] = [];
		n.on('click', () => calls.push('a'));
		n.on('click', () => calls.push('b'));
		n.on('close', () => calls.push('close'));
		n.on('failed', () => calls.push('failed'));
		n.show();

		await records().click(0);

		expect(calls).toEqual(['a', 'b']);
	});

	it.each([
		['never shown', 3],
		['negative', -1],
		['fractional', 0.5],
		['NaN', Number.NaN]
	])('click rejects naming the index (%s) instead of throwing', async (_label, index) => {
		const Notification = seam(false, 'record');
		new Notification({ title: 't', body: 'b' }).show();

		let result: Promise<void> | undefined;
		expect(() => {
			result = records().click(index);
		}).not.toThrow();

		await expect(result).rejects.toThrow(`index ${String(index)}`);
	});

	it('click rejects with no notifications shown at all', async () => {
		seam(false, 'record');

		await expect(records().click(0)).rejects.toThrow('index 0');
	});

	it('a later recorder replaces the earlier records', () => {
		const First = seam(false, 'record');
		new First({ title: 'old', body: '' }).show();

		seam(false, 'record');

		expect(records().shown).toEqual([]);
	});
});

describe('unsupported mode', () => {
	it('reports notifications unsupported', () => {
		expect(seam(false, 'unsupported').isSupported()).toBe(false);
	});

	it('still records a show, so a notifier that ignores isSupported() is caught', () => {
		const Notification = seam(false, 'unsupported');

		new Notification({ title: 't', body: 'b' }).show();

		expect(records().shown).toEqual([{ title: 't', body: 'b' }]);
	});
});
