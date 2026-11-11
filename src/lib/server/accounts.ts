// Household account management (admin only). Every write goes through
// better-auth WITH the caller's headers, so better-auth re-checks the admin role
// itself — the hook is not the only line of defence.
import { asc, eq } from 'drizzle-orm';
import { MIN_PASSWORD_LENGTH } from './auth-factory.ts';
import type { Db } from './db/client.ts';
import { user } from './db/schema.ts';

export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type AccountField = 'name' | 'email' | 'password' | 'role';

/** A user-correctable input problem: rendered next to its field with status 400. */
export class AccountInputError extends Error {
	readonly status = 400;
	readonly field: AccountField;

	constructor(field: AccountField, message: string) {
		super(message);
		this.name = 'AccountInputError';
		this.field = field;
	}
}

/** The slice of the better-auth API this module uses (structural, so any instance fits). */
export interface AccountsAuth {
	api: {
		createUser(args: {
			body: { email: string; name: string; password: string; role: Role };
			headers: Headers;
		}): Promise<{ user: { id: string; email: string } }>;
	};
}

/** No account has this id: the page answers 404, not 500. */
export class AccountNotFoundError extends Error {
	readonly status = 404;

	constructor() {
		super('No such account.');
		this.name = 'AccountNotFoundError';
	}
}

/** The slice of the better-auth API resetAccountPassword uses. */
export interface ResetAuth {
	api: {
		setUserPassword(args: {
			body: { userId: string; newPassword: string };
			headers: Headers;
		}): Promise<unknown>;
		revokeUserSessions(args: { body: { userId: string }; headers: Headers }): Promise<unknown>;
	};
}

export type ResetOutcome =
	| { revoked: true }
	/** The password WAS changed; the target's existing sessions may still be live. */
	| { revoked: false; message: string };

export interface NewAccountInput {
	name: string;
	email: string;
	password: string;
	role?: string | null;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorCode(error: unknown) {
	if (typeof error !== 'object' || error === null || !('body' in error)) return undefined;
	const body = (error as { body?: { code?: unknown } }).body;
	return typeof body?.code === 'string' ? body.code : undefined;
}

export async function listAccounts(db: Db) {
	return db
		.select({ id: user.id, name: user.name, email: user.email, role: user.role })
		.from(user)
		.orderBy(asc(user.name), asc(user.email));
}

export async function getAccount(db: Db, id: string) {
	const [row] = await db
		.select({ id: user.id, name: user.name, email: user.email, role: user.role })
		.from(user)
		.where(eq(user.id, id));
	return row;
}

/**
 * Admin sets a new password for userId, then revokes all of that user's sessions —
 * both calls with the admin's headers, so better-auth re-checks the admin role.
 */
export async function resetAccountPassword(
	auth: ResetAuth,
	headers: Headers,
	userId: string,
	newPassword: string
): Promise<ResetOutcome> {
	if (newPassword.length < MIN_PASSWORD_LENGTH) {
		throw new AccountInputError(
			'password',
			`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
		);
	}

	try {
		await auth.api.setUserPassword({ body: { userId, newPassword }, headers });
	} catch (error) {
		const code = errorCode(error);
		if (code === 'USER_NOT_FOUND') throw new AccountNotFoundError();
		if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') {
			throw new AccountInputError('password', 'That password is not allowed (8–128 characters).');
		}
		throw error;
	}

	try {
		await auth.api.revokeUserSessions({ body: { userId }, headers });
	} catch {
		return {
			revoked: false,
			message:
				'Password changed, but their existing sessions were not signed out. Reset again to retry.'
		};
	}
	return { revoked: true };
}

export async function createHouseholdAccount(
	auth: AccountsAuth,
	headers: Headers,
	input: NewAccountInput
) {
	const name = input.name.trim();
	const email = input.email.trim();
	const role = input.role || 'user';

	if (!name) throw new AccountInputError('name', 'Name is required.');
	if (!EMAIL_SHAPE.test(email))
		throw new AccountInputError('email', 'Enter a valid email address.');
	// better-auth's admin createUser enforces no minimum and treats an empty
	// password as "no credential account", so the app checks it here.
	if (input.password.length < MIN_PASSWORD_LENGTH) {
		throw new AccountInputError(
			'password',
			`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
		);
	}
	if (!(ROLES as readonly string[]).includes(role)) {
		throw new AccountInputError('role', 'Role must be user or admin.');
	}

	try {
		const { user: created } = await auth.api.createUser({
			body: { email, name, password: input.password, role: role as Role },
			headers
		});
		return created;
	} catch (error) {
		const code = errorCode(error);
		if (code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' || code === 'USER_ALREADY_EXISTS') {
			throw new AccountInputError('email', 'An account with this email already exists.');
		}
		if (code === 'INVALID_EMAIL') {
			throw new AccountInputError('email', 'Enter a valid email address.');
		}
		throw error;
	}
}
