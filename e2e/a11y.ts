// Accessibility helpers for the app-design specs (c-4, c-6, c-7): colour scheme,
// axe text contrast, control border contrast, a keyboard focus walk and sideways
// overflow. Contrast maths come from tokens.ts, the code that proves the palette.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { contrastRatio, parseColour } from '../src/lib/styles/tokens.ts';

export type Scheme = 'light' | 'dark';

/** An element axe may report as 'incomplete' (unmeasurable), and why a human accepts that. */
export type AllowlistEntry = { selector: string; reason: string };

/** One element reached by tabWalk, with its focus outline as computed. */
export type FocusStop = {
	label: string;
	focusVisible: boolean;
	outlineStyle: string;
	outlineWidth: string;
	outlineColour: string;
	/** Opaque colour the outline is drawn against; null when none could be found. */
	background: string | null;
	ratio: number | null;
};

/** WCAG 1.4.11: control boundaries and focus indicators. */
const NON_TEXT_MIN = 3;
const FOCUS_MIN_WIDTH_PX = 2;
const TEXT_RULES = ['color-contrast', 'link-in-text-block'];
const STRUCTURE_RULES = [
	'aria-allowed-attr',
	'aria-allowed-role',
	'aria-command-name',
	'aria-conditional-attr',
	'aria-deprecated-role',
	'aria-hidden-body',
	'aria-hidden-focus',
	'aria-prohibited-attr',
	'aria-required-attr',
	'aria-required-children',
	'aria-required-parent',
	'aria-roles',
	'aria-tooltip-name',
	'aria-valid-attr',
	'aria-valid-attr-value',
	'button-name',
	'nested-interactive',
	'role-img-alt',
	'svg-img-alt'
];

type AxeNode = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number]['nodes'][number];

/** In-page helpers, installed once per document by installProbe. */
type Probe = {
	describe(el: Element): string;
	/** Computed background-color of `el` and each ancestor up to <html>, innermost first. */
	backgrounds(el: Element | null): string[];
	tabbables(): Element[];
	visited: Element[];
};

declare global {
	interface Window {
		__a11yProbe?: Probe;
	}
}

/**
 * Emulate the OS colour scheme, then navigate if a path is given. Emulating first
 * means the page's first paint already uses the scheme.
 */
export async function useScheme(page: Page, scheme: Scheme, path?: string): Promise<void> {
	await page.emulateMedia({ colorScheme: scheme });
	if (path !== undefined) await page.goto(path);
}

/**
 * axe color-contrast (AA: 4.5:1 body, 3:1 large text) and link-in-text-block over
 * the whole page. Any violation fails; so does any 'incomplete' (axe could not
 * measure, e.g. text over a background image) unless its element is allowlisted.
 */
export async function expectTextContrast(
	page: Page,
	{ allowlist = [] }: { allowlist?: readonly AllowlistEntry[] } = {}
): Promise<void> {
	checkAllowlist(allowlist);
	const results = await new AxeBuilder({ page }).withRules(TEXT_RULES).analyze();

	const problems: string[] = [];
	for (const rule of results.violations) {
		for (const node of rule.nodes) {
			problems.push(`${rule.id} violation: ${targetText(node)} - ${summary(node)}`);
		}
	}
	for (const rule of results.incomplete) {
		for (const node of rule.nodes) {
			if (await allowlisted(page, node, allowlist)) continue;
			problems.push(`${rule.id} incomplete: ${targetText(node)} - ${summary(node)}`);
		}
	}
	expect(problems, 'text contrast problems').toEqual([]);
}

/** axe's structural rules over the whole page: roles, names, and nothing focusable hidden. */
export async function expectStructure(page: Page): Promise<void> {
	const results = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
	const problems = results.violations.flatMap((rule) =>
		rule.nodes.map((node) => `${rule.id} violation: ${targetText(node)} - ${summary(node)}`)
	);
	expect(problems, 'structure problems').toEqual([]);
}

/**
 * Every visible input, select, textarea and button border must reach 3:1 against
 * the first opaque background behind the control (its own background is ignored:
 * the boundary has to stand out from what surrounds it).
 */
