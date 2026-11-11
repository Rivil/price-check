import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { formatError } from './error-log.ts';

const TOPIC = 'https://ntfy.sh/alice-secret-topic';
const TOKEN = 'tk_abcdefghijklmnopqrstuvwxyz012'; // token-shaped, not a real one

function expectNoSecrets(text: string) {
	expect(text).not.toContain('alice-secret-topic');
	expect(text).not.toContain(TOKEN);
}

describe('formatError', () => {
	it('message removed', () => {
		const error = new Error(`Failed query: update alert_channel\nparams: ${TOPIC},${TOKEN}`);

		const text = formatError(error);

		expectNoSecrets(text);
		expect(text).not.toContain('Failed query');
		expect(text).not.toContain('params:');
	});

	it('frame-shaped message', () => {
		const error = new Error(`boom\n    at evil (${TOPIC}:1:1)\n    at ${TOKEN}:2:2`);

		const text = formatError(error);

		expectNoSecrets(text);
		expect(text).not.toContain('evil');
		expect(text).toMatch(/^Error\n {4}at /);
	});

	it('frame-shaped message in a stale header', () => {
		const error = new Error(`boom\n    at evil (${TOPIC}:1:1)`);
		// Reading the stack fixes its header, so the message no longer matches it.
		expect(error.stack).toContain('evil');
		error.message = 'something else';

		expect(formatError(error)).toBe('Error');
	});

	it('shortened message', () => {
		// 'bang' is boom's length: only the header check stops it landing on the evil line.
		for (const message of ['', 'bo', 'oom', 'bang']) {
			const error = new Error(`boom\n    at evil (${TOPIC}:1:1)\n    at ${TOKEN}:2:2`);
			expect(error.stack).toContain('evil');
			error.message = message;

			expect(formatError(error)).toBe('Error');
		}

		const tail = new Error(`alpha: boom\n    at evil (${TOPIC}:1:1)`);
		expect(tail.stack).toContain('evil');
		tail.message = 'boom';

		expect(formatError(tail)).toBe('Error');
	});

	it('coded header', () => {
		const error = new TypeError('nope');
		error.stack = 'TypeError [ERR_X]: nope\n    at load (src/a.ts:1:2)';

		expect(formatError(error)).toBe('TypeError\n    at load (src/a.ts:1:2)');
	});

	it('frame-shaped message rewritten by Kit', () => {
		const error = new Error(`boom\n    at evil (file:///${TOKEN}.js:1:1)`);
		// fix_stack_trace rewrites file:/// lines wherever they are, the message included.
		error.stack = `Error: boom\n    at evil (${TOKEN}.js:1:1)\n    at load (src/a.ts:1:1)`;

		expect(formatError(error)).toBe('Error');
	});

	it('keeps type and frames', () => {
		const raw = new RangeError('nope');
		expect(formatError(raw)).toMatch(/^RangeError\n {4}at .+error-log\.spec\.ts:\d+:\d+\)?\n/);

		// DrizzleQueryError never sets name: error.name would type it as plain Error.
		const query = new DrizzleQueryError('update x set y = ?', [TOPIC, TOKEN], new Error('busy'));
		const text = formatError(query);
		expect(query.name).toBe('Error');
		expect(text).toMatch(/^DrizzleQueryError\n {4}at /);
		expectNoSecrets(text);

		const kit = new TypeError('nope');
		const frames = [
			'    at load (src/routes/+page.server.ts:12:3)',
			'    at load (src/routes/watches/[id]/+page.server.ts:7:9)',
			'    at render (build/server/chunks/index.js:5:1) [src/lib/render.ts]',
			'    at run (build/server/chunks/a.js:5:1) [src/routes/watches/[id]/+page.server.ts]',
			'    at async file:///app/build/index.js:3:2',
			'    at new Thing (file:///app/build/thing.js:1:1)',
			'    at node:internal/process/task_queues:105:5',
			'    at Array.map (<anonymous>)',
			'    at Promise.all (index 0)',
			'    at Promise.all (index 10)',
			'    at JSON.parse (native)'
		];
		kit.stack = ['TypeError: nope', ...frames].join('\n');
		expect(formatError(kit)).toBe(['TypeError', ...frames].join('\n'));
	});

	it('keeps frames under an empty message', () => {
		const error = new Error();
		error.stack = 'Error\n    at load (src/a.ts:1:2)';

		expect(formatError(error)).toBe('Error\n    at load (src/a.ts:1:2)');
	});

	it('drops lines that are not frames', () => {
		// One stack each: the frames end at the first non-frame, hiding any line after it.
		for (const line of [
			'not a frame',
			'',
			'    at something without a location',
			'    at load (src/b.ts:1:2) trailing',
			'  at load (src/c.ts:1:2)',
			'text    at load (src/d.ts:1:2)'
		]) {
			const error = new Error('boom');
			error.stack = ['Error: boom', '    at load (src/a.ts:1:2)', line].join('\n');

			expect(formatError(error)).toBe('Error\n    at load (src/a.ts:1:2)');
		}
	});

	it('appended stack', () => {
		const inner = new Error(`boom\n    at evil (${TOPIC}:1:1)\n    at ${TOKEN}:2:2`);
		const outer = new Error('wrapped');
		outer.stack = `Error: wrapped\n    at load (src/a.ts:1:2)\nCaused by: ${inner.stack}`;

		expect(formatError(outer)).toBe('Error\n    at load (src/a.ts:1:2)');

		const live = new Error('wrapped');
		live.stack += `\nCaused by: ${inner.stack}`;

		const text = formatError(live);

		expectNoSecrets(text);
		expect(text).not.toContain('evil');
		expect(text).toMatch(/^Error\n {4}at /);
	});

	it('non-error', () => {
		expect(formatError(`fetch failed for ${TOPIC}`)).toBe('string');
		expect(formatError({ topic: TOPIC, token: TOKEN })).toBe('object');
		expect(formatError(undefined)).toBe('undefined');
	});

	it('no stack', () => {
		const error = new TypeError(`fetch failed for ${TOPIC}`);
		delete error.stack;

		expect(formatError(error)).toBe('TypeError');
	});

	it('anonymous error class', () => {
		const error = new (class extends Error {})('nope');
		error.stack = 'Error: nope';

		expect(formatError(error)).toBe('Error');
	});

	it('never throws', () => {
		const error = new Error(TOPIC);
		Object.defineProperty(error, 'stack', {
			get() {
				throw new Error(TOPIC);
			}
		});
		expect(formatError(error)).toBe('unknown');

		const noConstructor = new Error('nope');
		noConstructor.stack = 'Error: nope';
		Object.defineProperty(noConstructor, 'constructor', { value: undefined });
		expect(formatError(noConstructor)).toBe('Error');

		const hostileMessage = new Error('nope');
		Object.defineProperty(hostileMessage, 'message', {
			value: {
				toString() {
					throw new Error(TOPIC);
				}
			}
		});
		expect(formatError(hostileMessage)).toBe('unknown');
	});
});
