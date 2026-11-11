// amazon.co.uk URL normalisation. Imported by the adapter:check CLI, so it runs
// under Node type stripping: no $app/* or $env/* imports, explicit .ts
// extensions, erasable syntax only.

export type NormalisedAmazonUrl =
	| { kind: 'product'; asin: string; canonicalUrl: string }
	| { kind: 'short'; url: string }
	| { kind: 'unsupported' };

/** Hosts that serve amazon.co.uk product pages, matched exactly (URL lower-cases them). */
const PRODUCT_HOSTS = new Set(['amazon.co.uk', 'www.amazon.co.uk', 'smile.amazon.co.uk']);

const ASIN = /^[A-Za-z0-9]{10}$/;

const UNSUPPORTED: NormalisedAmazonUrl = { kind: 'unsupported' };

export function canonicalAmazonUrl(asin: string): string {
	return `https://www.amazon.co.uk/dp/${asin}`;
}

function parse(input: string): URL | null {
	try {
		return new URL(input.trim());
	} catch {
		return null;
	}
}

/** The ASIN from a product path — never the query string or fragment. */
function asinFromPath(pathname: string): string | null {
	const segments = pathname.split('/').filter((segment) => segment !== '');
	let candidate: string | undefined;

	if (segments[0] === 'dp') candidate = segments[1];
	else if (segments[0] === 'gp' && segments[1] === 'product') candidate = segments[2];
	else if (segments[1] === 'dp') candidate = segments[2];

	return candidate !== undefined && ASIN.test(candidate) ? candidate.toUpperCase() : null;
}

function isShortLink(url: URL): boolean {
	const segments = url.pathname.split('/').filter((segment) => segment !== '');

	if (url.hostname === 'amzn.eu') return segments[0] === 'd' && segments.length >= 2;
	if (url.hostname === 'amzn.to') return segments.length >= 1;
	return false;
}

/**
 * Classifies any input as an amazon.co.uk product (with its canonical URL), a
 * short link still to be resolved, or unsupported. Never throws.
 */
export function normaliseAmazonUrl(input: string): NormalisedAmazonUrl {
	const url = parse(input);
	if (url === null) return UNSUPPORTED;
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return UNSUPPORTED;
	// Credentials or an explicit port never belong on a shop link.
	if (url.username !== '' || url.password !== '' || url.port !== '') return UNSUPPORTED;

	if (PRODUCT_HOSTS.has(url.hostname)) {
		const asin = asinFromPath(url.pathname);
		return asin === null
			? UNSUPPORTED
			: { kind: 'product', asin, canonicalUrl: canonicalAmazonUrl(asin) };
	}

	if (isShortLink(url)) return { kind: 'short', url: url.href };

	return UNSUPPORTED;
}
