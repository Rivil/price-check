// `pnpm adapter:check <url> [--save-fixture <name> [--force]]`: one live check
// through the rate-limited client, optionally saving the fetched page as a
// fixture. Imported by the adapter:check CLI, so it runs under Node type
// stripping: no $app/* or $env/* imports, explicit .ts extensions, erasable
// syntax only.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatPence } from '../../money.ts';
import type { ShopRegistry } from './registry.ts';
import type { CheckResult, ShopAdapter, ShopClient } from './types.ts';

export const USAGE = 'usage: pnpm adapter:check <url> [--save-fixture <name> [--force]]';

const FIXTURE_NAME = /^[a-z0-9-]+$/;

type Output = { write(text: string): unknown };

export type CheckCommandDeps = {
	client: ShopClient;
	registry: ShopRegistry;
	stdout: Output;
	stderr: Output;
	fixturesDirFor: (adapter: ShopAdapter) => string;
};

type Args = { url: string; saveAs: string | null; force: boolean };

function parseArgs(argv: readonly string[]): Args | string {
	let url: string | null = null;
	let saveAs: string | null = null;
	let force = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--save-fixture') {
			const name = argv[i + 1];
			if (name === undefined || name.startsWith('--')) return '--save-fixture needs a name';
			saveAs = name;
			i++;
		} else if (arg === '--force') {
			force = true;
		} else if (arg.startsWith('-')) {
			return `unknown option ${arg}`;
		} else if (url === null) {
			url = arg;
		} else {
			return 'only one URL can be checked at a time';
		}
	}
	if (url === null) return 'missing URL';
	if (force && saveAs === null) return '--force only applies with --save-fixture';
	return { url, saveAs, force };
}

/** 'foo' or 'foo.html' -> 'foo.html'; anything outside [a-z0-9-] is refused. */
function fixtureFileName(name: string): string | null {
	const stem = name.endsWith('.html') ? name.slice(0, -'.html'.length) : name;
	return FIXTURE_NAME.test(stem) ? `${stem}.html` : null;
}

/** The injected client, also remembering the last page body it fetched. */
function tap(client: ShopClient) {
	let body: string | null = null;
	const tapped: ShopClient = {
		async request(url, options) {
			const response = await client.request(url, options);
			if (response.body !== null) body = response.body;
			return response;
		}
	};
	return { client: tapped, lastBody: () => body };
}

function report(result: CheckResult, { stdout, stderr }: CheckCommandDeps): number {
	if (!result.ok) {
		stderr.write(`${result.reason}: ${result.message}\n`);
		return 1;
	}
	stdout.write(
		[
			`shop:  ${result.shop}`,
			`id:    ${result.productId}`,
			`url:   ${result.canonicalUrl}`,
			`title: ${result.title}`,
			`price: ${formatPence(result.pricePence)}`,
			`image: ${result.imageUrl ?? '-'}`
		].join('\n') + '\n'
	);
	return 0;
}

/** Exit code: 0 ok, 1 the check failed, 2 usage or fixture-saving error. */
export async function runCheckCommand(
	argv: readonly string[],
	deps: CheckCommandDeps
): Promise<number> {
	const { stdout, stderr } = deps;
	const args = parseArgs(argv);
	if (typeof args === 'string') {
		stderr.write(`adapter:check: ${args}\n${USAGE}\n`);
		return 2;
	}

	let fixturePath: string | null = null;
	if (args.saveAs !== null) {
		const fileName = fixtureFileName(args.saveAs);
		if (fileName === null) {
			stderr.write(`adapter:check: fixture name must match [a-z0-9-]+, got "${args.saveAs}"\n`);
			return 2;
		}
		const resolution = deps.registry.resolve(args.url);
		if (resolution.kind === 'adapter') {
			fixturePath = join(deps.fixturesDirFor(resolution.adapter), fileName);
			// Refuse before any request: an existing fixture is never overwritten by accident.
			if (!args.force && existsSync(fixturePath)) {
				stderr.write(`adapter:check: ${fixturePath} exists; pass --force to overwrite it\n`);
				return 2;
			}
		}
	}

	const tapped = tap(deps.client);
	const result = await deps.registry.check(args.url, { client: tapped.client });
	const code = report(result, deps);

	if (args.saveAs === null) return code;

	const body = tapped.lastBody();
	if (fixturePath === null || body === null) {
		stderr.write('adapter:check: nothing to save (no page was fetched)\n');
		return code;
	}
	try {
		await writeFile(fixturePath, body, { flag: args.force ? 'w' : 'wx' });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		stderr.write(`adapter:check: could not save ${fixturePath}: ${detail}\n`);
		return 2;
	}
	stdout.write(`saved fixture ${fixturePath}\n`);
	return code;
}
