// pnpm admin:create — one-off first-admin bootstrap (`pnpm admin:create`,
// which loads .env itself). Runs under Node type
// stripping: no $app/* imports, explicit .ts extensions, erasable syntax only.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createAuth } from '../auth-factory.ts';
import { createDb } from '../db/client.ts';
import { AdminExistsError, BootstrapValidationError, bootstrapAdmin } from '../admin-bootstrap.ts';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

function fail(message: string): never {
	process.stderr.write(`admin:create: ${message}\n`);
	process.exit(1);
}

/** Reads answers line by line; on a TTY the password is typed without echo. */
function createPrompter() {
	let muted = false;
	const echo = new Writable({
		write(chunk, encoding, callback) {
			if (!muted) process.stdout.write(chunk, encoding);
			callback();
		}
	});
	const terminal = Boolean(process.stdin.isTTY);
	const rl = createInterface({ input: process.stdin, output: echo, terminal });
	// An async iterator buffers piped lines that arrive before they are asked for.
	const lines = rl[Symbol.asyncIterator]();

	async function ask(prompt: string, { hidden = false } = {}) {
		process.stdout.write(prompt);
		muted = hidden && terminal;
		const next = await lines.next();
		muted = false;
		if (hidden && terminal) process.stdout.write('\n');
		if (next.done) fail('input ended before all answers were given');
		return next.value;
	}

	return { ask, close: () => rl.close() };
}

async function main() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) fail('DATABASE_URL is not set');

	const db = createDb(databaseUrl);
	try {
		// Before anything else: a fresh instance has no tables yet.
		await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

		const auth = createAuth({
			db,
			baseURL: process.env.ORIGIN || undefined,
			secret: process.env.BETTER_AUTH_SECRET || undefined
		});

		const prompter = createPrompter();
		const email = await prompter.ask('Admin email: ');
		const name = await prompter.ask('Admin name: ');
		const password = await prompter.ask('Admin password: ', { hidden: true });
		prompter.close();

		const admin = await bootstrapAdmin(auth, db, { email, name, password });
		process.stdout.write(`admin:create: created admin ${admin.email}\n`);
	} catch (error) {
		if (error instanceof AdminExistsError || error instanceof BootstrapValidationError) {
			fail(error.message);
		}
		// Never echo input back: better-auth errors carry a message, not the request body.
		fail(error instanceof Error ? error.message : 'unexpected error');
	} finally {
		db.$client.close();
	}
}

await main();
