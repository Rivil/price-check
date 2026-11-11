// Self-service password change (c-8). better-auth checks the current password,
// deletes ALL the user's sessions (this one included) and issues a fresh session,
// whose cookie sveltekitCookies sets on the request when called from a form action.
import { MIN_PASSWORD_LENGTH } from './auth-factory.ts';

export type OwnPasswordField = 'currentPassword' | 'newPassword';

/** A user-correctable problem: rendered next to its field with status 400. */
export class OwnPasswordError extends Error {
	readonly status = 400;
	readonly field: OwnPasswordField;

	constructor(field: OwnPasswordField, message: string) {
		super(message);
		this.name = 'OwnPasswordError';
		this.field = field;
	}
}

/** The slice of the better-auth API this module uses (structural, so any instance fits). */
export interface OwnPasswordAuth {
	api: {
		changePassword(args: {
			body: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean };
			headers: Headers;
			returnHeaders: true;
		}): Promise<{ headers: Headers; response: { token: string | null } }>;
	};
}

function errorCode(error: unknown) {
	if (typeof error !== 'object' || error === null || !('body' in error)) return undefined;
	const body = (error as { body?: { code?: unknown } }).body;
	return typeof body?.code === 'string' ? body.code : undefined;
}

/** Returns the new session token and the response headers carrying its Set-Cookie. */
export async function changeOwnPassword(
	auth: OwnPasswordAuth,
	headers: Headers,
	currentPassword: string,
	newPassword: string
) {
	if (!currentPassword) {
		throw new OwnPasswordError('currentPassword', 'Enter your current password.');
	}
	if (newPassword.length < MIN_PASSWORD_LENGTH) {
		throw new OwnPasswordError(
			'newPassword',
			`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
		);
	}

	try {
		const { headers: responseHeaders, response } = await auth.api.changePassword({
			body: { currentPassword, newPassword, revokeOtherSessions: true },
			headers,
			returnHeaders: true
		});
		return { token: response.token, headers: responseHeaders };
	} catch (error) {
		const code = errorCode(error);
		if (code === 'INVALID_PASSWORD') {
			throw new OwnPasswordError('currentPassword', 'Current password is incorrect.');
		}
		if (code === 'PASSWORD_TOO_SHORT') {
			throw new OwnPasswordError(
				'newPassword',
				`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
			);
		}
		throw error;
	}
}
