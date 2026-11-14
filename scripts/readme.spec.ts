// Pins README.md's shape (spec c-6): end users first, developers after, and no
// leftover instructions for the dropped container/server deployment. Also pins the
// single-user docs and package.json: no auth secret, admin CLI or auth library.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readme = read('README.md');
const envExample = read('.env.example');
const architecture = read('ARCHITECTURE.md');
const pkg = JSON.parse(read('package.json')) as {
	scripts: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

/** pnpm's own commands, which need no entry in package.json scripts. */
const PNPM_BUILTINS = ['add', 'dlx', 'exec', 'install', 'remove'];

/** Every `pnpm <name>` the text tells someone to run, `pnpm run <name>` included. */
const pnpmCommands = (text: string) =>
	[...text.matchAll(/\bpnpm (?:run )?([a-z][\w:-]*)/g)].map((match) => match[1]);

/** Traces of the deleted auth stack (02-single-user c-2): the secret, the admin CLI, the library. */
const AUTH_TRACES = ['BETTER_AUTH_SECRET', 'admin:create', 'auth:schema', 'better-auth'];

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

	it('every pnpm command it lists exists: a dropped script never lingers in the docs', () => {
		const commands = pnpmCommands(readme);
		expect(commands).toContain('dev');
		expect(commands).toContain('db:migrate');
		for (const name of commands) {
			if (PNPM_BUILTINS.includes(name)) continue;
			expect(pkg.scripts, name).toHaveProperty([name]);
		}
	});

	it('command scan fixtures', () => {
		expect(pnpmCommands('pnpm admin:create   # prompts\npnpm run db:generate')).toEqual([
			'admin:create',
			'db:generate'
		]);
		expect(pnpmCommands('built with pnpm. Then `pnpm test:unit --run`')).toEqual(['test:unit']);
	});
});

describe('single user: no auth stack left (02-single-user c-2)', () => {
	it('package.json has no auth library, auth CLI or auth scripts', () => {
		const deps = { ...pkg.dependencies, ...pkg.devDependencies };
		expect(deps).not.toHaveProperty(['better-auth']);
		expect(deps).not.toHaveProperty(['auth']);
		expect(Object.keys(deps).filter((name) => /better-auth/.test(name))).toEqual([]);
		expect(pkg.scripts).not.toHaveProperty(['admin:create']);
		expect(pkg.scripts).not.toHaveProperty(['auth:schema']);
		expect(pkg.scripts).toHaveProperty(['dev']);
	});

	it('README, .env.example and ARCHITECTURE.md carry no secret, admin or library steps', () => {
		for (const [name, text] of [
			['README.md', readme],
			['.env.example', envExample],
			['ARCHITECTURE.md', architecture]
		]) {
			for (const trace of AUTH_TRACES) expect(text, `${name}: ${trace}`).not.toContain(trace);
		}
	});

	it('.env.example sets only what the server reads, and no ORIGIN', () => {
		// ORIGIN is optional (src/env.ts); only the desktop shell sets it, to its own URL.
		expect(envExample).not.toMatch(/^\s*#?\s*(?:export\s+)?ORIGIN\s*=/m);
		expect(envExample).toMatch(/^DATABASE_URL=/m);
		expect(envExample).toMatch(/^ALERTS_ENCRYPTION_KEY=/m);
	});
});
