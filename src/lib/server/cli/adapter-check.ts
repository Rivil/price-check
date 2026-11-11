// pnpm adapter:check — one live shop check from the command line
// (`pnpm adapter:check <url>`). Runs under Node type
// stripping: no $app/* imports, explicit .ts extensions, erasable syntax only.
import { runCheckCommand } from '../shops/check-command.ts';
import { defaultRegistry, getSharedClient } from '../shops/index.ts';

async function main(): Promise<number> {
	let client;
	try {
		client = getSharedClient();
	} catch (error) {
		// An invalid SHOP_* env var: a configuration error, not a failed check.
		process.stderr.write(`adapter:check: ${error instanceof Error ? error.message : error}\n`);
		return 2;
	}
	return runCheckCommand(process.argv.slice(2), {
		client,
		registry: defaultRegistry,
		stdout: process.stdout,
		stderr: process.stderr,
		fixturesDirFor: (adapter) => adapter.fixturesDir
	});
}

process.exitCode = await main();