export async function controlBorderContrast(page: Page): Promise<void> {
	await installProbe(page);
	const controls = await page.evaluate(() => {
		const probe = window.__a11yProbe!;
		const sides = ['top', 'right', 'bottom', 'left'] as const;
		return [...document.querySelectorAll('input, select, textarea, button')]
			.filter((el) => !(el instanceof HTMLInputElement && el.type === 'hidden'))
			.filter((el) => el.checkVisibility({ visibilityProperty: true }))
			.map((el) => {
				const style = getComputedStyle(el);
				const prop = (side: string, what: string) =>
					style.getPropertyValue(`border-${side}-${what}`);
				return {
					label: probe.describe(el),
					backgrounds: probe.backgrounds(el.parentElement),
					borders: sides
						.filter((side) => !['none', 'hidden'].includes(prop(side, 'style')))
						.filter((side) => parseFloat(prop(side, 'width')) > 0)
						.map((side) => ({ side, colour: prop(side, 'color') }))
				};
			});
	});

	const problems: string[] = [];
	for (const control of controls) {
		// One message per border colour: 'border' when all four sides share it.
		const sidesByColour = Map.groupBy(control.borders, (border) => border.colour);
		for (const [colour, borders] of sidesByColour) {
			const where =
				borders.length === 4 ? 'border' : borders.map(({ side }) => `border-${side}`).join('/');
			try {
				const background = firstOpaque(control.backgrounds);
				const ratio = contrastRatio(colour, background);
				if (ratio < NON_TEXT_MIN) {
					problems.push(
						`${control.label} ${where} ${colour} on ${background} is ${ratio.toFixed(2)}:1 (< ${NON_TEXT_MIN}:1)`
					);
				}
			} catch (error) {
				problems.push(`${control.label} ${where}: ${(error as Error).message}`);
			}
		}
	}
	expect(problems, 'control border problems').toEqual([]);
}

/**
 * Tab from the top of the page until focus leaves the document or wraps, at most
 * `max` presses. Every stop needs a focus outline that is not none, at least 2px
 * and 3:1 against the background it is drawn on; the walk must reach every
 * tabbable element. Returns the stops for further assertions.
 */
export async function tabWalk(
	page: Page,
	{ max = 200 }: { max?: number } = {}
): Promise<FocusStop[]> {
	await installProbe(page);
	// Focus a throwaway tabindex=-1 sentinel before everything, so the first Tab
	// lands on the first tabbable element. It is removed once focus has moved on.
	await page.evaluate(() => {
		window.__a11yProbe!.visited = [];
		const sentinel = document.createElement('div');
		sentinel.tabIndex = -1;
		sentinel.dataset.a11ySentinel = '';
		document.body.prepend(sentinel);
		sentinel.focus();
	});

	const stops: FocusStop[] = [];
	const problems: string[] = [];
	let finished = false;
	for (let step = 0; step < max && !finished; step++) {
		await page.keyboard.press('Tab');
		const at = await page.evaluate(() => {
			document.querySelector('[data-a11y-sentinel]')?.remove();
			const probe = window.__a11yProbe!;
			const el = document.activeElement;
			if (!el || el === document.body || el === document.documentElement) {
				return { kind: 'left' as const };
			}
			const seen = probe.visited.indexOf(el);
			if (seen === 0) return { kind: 'wrapped' as const };
			if (seen > 0) return { kind: 'trapped' as const, label: probe.describe(el) };
			probe.visited.push(el);

			const style = getComputedStyle(el);
			// A negative offset draws the outline inside the element, over its own background.
			const inside = parseFloat(style.outlineOffset) < 0;
			return {
				kind: 'stop' as const,
				label: probe.describe(el),
				focusVisible: el.matches(':focus-visible'),
				outlineStyle: style.outlineStyle,
				outlineWidth: style.outlineWidth,
				outlineColour: style.outlineColor,
				backgrounds: probe.backgrounds(inside ? el : el.parentElement)
			};
		});

		if (at.kind === 'left' || at.kind === 'wrapped') {
			finished = true;
		} else if (at.kind === 'trapped') {
			problems.push(`focus returned to ${at.label} before the walk finished (focus trap)`);
			finished = true;
		} else {
			stops.push(checkFocusStop(at, problems));
		}
	}
	if (!finished) problems.push(`tab walk did not finish within ${max} steps`);

	const reach = await page.evaluate(() => {
		const probe = window.__a11yProbe!;
		const tabbable = probe.tabbables();
		return {
			count: tabbable.length,
			missed: tabbable.filter((el) => !probe.visited.includes(el)).map((el) => probe.describe(el))
		};
	});
	if (reach.count !== stops.length) {
		problems.push(`tab walk reached ${stops.length} elements, page has ${reach.count} tabbable`);
	}
	for (const label of reach.missed) problems.push(`never reached by Tab: ${label}`);

	expect(problems, 'keyboard focus problems').toEqual([]);
	return stops;
}

/** The page must not scroll sideways: its scroll width never exceeds the viewport. */
export async function expectNoOverflow(page: Page): Promise<void> {
	await installProbe(page);
	const result = await page.evaluate(() => {
		const probe = window.__a11yProbe!;
		const viewport = document.documentElement.clientWidth;
		const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
		// An element overflows if its box, or content spilling out of it, passes the edge.
		const over = [...document.body.querySelectorAll('*')].filter((el) => {
			const box = el.getBoundingClientRect();
			return Math.max(box.right, box.left + el.scrollWidth) > viewport + 0.5;
		});
		// Name the innermost offenders: an ancestor only overflows because of them.
		const innermost = over.filter((el) => !over.some((o) => o !== el && el.contains(o)));
		return {
			viewport,
			scrollWidth,
			offenders: innermost.slice(0, 5).map((el) => probe.describe(el))
		};
	});

	const problems =
		result.scrollWidth > result.viewport
			? [
					`page is ${result.scrollWidth}px wide in a ${result.viewport}px viewport; ` +
						`overflowing: ${result.offenders.join(', ') || '(none located)'}`
				]
			: [];
	expect(problems, 'sideways overflow').toEqual([]);
}

