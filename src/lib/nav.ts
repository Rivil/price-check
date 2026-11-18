/**
 * The header's links. Pure, so the order and the aria-current rule are unit-tested
 * without rendering the layout.
 */

export type NavHref = '/' | '/account/alerts';

export type NavItem = {
	label: string;
	href: NavHref;
	/** 'page' on the link for the page being shown (aria-current), else undefined. */
	current: 'page' | undefined;
};

const ITEMS: { label: string; href: NavHref }[] = [
	{ label: 'Watchlist', href: '/' },
	{ label: 'Alerts', href: '/account/alerts' }
];

/** Drop trailing slashes so '/account/alerts/' marks the same link; '/' stays '/'. */
function normalise(pathname: string): string {
	return pathname.replace(/\/+$/, '') || '/';
}

/**
 * Header links. A link is current only on an exact path match: sub-pages (a watch
 * page) mark nothing.
 */
export function navItems({ pathname }: { pathname: string }): NavItem[] {
	const here = normalise(pathname);
	return ITEMS.map((item) => ({
		...item,
		current: item.href === here ? 'page' : undefined
	}));
}
