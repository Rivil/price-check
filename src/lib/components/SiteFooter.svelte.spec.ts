import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../styles/tokens.css';
import SiteFooter from './SiteFooter.svelte';

const SOURCE_URL = 'https://github.com/Rivil/price-check';

describe('SiteFooter', () => {
	it('renders exactly one Source link, to the public repo, inside the contentinfo landmark', async () => {
		render(SiteFooter);

		const footer = page.getByRole('contentinfo');
		await expect.element(footer).toBeVisible();

		const inFooter = footer.getByRole('link', { name: 'Source', exact: true }).elements();
		const anywhere = page.getByRole('link', { name: 'Source', exact: true }).elements();
		expect(inFooter).toHaveLength(1);
		expect(anywhere).toStrictEqual(inFooter);

		// Exact match: a trailing slash, .git suffix or http:// all fail.
		expect(inFooter[0].getAttribute('href')).toBe(SOURCE_URL);
	});
});
