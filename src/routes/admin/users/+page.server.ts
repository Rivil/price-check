import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '#lib/server/auth.ts';
import { db } from '#lib/server/db/index.ts';
import { AccountInputError, createHouseholdAccount, listAccounts } from '#lib/server/accounts.ts';

// The server hook already 403s non-admins on /admin/*; createHouseholdAccount
// passes the request headers so better-auth re-checks the role as well.
export const load: PageServerLoad = async () => ({ accounts: await listAccounts(db) });

export const actions: Actions = {
	create: async ({ request }) => {
		const data = await request.formData();
		const input = {
			name: String(data.get('name') ?? ''),
			email: String(data.get('email') ?? ''),
			password: String(data.get('password') ?? ''),
			role: String(data.get('role') ?? 'user')
		};

		try {
			const created = await createHouseholdAccount(auth, request.headers, input);
			return { created: created.email };
		} catch (e) {
			if (e instanceof AccountInputError) {
				return fail(e.status, {
					field: e.field,
					message: e.message,
					name: input.name,
					email: input.email,
					role: input.role
				});
			}
			if (typeof e === 'object' && e !== null && 'statusCode' in e && e.statusCode === 403) {
				error(403, 'Forbidden');
			}
			throw e;
		}
	}
};
