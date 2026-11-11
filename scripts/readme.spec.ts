// Pins README.md's shape (spec c-6): end users first, developers after, and no
// leftover instructions for the dropped container/server deployment.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	scripts: Record<string, string>;
};

/** `## ` sections in order: [heading, body]. */
const sections = readme
	.split(/^## /m)
	.slice(1)
	.map((chunk) => {
		const [heading, ...body] = chunk.split('\n');
		return [heading.trim(), body.join('\n')] as const;
	});

describe('README', () => {
	it('end user first: the first section is install and use, development comes after', () => {
		expect(sections.length).toBeGreaterThan(1);
		expect(sections[0][0]).toMatch(/install/i);
		const dev = sections.findIndex(([heading]) => /develop/i.test(heading));
		expect(dev).toBeGreaterThan(0);
	});

	it('install and first watch: releases link, every OS, SmartScreen, adding a watch', () => {
		const [, body] = sections[0];
		expect(body).toContain('https://github.com/Rivil/price-check/releases');
		for (const os of ['macOS', 'Windows', 'Linux']) expect(body).toContain(os);
		expect(body).toContain('SmartScreen');
		expect(body).toMatch(/first watch/i);
		expect(body).toMatch(/target price/i);
	});

	it('no self-host: nothing about containers, compose, proxies or server deploys', () => {
		// Built from fragments so this spec never matches its own source in a repo-wide scan.
		const forbidden = [
			['dock', 'er'],
			['com', 'pose'],
			['Docker', 'file'],
			['image', '-smoke'],
			['reverse', ' proxy'],
			['self', '-host']
		].map((parts) => parts.join(''));
		const lower = readme.toLowerCase();
		for (const word of forbidden) expect(lower, word).not.toContain(word.toLowerCase());
	});

	it('developer commands it lists run natively: admin:create loads .env itself', () => {
		expect(readme).toContain('pnpm admin:create');
		expect(pkg.scripts['admin:create']).toMatch(/--env-file(-if-exists)?=\.env/);
	});
});
