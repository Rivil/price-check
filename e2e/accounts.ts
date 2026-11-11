// Seeded e2e credentials, shared by e2e/seed.ts (Node type stripping) and the
// Playwright specs. Test-only values for a throwaway database.
import type { Page } from '@playwright/test';

export const E2E_ORIGIN = 'http://localhost:4173';
export const E2E_DATABASE_URL = 'file:e2e/.data/e2e.db';
export const E2E_SECRET = 'e2e-only-better-auth-secret-0123456789abcdef';
/** Test-only ALERTS_ENCRYPTION_KEY (base64 of 32 bytes) for the throwaway e2e database. */
export const E2E_ALERTS_KEY = Buffer.from('e2e-only-alerts-key-0123456789ab').toString('base64');

export const SEEDED_ADMIN = {
	email: 'admin@e2e.test',
	name: 'E2E Admin',
	password: 'e2e-admin-password',
	role: 'admin'
} as const;

export const SEEDED_MEMBER = {
	email: 'member@e2e.test',
	name: 'E2E Member',
	password: 'e2e-member-password',
	role: 'user'
} as const;

/** Owns watches the member must never see or change (cross-user tests). */
export const SEEDED_OTHER = {
	email: 'other@e2e.test',
	name: 'E2E Other',
	password: 'e2e-other-password',
	role: 'user'
} as const;

/**
 * An unbroken run of letters exactly `length` long: no spaces or hyphens, so the
 * browser has no break opportunity and the 375px layout checks can't go vacuous.
 */
function unbroken(prefix: string, length: number): string {
	return (prefix + 'Abcdefghij'.repeat(Math.ceil(length / 10))).slice(0, length);
}

/**
 * app-design's edge-case user: owns the layout watches and a long ntfy topic.
 * Seeded after the member, so harness 'fresh seed' still counts two seed users.
 */
export const SEEDED_DESIGN = {
	email: 'design@e2e.test',
	name: 'E2E Design',
	password: 'e2e-design-password',
	role: 'user'
} as const;

/** Listed in the admin table: a long unbroken name and email (app-design c-4). */
export const SEEDED_LONG_ACCOUNT = {
	// Lower-case: better-auth stores emails lower-cased, and specs look this one up.
	email: `${unbroken('longaccount', 50)}@${unbroken('layout', 30)}.e2e.test`.toLowerCase(),
	name: unbroken('E2ELongAccountName', 60),
	password: 'e2e-long-account-password',
	role: 'user'
} as const;

/**
 * SEEDED_DESIGN's ntfy topic link, 150 chars with no whitespace. The topic itself
 * stays within ntfy's 64-char rule (a long self-hosted base path carries the rest),
 * so resubmitting it unchanged on /account/alerts saves. The host is .invalid (r-01).
 */
export const SEEDED_DESIGN_TOPIC_URL = `https://ntfy.e2e.invalid/${unbroken('basepath', 60)}/${unbroken('topic', 64)}`;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A stamp relative to seeding: range and overdue checks must hold on any day the suite runs. */
export type Ago = { msAgo: number };
const ago = (msAgo: number): Ago => ({ msAgo });

/**
 * Watches inserted directly by e2e/seed.ts, keyed by the spec that owns them so
 * no spec edits or deletes another's rows. Image hosts are .invalid: a browser
 * rendering the list must never reach Amazon (r-01).
 */
