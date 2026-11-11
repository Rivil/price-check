import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const base = readFileSync(new URL('./base.css', import.meta.url), 'utf8').replace(
	/\/\*[\s\S]*?\*\//g,
	''
);
const layout = readFileSync(new URL('../../routes/+layout.svelte', import.meta.url), 'utf8');

/** Declarations of every rule whose selector list names `element` as a compound's start. */
function declarationsFor(element: string): Record<string, string>[] {
	const rules: Record<string, string>[] = [];
	for (const m of base.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selectors = m[1].split(',').map((s) => s.trim());
		if (!selectors.some((s) => s === element || s.startsWith(`${element}:`))) continue;
		const decls: Record<string, string> = {};
		for (const d of m[2].matchAll(/([-\w]+)\s*:\s*([^;]+);/g)) decls[d[1]] = d[2].trim();
		rules.push(decls);
	}
	return rules;
}

/** A value built only from var(--*) references plus border-style keywords. */
function tokenOnly(value: string): boolean {
	return (
		/var\(--[\w-]+\)/.test(value) &&
		value
			.replace(/var\(--[\w-]+\)/g, ' ')
			.replace(/\b(?:solid|none)\b/g, ' ')
			.trim() === ''
	);
}

describe('base styles', () => {
	it('+layout.svelte imports tokens.css and base.css', () => {
		expect(layout).toMatch(/import\s+'#lib\/styles\/tokens\.css';/);
		expect(layout).toMatch(/import\s+'#lib\/styles\/base\.css';/);
	});

	it("declares 'color-scheme: light dark'", () => {
		expect(base).toMatch(/color-scheme:\s*light dark\s*;/);
	});

	it.each([
		['body', ['background', 'color']],
		['button', ['background', 'color', 'border']],
		['input', ['background', 'color', 'border']]
	] as const)('%s: %j come from var(--*) tokens', (element, props) => {
		const rules = declarationsFor(element);
		for (const prop of props) {
			const values = rules.map((r) => r[prop]).filter((v): v is string => v !== undefined);
			expect(values, `${element} sets no ${prop}`).not.toHaveLength(0);
			for (const value of values) {
				expect(tokenOnly(value), `${element} { ${prop}: ${value} }`).toBe(true);
			}
		}
	});

	it('alerts and failures use the danger token', () => {
		const rules = [...declarationsFor("[role='alert']"), ...declarationsFor('.failure')];
		expect(rules.map((r) => r.color)).toContain('var(--danger)');
		expect(rules.every((r) => r.color === undefined || r.color === 'var(--danger)')).toBe(true);
	});

	it('focus-visible outline is a 2px-or-more token outline', () => {
		const [focus] = declarationsFor(':focus-visible');
		expect(focus?.outline).toBe('var(--focus-width) solid var(--focus)');
	});

	it('main is a centred 44rem column', () => {
		const [main] = declarationsFor('main');
		expect(main['max-width']).toBe('44rem');
		expect(main['margin-inline']).toBe('auto');
	});

	it('long text wraps and images fit their container', () => {
		const [body] = declarationsFor('body');
		expect(body['overflow-wrap']).toBe('anywhere');
		const [img] = declarationsFor('img');
		expect(img['max-width']).toBe('100%');
		for (const el of ['td', 'code']) {
			expect(
				declarationsFor(el).some((r) => r['overflow-wrap'] === 'anywhere'),
				el
			).toBe(true);
		}
	});

	it('the token-only check rejects literals', () => {
		expect(tokenOnly('var(--border-width) solid var(--border)')).toBe(true);
		expect(tokenOnly('1px solid var(--border)')).toBe(false);
		expect(tokenOnly('white')).toBe(false);
		expect(tokenOnly('var(--bg, white)')).toBe(false);
	});
});
