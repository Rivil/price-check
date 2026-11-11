import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '#lib/server/auth.ts';
import { db } from '#lib/server/db/index.ts';
import {
	AccountInputError,
	AccountNotFoundError,
	getAccount,
	resetAccountPassword
} from '#lib/server/accounts.ts';

// The server hook already 403s non-admins on /admin/*; resetAccountPassword
// passes the request headers so better-auth re-checks the role as well.
export const load: PageServerLoad = async ({ params }) => {
	const account = await getAccount(db, params.id);
	if (!account) error(404, 'No such account');
	return { account };
};

export const actions: Actions = {
	default: async ({ request, params }) => {
		const data = await request.formData();
		const newPassword = String(data.get('newPassword') ?? '');

		try {
			const outcome = await resetAccountPassword(auth, request.headers, params.id, newPassword);
			return outcome.revoked ? { reset: true } : { reset: true, warning: outcome.message };
		} catch (e) {
			if (e instanceof AccountInputError) return fail(e.status, { message: e.message });
			if (e instanceof AccountNotFoundError) error(404, 'No such account');
			if (typeof e === 'object' && e !== null && 'statusCode' in e && e.statusCode === 403) {
				error(403, 'Forbidden');
			}
			throw e;
		}
	}
};