export const SEEDED_WATCHES = {
	/** watchlist.e2e.ts: the member's priced watch. */
	listPriced: {
		id: 'e2e-list-priced',
		owner: 'member',
		productId: 'B0E2ELIST1',
		title: 'E2E Listed Kettle',
		imageUrl: 'https://images.e2e.invalid/list-priced.jpg',
		pricePence: 129900,
		targetPence: 99900,
		lastCheckedAt: '2026-11-01T09:30:00.000Z',
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** watchlist.e2e.ts: the member's watch whose first check failed (untitled, unpriced). */
	listFailed: {
		id: 'e2e-list-failed',
		owner: 'member',
		productId: 'B0E2ELIST2',
		title: null,
		imageUrl: null,
		pricePence: null,
		targetPence: null,
		lastCheckedAt: '2026-11-01T09:45:00.000Z',
		lastCheckReason: 'blocked',
		lastCheckMessage: 'Amazon showed a captcha page'
	},
	/** watch-page.e2e.ts: details of a priced watch with a target. */
	pageDetail: {
		id: 'e2e-page-detail',
		owner: 'member',
		productId: 'B0E2EPAGE1',
		title: 'E2E Detail Blender',
		imageUrl: 'https://images.e2e.invalid/page-detail.jpg',
		pricePence: 8999,
		targetPence: 7500,
		lastCheckedAt: '2026-11-01T12:00:00.000Z',
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** watch-page.e2e.ts: a watch whose last check failed. */
	pageFailed: {
		id: 'e2e-page-failed',
		owner: 'member',
		productId: 'B0E2EPAGE2',
		title: null,
		imageUrl: null,
		pricePence: null,
		targetPence: null,
		lastCheckedAt: '2026-11-01T12:15:00.000Z',
		lastCheckReason: 'unavailable',
		lastCheckMessage: 'Currently unavailable on amazon.co.uk'
	},
	/** watch-page.e2e.ts: its target is changed and cleared. */
	pageEdit: {
		id: 'e2e-page-edit',
		owner: 'member',
		productId: 'B0E2EPAGE3',
		title: 'E2E Editable Lamp',
		imageUrl: null,
		pricePence: 2500,
		targetPence: 2000,
		lastCheckedAt: '2026-11-01T12:30:00.000Z',
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** watch-page.e2e.ts: deleted by the 'delete' test. */
	pageDelete: {
		id: 'e2e-page-delete',
		owner: 'member',
		productId: 'B0E2EPAGE4',
		title: 'E2E Deletable Mug',
		imageUrl: null,
		pricePence: 999,
		targetPence: null,
		lastCheckedAt: '2026-11-01T12:45:00.000Z',
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** Read-only: a failed check that kept its last known price (scheduled-checks c-3). */
	failedPriced: {
		id: 'e2e-failed-priced',
		owner: 'member',
		productId: 'B0E2EFPRC1',
		title: 'E2E Kept Price Toaster',
		imageUrl: null,
		pricePence: 4500,
		targetPence: null,
		lastCheckedAt: '2026-11-01T13:00:00.000Z',
		lastCheckReason: 'fetch_failed',
		lastCheckMessage: 'request timed out after 15000ms'
	},
	/**
	 * watch-page.e2e.ts 'check now cooldown': seed.ts stamps its last check one day
	 * AFTER the seed runs, so Check now is refused however long build + suite take
	 * and can never run a live check (r-01).
	 */
	pageCooldown: {
		id: 'e2e-page-cooldown',
		owner: 'member',
		productId: 'B0E2ECOOL1',
		title: 'E2E Cooldown Radio',
		imageUrl: null,
		pricePence: 3000,
		targetPence: null,
		lastCheckedAt: 'one day after seeding',
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** app-design layout checks: a 240-char unbroken title and failure message. */
	layoutLong: {
		id: 'e2e-layout-long',
		owner: 'design',
		productId: 'B0E2ELAYT1',
		title: unbroken('E2ELayoutLongTitle', 240),
		imageUrl: 'https://images.e2e.invalid/layout-long.jpg',
		pricePence: 12999,
		targetPence: 9999,
		// After its last point, so its two failures have no success between them.
		lastCheckedAt: '2026-11-01T15:00:00.000Z',
		lastCheckReason: 'blocked',
		lastCheckMessage: unbroken('AmazonServedAnUnbrokenFailureMessage', 200)
	},
	/** app-design: Check now is refused (last checked one day after seeding, r-01). */
	layoutCooldown: {
		id: 'e2e-layout-cooldown',
		owner: 'design',
		productId: 'B0E2ELAYT2',
		title: 'E2E Layout Cooldown Speaker',
		imageUrl: null,
		pricePence: 5000,
		targetPence: null,
		lastCheckedAt: 'one day after seeding',
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** app-design: a successful check at or below target (the green 'at or below target' label). */
	layoutAtTarget: {
		id: 'e2e-layout-at-target',
		owner: 'design',
		productId: 'B0E2ELAYT3',
		title: 'E2E Layout Bargain Kettle',
		imageUrl: null,
		pricePence: 1999,
		targetPence: 2499,
		lastCheckedAt: '2026-11-01T14:30:00.000Z',
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/**
	 * The chart's range, target and failure checks: history in every range bucket,
	 * two consecutive failures, and a latest mark at the right edge whose long
	 * unbroken reason tests the tooltip. Check now is never clicked here (r-01).
	 */
	chartFull: {
		id: 'e2e-chart-full',
		owner: 'member',
		productId: 'B0E2ECHRT1',
		title: 'E2E Chart Full Speaker',
		imageUrl: null,
		pricePence: 10999,
		targetPence: 9999,
		lastCheckedAt: ago(0),
		lastCheckReason: 'blocked',
		lastCheckMessage: unbroken('AmazonServedAnEdgeOfChartFailureMessage', 200)
	},
	/** A chart with no target line. */
	chartNoTarget: {
		id: 'e2e-chart-no-target',
		owner: 'member',
		productId: 'B0E2ECHRT2',
		title: 'E2E Chart Untargeted Fan',
		imageUrl: null,
		pricePence: 4500,
		targetPence: null,
		lastCheckedAt: ago(HOUR),
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** A year of 6-hourly checks: far denser than a finger can pick out by mark. */
	chartDense: {
		id: 'e2e-chart-dense',
		owner: 'member',
		productId: 'B0E2ECHRT3',
		title: 'E2E Chart Dense Heater',
		imageUrl: null,
		pricePence: 10475,
		targetPence: null,
		lastCheckedAt: ago(HOUR),
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** Checked well inside the 6-hour interval. */
	cardFresh: {
		id: 'e2e-card-fresh',
		owner: 'member',
		productId: 'B0E2ECARD1',
		title: 'E2E Card Fresh Grinder',
		imageUrl: null,
		pricePence: 1900,
		targetPence: null,
		lastCheckedAt: ago(HOUR),
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** Past the interval and its hour of grace (overdue_grace). */
	cardOverdue: {
		id: 'e2e-card-overdue',
		owner: 'member',
		productId: 'B0E2ECARD2',
		title: 'E2E Card Overdue Scale',
		imageUrl: null,
		pricePence: 2800,
		targetPence: null,
		lastCheckedAt: ago(8 * HOUR),
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** Late, but inside the grace for as long as the suite can plausibly run. */
	cardInGrace: {
		id: 'e2e-card-in-grace',
		owner: 'member',
		productId: 'B0E2ECARD3',
		title: 'E2E Card In Grace Whisk',
		imageUrl: null,
		pricePence: 3300,
		targetPence: null,
		lastCheckedAt: ago(6 * HOUR + 5 * 60 * 1000),
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** Has a price and history, but nothing in the sparkline's 30 days. */
	cardStale: {
		id: 'e2e-card-stale',
		owner: 'member',
		productId: 'B0E2ECARD4',
		title: 'E2E Card Stale Peeler',
		imageUrl: null,
		pricePence: 2500,
		targetPence: null,
		lastCheckedAt: ago(40 * DAY),
		lastCheckReason: null,
		lastCheckMessage: null
	},
	/** Owned by SEEDED_OTHER; never visible to the member. */
	otherPriced: {
		id: 'e2e-other-priced',
		owner: 'other',
		productId: 'B0E2EOTHR1',
		title: 'E2E Other Users Toaster',
		imageUrl: 'https://images.e2e.invalid/other-priced.jpg',
		pricePence: 4999,
		targetPence: 3999,
		lastCheckedAt: '2026-11-01T10:00:00.000Z',
		lastCheckReason: null,
		lastCheckMessage: null
	}
} as const;

export type SeededWatch = (typeof SEEDED_WATCHES)[keyof typeof SEEDED_WATCHES];

/** Price history inserted by e2e/seed.ts (watch-page.e2e.ts 'history'). */
export const SEEDED_POINTS = [
	{
		id: 'e2e-pt-1',
		watchId: 'e2e-page-detail',
		pricePence: 9999,
		checkedAt: '2026-10-31T09:00:00.000Z'
	},
	{
		id: 'e2e-pt-2',
		watchId: 'e2e-page-detail',
		pricePence: 8999,
		checkedAt: '2026-11-01T12:00:00.000Z'
	},
	{
		id: 'e2e-pt-3',
		watchId: 'e2e-page-detail',
		pricePence: 9499,
		checkedAt: '2026-10-31T21:00:00.000Z'
	},
	{
		id: 'e2e-pt-layout-1',
		watchId: 'e2e-layout-long',
		pricePence: 13999,
		checkedAt: '2026-10-30T14:00:00.000Z'
	},
	{
		id: 'e2e-pt-layout-2',
		watchId: 'e2e-layout-long',
		pricePence: 12999,
		checkedAt: '2026-10-31T14:00:00.000Z'
	},
	{
		id: 'e2e-pt-layout-3',
		watchId: 'e2e-layout-long',
		pricePence: 12999,
		checkedAt: '2026-11-01T14:00:00.000Z'
	}
] as const;

function pointsAgo(watchId: string, points: [msAgo: number, pricePence: number][]) {
	return points.map(([msAgo, pricePence], i) => ({
		id: `${watchId}-pt-${i}`,
		watchId,
		pricePence,
		msAgo
	}));
}

/** Price history stamped relative to seeding. */
export const SEEDED_RELATIVE_POINTS = [
	...pointsAgo(SEEDED_WATCHES.chartFull.id, [
		[120 * DAY, 15000],
		[100 * DAY, 14000],
		[60 * DAY, 13000],
		[45 * DAY, 12500],
		[20 * DAY, 11999],
		[10 * DAY, 11500],
		[5 * DAY, 10999]
	]),
	...pointsAgo(SEEDED_WATCHES.chartNoTarget.id, [
		[10 * DAY, 5000],
		[HOUR, 4500]
	]),
	...pointsAgo(
		SEEDED_WATCHES.chartDense.id,
		Array.from({ length: 1460 }, (_, i) => [(1459 - i) * 6 * HOUR + HOUR, 10000 + (i % 40) * 25])
	),
	...pointsAgo(SEEDED_WATCHES.cardFresh.id, [
		[20 * DAY, 2000],
		[10 * DAY, 1800],
		[HOUR, 1900]
	]),
	...pointsAgo(SEEDED_WATCHES.cardOverdue.id, [
		[10 * DAY, 3000],
		[8 * HOUR, 2800]
	]),
	...pointsAgo(SEEDED_WATCHES.cardInGrace.id, [
		[10 * DAY, 3500],
		[6 * HOUR + 5 * 60 * 1000, 3300]
	]),
	...pointsAgo(SEEDED_WATCHES.cardStale.id, [
		[50 * DAY, 2600],
		[40 * DAY, 2500]
	])
];

/**
 * Failed checks beyond each watch's current one: seed.ts gives every watch with a
 * lastCheckReason that row itself, as the 0006 backfill would.
 */
export const SEEDED_FAILURES: {
	id: string;
	watchId: string;
	reason: string;
	message: string | null;
	checkedAt: string | Ago;
}[] = [
	{
		id: 'e2e-fail-chart-1',
		watchId: SEEDED_WATCHES.chartFull.id,
		reason: 'fetch_failed',
		message: 'request timed out after 15000ms',
		checkedAt: ago(95 * DAY)
	},
	// A consecutive pair: no success between 10 and 5 days ago but these two.
	{
		id: 'e2e-fail-chart-2',
		watchId: SEEDED_WATCHES.chartFull.id,
		reason: 'blocked',
		message: 'Amazon showed a captcha page',
		checkedAt: ago(8 * DAY)
	},
	{
		id: 'e2e-fail-chart-3',
		watchId: SEEDED_WATCHES.chartFull.id,
		reason: 'unavailable',
		message: null,
		checkedAt: ago(7 * DAY)
	},
	{
		id: 'e2e-fail-layout-1',
		watchId: SEEDED_WATCHES.layoutLong.id,
		reason: 'fetch_failed',
		message: null,
		checkedAt: '2026-11-01T14:30:00.000Z'
	}
];

/** An email no other test (or earlier run) has used. */
export function uniqueEmail(prefix = 'user') {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@e2e.test`;
}

export interface Credentials {
	email: string;
	password: string;
}

/**
 * Fills and submits the /login form. Going through the form (a SvelteKit action
 * calling auth.api) avoids better-auth's per-IP HTTP sign-in rate limit.
 */
export async function submitLogin(page: Page, { email, password }: Credentials) {
	await page.goto('/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in through the /login form and waits to land on the home page. */
export async function signIn(page: Page, credentials: Credentials) {
	await submitLogin(page, credentials);
	await page.waitForURL((url) => url.pathname === '/');
}
