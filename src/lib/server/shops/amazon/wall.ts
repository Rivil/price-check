// Amazon's button-only "continue shopping" wall: a form with no captcha to solve,
// cleared by submitting it and keeping the cookies it sets. Imported by the
// adapter:check CLI, so it runs under Node type stripping: no $app/* or $env/*
// imports, explicit .ts extensions, erasable syntax only.
import { parse } from 'node-html-parser';

const AMAZON_ORIGIN = 'https://www.amazon.co.uk';

/**
 * The URL that submits the button-only wall, or null for any other page. A form
 * asking for anything beyond its hidden fields is a real captcha: never submitted.
 */
export function clickThroughUrl(html: string): string | null {
	const form = parse(html).querySelector('form[action*="validateCaptcha"]');
	if (form === null || form.getAttribute('method')?.toLowerCase() !== 'get') return null;
	if (form.querySelector('img') !== null) return null;

	const inputs = form.querySelectorAll('input');
	if (inputs.some((input) => input.getAttribute('type') !== 'hidden')) return null;

	const url = new URL(form.getAttribute('action') ?? '', AMAZON_ORIGIN);
	if (url.origin !== AMAZON_ORIGIN) return null;
	for (const input of inputs) {
		url.searchParams.set(input.getAttribute('name') ?? '', input.getAttribute('value') ?? '');
	}
	return url.href;
}

export type CookieJar = {
	/** Keeps every cookie a response set, replacing any of the same name. */
	store(headers: Headers): void;
	/** The Cookie header value, or null with nothing kept. */
	header(): string | null;
};

/** Memory only: cookies are never written to disk or logged, and a restart just clicks again. */
export function createCookieJar(): CookieJar {
	const cookies = new Map<string, string>();
	return {
		store(headers) {
			for (const line of headers.getSetCookie()) {
				const [pair] = line.split(';');
				const split = pair.indexOf('=');
				if (split > 0) cookies.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
			}
		},
		header() {
			if (cookies.size === 0) return null;
			return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
		}
	};
}
