import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import { auth } from '#lib/server/auth.ts';
import { changeOwnPassword, OwnPasswordError } from '#lib/server/own-password.ts';

export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData();
		const currentPassword = String(data.get('currentPassword') ?? '');
		const newPassword = String(data.get('newPassword') ?? '');

		try {
			// Request headers carry this session; sveltekitCookies sets the fresh session cookie.
			await changeOwnPassword(auth, request.headers, currentPassword, newPassword);
		} catch (e) {
			if (e instanceof OwnPasswordError) {
				return fail(e.status, { field: e.field, message: e.message });
			}
			throw e;
		}

		return { changed: true };
	}
};
