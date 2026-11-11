/**
 * The signed-in header's links. Pure, so the order, the admin-only link and the
 * aria-current rule are unit-tested without rendering the layout.
 */

export type NavHref = '/' | '/account/alerts' | '/account/password' | '/admin/users';

export type NavItem = {
	label: string;
	href: NavHref;
	/** 'page' on the link for the page being shown (aria-current), else undefined. */
	current: 'page' | undefined;
};

const ITEMS: { label: string; href: NavHref }[] = [
	{ label: 'Watchlist', href: '/' },
	{ label: 'Alerts', href: '/account/alerts' },
	{ label: 'Account', href: '/account/password' }
];

const ADMIN_ITEM = { label: 'Admin', href: '/admin/users' } as const;

/** Drop trailing slashes so '/account/alerts/' marks the same link; '/' stays '/'. */
function normalise(pathname: string): string {
	return pathname.replace(/\/+$/, '') || '/';
}

/**
 * Header links for the signed-in user. A link is current only on an exact path
 * match: sub-pages (a watch page, a reset page) mark nothing.
 */
export function navItems({ pathname, isAdmin }: { pathname: string; isAdmin: boolean }): NavItem[] {
	const here = normalise(pathname);
	const items = isAdmin ? [...ITEMS, ADMIN_ITEM] : ITEMS;
	return items.map((item) => ({
		...item,
		current: item.href === here ? 'page' : undefined
	}));
}
