import { describe, expect, it } from 'vitest';
import { clickThroughUrl, createCookieJar } from './wall.ts';

const fixtures = Object.fromEntries(
	Object.entries(
		// Stryker disable next-line all: import.meta.glob needs literal args for Vite's static transform
		import.meta.glob<string>('./fixtures/*.html', { query: '?raw', import: 'default', eager: true })
	).map(([path, html]) => [path.replace(/^\.\/fixtures\//, '').replace(/\.html$/, ''), html])
);

const form = (attrs: string, inner = '<input type="hidden" name="a" value="1">') =>
	`<form ${attrs}>${inner}</form>`;
const WALL = 'method="get" action="/errors_page/validateCaptcha"';

describe('clickThroughUrl', () => {
	it('builds the submit URL from the recorded wall', () => {
		const url = new URL(clickThroughUrl(fixtures['recorded-captcha-continue']) as string);

		expect(url.origin + url.pathname).toBe('https://www.amazon.co.uk/errors_page/validateCaptcha');
		expect([...url.searchParams.keys()]).toEqual(['amzn', 'amzn-r', 'field-keywords']);
		expect(url.searchParams.get('amzn-r')).toBe('/');
		expect(url.searchParams.get('field-keywords')).toBe('BJLEFX');
	});

	it('accepts an uppercase method', () => {
		expect(clickThroughUrl(form('method="GET" action="/errors/validateCaptcha"'))).toBe(
			'https://www.amazon.co.uk/errors/validateCaptcha?a=1'
		);
	});

	it('refuses every fixture that is not the wall', () => {
		for (const [name, html] of Object.entries(fixtures)) {
			if (name !== 'recorded-captcha-continue') expect(clickThroughUrl(html), name).toBeNull();
		}
	});

	it('refuses a form a person has to fill in', () => {
		expect(clickThroughUrl(form(WALL, '<input type="text" name="field-keywords">'))).toBeNull();
		expect(clickThroughUrl(form(WALL, '<input name="field-keywords">'))).toBeNull();
		expect(clickThroughUrl(form(WALL, '<img src="captcha.jpg">'))).toBeNull();
	});

	it('refuses anything that is not a GET to amazon.co.uk', () => {
		expect(clickThroughUrl(form('action="/errors/validateCaptcha"'))).toBeNull();
		expect(clickThroughUrl(form('method="post" action="/errors/validateCaptcha"'))).toBeNull();
		expect(
			clickThroughUrl(form('method="get" action="https://evil.example/validateCaptcha"'))
		).toBeNull();
	});

	it('refuses a page with no such form', () => {
		expect(clickThroughUrl('')).toBeNull();
		expect(clickThroughUrl(form('method="get" action="/s"'))).toBeNull();
	});
});

describe('createCookieJar', () => {
	const headers = (...cookies: string[]) => {
		const result = new Headers();
		for (const cookie of cookies) result.append('set-cookie', cookie);
		return result;
	};

	it('starts empty', () => {
		expect(createCookieJar().header()).toBeNull();
	});

	it('keeps name and value only, and a value may hold an equals sign', () => {
		const jar = createCookieJar();
		jar.store(headers('a=1; path=/; secure', 'b=x=y==; domain=.amazon.co.uk'));
		expect(jar.header()).toBe('a=1; b=x=y==');
	});

	it('replaces a cookie of the same name', () => {
		const jar = createCookieJar();
		jar.store(headers('a=1'));
		jar.store(headers('a=2'));
		expect(jar.header()).toBe('a=2');
	});

	it('ignores a line with no name', () => {
		const jar = createCookieJar();
		jar.store(headers('=1', 'bare'));
		expect(jar.header()).toBeNull();
	});
});
