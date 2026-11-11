import { isAdminRole } from '#lib/server/access.ts';
import type { LayoutServerLoad } from './$types';

/**
 * The header nav's only server input: whether there is a signed-in user (no nav on
 * /login) and whether they are an admin. The links themselves come from navItems.
 */
export const load: LayoutServerLoad = ({ locals }) => ({
	nav: locals.user ? { isAdmin: isAdminRole(locals.user.role) } : null
});
