// The amazon.co.uk shop adapter. Imported by the adapter:check CLI, so it runs
// under Node type stripping: no $app/* or $env/* imports, explicit .ts
// extensions, erasable syntax only.
import { fileURLToPath } from 'node:url';
import {
	clientErrorKind,
	failure,
	type CheckResult,
	type ShopAdapter,
	type ShopClient,
	type ShopResponse
} from '../types.ts';
import { classifyProductPage, isBotWall } from './classify.ts';
import { resolveShortLink } from './short-link.ts';
import { canonicalAmazonUrl, normaliseAmazonUrl } from './url.ts';
import { clickThroughUrl, createCookieJar, type CookieJar } from './wall.ts';

export const AMAZON_UK = 'amazon-uk';

/** A desktop browser's headers. Never an account's cookies: every check is a logged-out view. */
export const REQUEST_HEADERS: Record<string, string> = {
	'user-agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	'accept-language': 'en-GB,en;q=0.9',
	accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

const AMAZON_UK_HOST = /^(?:www\.|smile\.)?amazon\.co\.uk$/;

function isAmazonUk(href: string): boolean {
	try {
		const url = new URL(href);
		return (
			(url.protocol === 'https:' || url.protocol === 'http:') && AMAZON_UK_HOST.test(url.hostname)
		);
	} catch {
		return false;
	}
}

/**
 * Where the fetched page actually landed. Only the requested ASIN's own product
 * page is trusted: another product, a sign-in interstitial or any other
 * amazon.co.uk page would report its price under the wrong ASIN.
 */
function landing(href: string, asin: string): 'requested' | 'other-page' | 'off-site' {
	const target = normaliseAmazonUrl(href);
	if (target.kind === 'product' && target.asin === asin) return 'requested';
	return isAmazonUk(href) ? 'other-page' : 'off-site';
}

/**
 * The URL actually fetched: the canonical /dp/<ASIN> plus psc=1 ("product
 * selected child"). Without it, a logged-out request for a size/colour variant's
 * ASIN is answered with the variation parent's price-range page.
 */
export function productPageUrl(asin: string): string {
	return `${canonicalAmazonUrl(asin)}?psc=1`;
}

function requestHeaders(jar: CookieJar): Record<string, string> {
	const cookie = jar.header();
	return cookie === null ? REQUEST_HEADERS : { ...REQUEST_HEADERS, cookie };
}

async function fetchPage(url: string, client: ShopClient, jar: CookieJar): Promise<ShopResponse> {
	const response = await client.request(url, { method: 'GET', headers: requestHeaders(jar) });
	jar.store(response.headers);
	return response;
}

/** Submits the wall's form; a redirect means it took. The redirect itself isn't followed. */
async function submitWall(
	submitUrl: string,
	pageUrl: string,
	client: ShopClient,
	jar: CookieJar
): Promise<boolean> {
	const response = await client.request(submitUrl, {
		method: 'GET',
		redirect: 'manual',
		readBody: false,
		headers: { ...requestHeaders(jar), referer: pageUrl }
	});
	jar.store(response.headers);
	return response.status === 302;
}

async function checkProduct(
	asin: string,
	canonicalUrl: string,
	client: ShopClient,
	jar: CookieJar
): Promise<CheckResult> {
	// Only the product page URL: tracking params and slugs never reach Amazon.
	const pageUrl = productPageUrl(asin);
	let response;
	try {
		response = await fetchPage(pageUrl, client, jar);
		// One attempt only: a wall that comes back is reported as blocked below.
		const submitUrl = clickThroughUrl(response.body ?? '');
		if (submitUrl !== null && (await submitWall(submitUrl, pageUrl, client, jar))) {
			response = await fetchPage(pageUrl, client, jar);
		}
	} catch (error) {
		const kind = clientErrorKind(error);
		if (kind === 'timeout') return failure('fetch_failed', 'product page request timed out');
		return failure('fetch_failed', 'product page request failed (network error)');
	}

	const body = response.body ?? '';
	// Amazon serves its robot check with a 200 or a 503: look before mapping the status.
	if (isBotWall(body)) return failure('blocked', 'Amazon served a robot-check (captcha) page');
	if (response.status === 404) return failure('not_found', 'product not found (HTTP 404)');
	if (response.status < 200 || response.status > 299) {
		return failure('fetch_failed', `product page returned HTTP ${response.status}`);
	}
	const landed = landing(response.url, asin);
	if (landed === 'off-site') {
		return failure('fetch_failed', 'product page redirected off amazon.co.uk');
	}
	if (landed === 'other-page') {
		return failure('fetch_failed', 'product page redirected to a different page');
	}

	const page = classifyProductPage(body);
	if (!page.ok) return page;
	return {
		ok: true,
		shop: AMAZON_UK,
		productId: asin,
		canonicalUrl,
		title: page.title,
		pricePence: page.pricePence,
		imageUrl: page.imageUrl
	};
}

/** An adapter with its own cookie jar, so a cleared wall stays cleared between its checks. */
export function createAmazonAdapter(jar: CookieJar = createCookieJar()): ShopAdapter {
	return {
		id: AMAZON_UK,
		fixturesDir: fileURLToPath(new URL('./fixtures/', import.meta.url)),

		claims(url) {
			return normaliseAmazonUrl(url.href).kind !== 'unsupported';
		},

		identify(url) {
			const target = normaliseAmazonUrl(url.href);
			return target.kind === 'product'
				? { productId: target.asin, canonicalUrl: target.canonicalUrl }
				: null;
		},

		async check(url, { client }) {
			const target = normaliseAmazonUrl(url.href);
			if (target.kind === 'unsupported') return failure('unsupported', 'unsupported URL');
			if (target.kind === 'product') {
				return checkProduct(target.asin, target.canonicalUrl, client, jar);
			}

			const resolved = await resolveShortLink(target.url, client);
			if (!resolved.ok) return resolved;
			return checkProduct(resolved.asin, resolved.canonicalUrl, client, jar);
		}
	};
}

export const amazonAdapter = createAmazonAdapter();
