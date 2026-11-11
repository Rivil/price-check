// First-admin bootstrap (c-2). Plain Node-compatible TypeScript: the admin:create
// CLI runs this under Node type stripping, so no $app/* and explicit .ts imports.
import { MIN_PASSWORD_LENGTH, type createAuth } from './auth-factory.ts';
import type { Db } from './db/client.ts';
import { user } from './db/schema.ts';

/** The plugin-less instance the CLI and tests build (ReturnType alone would widen P to its constraint). */
type BootstrapAuth = ReturnType<typeof createAuth<[]>>;

export class AdminExistsError extends Error {
	constructor() {
		super('admin already exists — admin:create only bootstraps the first admin');
		this.name = 'AdminExistsError';
	}
}

export class BootstrapValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BootstrapValidationError';
	}
}

export interface BootstrapInput {
	email: string;
	name: string;
	password: string;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate({ email, name, password }: BootstrapInput): BootstrapInput {
	const trimmedName = name.trim();
	const trimmedEmail = email.trim();
	if (!trimmedName) throw new BootstrapValidationError('name must not be empty');
	if (!EMAIL_SHAPE.test(trimmedEmail)) throw new BootstrapValidationError('email is not valid');
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new BootstrapValidationError(
			`password must be at least ${MIN_PASSWORD_LENGTH} characters`
		);
	}
	return { email: trimmedEmail, name: trimmedName, password };
}

async function adminExists(db: Db) {
	const rows = await db.select({ role: user.role }).from(user);
	// better-auth stores multiple roles comma-separated.
	return rows.some(({ role }) => (role ?? '').split(',').some((r) => r.trim() === 'admin'));
}

/**
 * Creates the first admin through better-auth (so the password is hashed exactly
 * as sign-in expects). Validates before any write; refuses once any admin exists.
 */
export async function bootstrapAdmin(auth: BootstrapAuth, db: Db, input: BootstrapInput) {
	const valid = validate(input);
	if (await adminExists(db)) throw new AdminExistsError();

	// Headerless server call: the admin plugin treats it as trusted (no session needed).
	const { user: created } = await auth.api.createUser({
		body: { email: valid.email, name: valid.name, password: valid.password, role: 'admin' }
	});
	return created;
}