function checkAllowlist(allowlist: readonly AllowlistEntry[]): void {
	allowlist.forEach((entry, i) => {
		if (typeof entry?.selector !== 'string' || entry.selector.trim() === '') {
			throw new Error(`a11y allowlist entry ${i} has no selector`);
		}
		if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
			throw new Error(`a11y allowlist entry ${i} (${entry.selector}) has no reason`);
		}
	});
}

async function allowlisted(
	page: Page,
	node: AxeNode,
	allowlist: readonly AllowlistEntry[]
): Promise<boolean> {
	if (allowlist.length === 0) return false;
	const [selector, ...rest] = node.target;
	// Nodes inside an iframe or shadow root are never allowlisted.
	if (rest.length > 0 || typeof selector !== 'string') return false;
	return page.evaluate(
		([target, selectors]) => {
			const el = document.querySelector(target);
			return el !== null && selectors.some((s) => el.matches(s));
		},
		[selector, allowlist.map((entry) => entry.selector)] as const
	);
}

function targetText(node: AxeNode): string {
	return node.target
		.map((part) => (typeof part === 'string' ? part : part.join(' >> ')))
		.join(' | ');
}

function summary(node: AxeNode): string {
	return (node.failureSummary ?? node.any.map((check) => check.message).join('; '))
		.replace(/\s+/g, ' ')
		.trim();
}

/** The first opaque colour in an innermost-first background chain. */
function firstOpaque(backgrounds: readonly string[]): string {
	for (const background of backgrounds) {
		if (parseColour(background).kind === 'opaque') return background;
	}
	throw new Error('no opaque background behind it');
}

function checkFocusStop(
	at: {
		label: string;
		focusVisible: boolean;
		outlineStyle: string;
		outlineWidth: string;
		outlineColour: string;
		backgrounds: string[];
	},
	problems: string[]
): FocusStop {
	const stop: FocusStop = {
		label: at.label,
		focusVisible: at.focusVisible,
		outlineStyle: at.outlineStyle,
		outlineWidth: at.outlineWidth,
		outlineColour: at.outlineColour,
		background: null,
		ratio: null
	};
	if (at.outlineStyle === 'none' || at.outlineStyle === 'hidden') {
		problems.push(`${at.label} has no focus outline (outline-style: ${at.outlineStyle})`);
		return stop;
	}
	if (!(parseFloat(at.outlineWidth) >= FOCUS_MIN_WIDTH_PX)) {
		problems.push(`${at.label} focus outline is ${at.outlineWidth} (< ${FOCUS_MIN_WIDTH_PX}px)`);
	}
	try {
		stop.background = firstOpaque(at.backgrounds);
		stop.ratio = contrastRatio(at.outlineColour, stop.background);
		if (stop.ratio < NON_TEXT_MIN) {
			problems.push(
				`${at.label} focus outline ${at.outlineColour} on ${stop.background} is ${stop.ratio.toFixed(2)}:1 (< ${NON_TEXT_MIN}:1)`
			);
		}
	} catch (error) {
		problems.push(`${at.label} focus outline: ${(error as Error).message}`);
	}
	return stop;
}

/** Install the in-page Probe; a no-op if this document already has it. */
async function installProbe(page: Page): Promise<void> {
	await page.evaluate(() => {
		if (window.__a11yProbe) return;
		window.__a11yProbe = {
			describe(el) {
				const id = el.id ? `#${el.id}` : '';
				const input = el as HTMLInputElement;
				const name =
					el.getAttribute('aria-label') ||
					input.labels?.[0]?.textContent ||
					el.textContent ||
					el.getAttribute('name') ||
					'';
				const text = name.replace(/\s+/g, ' ').trim().slice(0, 40);
				// Single quotes: expect's diff escapes double quotes in failure messages.
				return `${el.tagName.toLowerCase()}${id}${text ? ` '${text}'` : ''}`;
			},
			backgrounds(el) {
				const out: string[] = [];
				for (let at = el; at; at = at.parentElement) out.push(getComputedStyle(at).backgroundColor);
				return out;
			},
			tabbables() {
				const radioGroups = new Set<string>();
				const candidates = document.querySelectorAll(
					'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"])'
				);
				return [...candidates].filter((el) => {
					if (!(el instanceof HTMLElement) || el.tabIndex < 0) return false;
					if (el.matches(':disabled') || el.closest('[inert]')) return false;
					if (el instanceof HTMLInputElement) {
						if (el.type === 'hidden') return false;
						// A radio group is one tab stop.
						if (el.type === 'radio' && el.name) {
							const group = `${el.form?.id ?? ''}|${el.name}`;
							if (radioGroups.has(group)) return false;
							radioGroups.add(group);
						}
					}
					return el.checkVisibility({ visibilityProperty: true });
				});
			},
			visited: []
		};
	});
}
