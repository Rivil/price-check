// Resolves amzn.eu / amzn.to share links to an amazon.co.uk product, one
// redirect-only hop at a time through the rate-limited client (locked decision
// short_links). Imported by the adapter:check CLI, so it runs under Node type
// stripping: no $app/* or $env/* imports, explicit .ts extensions, erasable
// syntax only.
import { clientErrorKind, failure, type CheckFailure, type ShopClient } from '../types.ts';
import { normaliseAmazonUrl } from './url.ts';

export const MAX_SHORT_LINK_HOPS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type ShortLinkResult = { ok: true; asin: string; canonicalUrl: string } | CheckFailure;

/**
 * Follows Location headers hop by hop (fetch never follows them itself, so each
 * hop is queued and rate-limited) and stops at the first amazon.co.uk product
 * URL without requesting it. A landing anywhere else is unsupported.
 */
export async function resolveShortLink(url: string, client: ShopClient): Promise<ShortLinkResult> {
	// Only ever request a short-link host: a product or off-site URL is never fetched here.
	const start = normaliseAmazonUrl(url);
	if (start.kind !== 'short') return failure('unsupported', 'unsupported URL');
	let current = start.url;

	for (let hop = 0; hop < MAX_SHORT_LINK_HOPS; hop++) {
		let status: number;
		let location: string | null;
		try {
			const response = await client.request(current, {
				method: 'GET',
				redirect: 'manual',
				readBody: false
			});
			status = response.status;
			location = response.headers.get('location');
		} catch (error) {
			return clientErrorKind(error) === 'timeout'
				? failure('fetch_failed', 'short link request timed out')
				: failure('fetch_failed', 'short link request failed');
		}

		if (status === 404) return failure('not_found', 'short link not found (HTTP 404)');
		if (!REDIRECT_STATUSES.has(status)) {
			return failure('fetch_failed', `short link did not redirect (HTTP ${status})`);
		}
		if (location === null || location.trim() === '') {
			return failure('fetch_failed', 'short link redirect had no Location header');
		}

		let next: URL;
		try {
			next = new URL(location.trim(), current);
		} catch {
			return failure('unsupported', 'unsupported URL');
		}

		const target = normaliseAmazonUrl(next.href);
		if (target.kind === 'product') {
			return { ok: true, asin: target.asin, canonicalUrl: target.canonicalUrl };
		}
		if (target.kind === 'unsupported') return failure('unsupported', 'unsupported URL');
		current = target.url;
	}

	return failure('fetch_failed', 'too many redirects');
}
