import { page, userEvent } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { ChartInput } from '../chart.ts';
import '../styles/tokens.css';
import PriceChart from './PriceChart.svelte';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 12);
const REASON = 'Failed: Blocked by Amazon · 28 Oct 2026, 12:00';

const point = (daysAgo: number, pricePence = 1000) => ({
	at: NOW - daysAgo * DAY,
	pricePence,
	label: `£${pricePence / 100} · ${daysAgo} days ago`
});

const input = (overrides: Partial<ChartInput> = {}): ChartInput => ({
	points: [point(100, 3000), point(50, 2000), point(10, 1000), point(1, 1500)],
	failures: [{ at: NOW - 5 * DAY, label: REASON }],
	targetPence: null,
	now: NOW,
	...overrides
});

const marks = () => [...document.querySelectorAll<HTMLButtonElement>('.mark')];
const tabStops = () => marks().filter((mark) => mark.tabIndex === 0);
const plot = () => document.querySelector<HTMLElement>('.plot') as HTMLElement;
const tooltip = () => page.getByRole('tooltip');

/** The plot's own handlers, at a mark's centre: mark buttons ignore the pointer. */
function pointerAt(mark: HTMLElement, type: 'pointermove' | 'click') {
	const { left, top, width, height } = mark.getBoundingClientRect();
	const at = { clientX: left + width / 2, clientY: top + height / 2, bubbles: true };
	plot().dispatchEvent(
		type === 'click'
			? new MouseEvent('click', at)
			: new PointerEvent('pointermove', { ...at, pointerType: 'mouse' })
	);
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('PriceChart', () => {
	it('opens all time', async () => {
		render(PriceChart, { input: input() });

		await expect
			.element(page.getByRole('button', { name: 'All time' }))
			.toHaveAttribute('aria-pressed', 'true');
		await expect
			.element(page.getByRole('button', { name: '30 days' }))
			.toHaveAttribute('aria-pressed', 'false');
		expect(marks()).toHaveLength(5);
	});

	it('draws the line through each range', async () => {
		render(PriceChart, { input: input() });
		const commands = () =>
			document.querySelector('.lines .line')?.getAttribute('d')?.match(/[ML]/g);

		expect(commands()).toEqual(['M', 'L', 'L', 'L']);

		await page.getByRole('button', { name: '30 days' }).click();
		await expect
			.element(page.getByRole('button', { name: '30 days' }))
			.toHaveAttribute('aria-pressed', 'true');

		expect(commands()).toEqual(['M', 'L']);
	});

	it('range redraw', async () => {
		render(PriceChart, { input: input() });

		await page.getByRole('button', { name: '30 days' }).click();

		await expect
			.element(page.getByRole('button', { name: '30 days' }))
			.toHaveAttribute('aria-pressed', 'true');
		await expect
			.element(page.getByRole('button', { name: 'All time' }))
			.toHaveAttribute('aria-pressed', 'false');
		expect(marks()).toHaveLength(3);
	});

	it('target line', async () => {
		const { unmount } = render(PriceChart, { input: input({ targetPence: 1250 }) });

		expect(document.querySelector('.lines .target')).not.toBeNull();
		await expect.element(page.getByText('Target £12.50')).toBeInTheDocument();

		unmount();
		render(PriceChart, { input: input() });

		expect(document.querySelector('.target')).toBeNull();
		expect(document.body.textContent).not.toContain('Target');
	});

	it('failure shape', async () => {
		render(PriceChart, { input: input() });

		const failed = marks().filter((mark) => mark.getAttribute('aria-label') === REASON);
		expect(failed).toHaveLength(1);
		expect(failed[0].querySelector('.cross')).not.toBeNull();
		expect(failed[0].querySelector('.dot')).toBeNull();

		const priced = marks().filter((mark) => mark !== failed[0]);
		for (const mark of priced) {
			expect(mark.querySelector('.dot')).not.toBeNull();
			expect(mark.querySelector('.cross')).toBeNull();
		}

		expect(failed[0].getAttribute('aria-label')).toMatch(/^Failed/);
		await expect.element(page.getByText('Failed check')).toBeInTheDocument();
	});

	it('hover', async () => {
		render(PriceChart, { input: input() });

		pointerAt(marks()[0], 'pointermove');
		await expect.element(tooltip()).toHaveTextContent('£30 · 100 days ago');

		pointerAt(marks()[3], 'pointermove');
		await expect.element(tooltip()).toHaveTextContent(REASON);

		plot().dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
		await expect.element(tooltip()).not.toBeInTheDocument();
	});

	it('tap', async () => {
		render(PriceChart, { input: input() });

		pointerAt(marks()[3], 'click');
		await expect.element(tooltip()).toHaveTextContent(REASON);

		// A touch's pointerleave comes as the finger lifts.
		plot().dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'touch' }));
		await expect.element(tooltip()).toHaveTextContent(REASON);

		pointerAt(marks()[0], 'click');
		await expect.element(tooltip()).toHaveTextContent('£30 · 100 days ago');
	});

	it('focus', async () => {
		render(PriceChart, { input: input() });

		marks()[3].focus();
		await expect.element(tooltip()).toHaveTextContent(REASON);

		marks()[0].focus();
		await expect.element(tooltip()).toHaveTextContent('£30 · 100 days ago');

		marks()[0].blur();
		await expect.element(tooltip()).not.toBeInTheDocument();
	});

	it('mouse leave keeps focus', async () => {
		render(PriceChart, { input: input() });

		marks()[3].focus();
		await expect.element(tooltip()).toHaveTextContent(REASON);

		pointerAt(marks()[0], 'pointermove');
		await expect.element(tooltip()).toHaveTextContent('£30 · 100 days ago');

		plot().dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
		await expect.element(tooltip()).toHaveTextContent(REASON);

		marks()[3].blur();
		await expect.element(tooltip()).not.toBeInTheDocument();
	});

	it('keyboard activation', async () => {
		render(PriceChart, { input: input() });

		// The latest mark is the one furthest from the viewport origin, where a
		// keyboard click's coordinates would land if it reached the plot.
		marks()[4].focus();
		await expect.element(tooltip()).toHaveTextContent('£15 · 1 days ago');

		await userEvent.keyboard('{Enter}');
		await expect.element(tooltip()).toHaveTextContent('£15 · 1 days ago');

		await userEvent.keyboard(' ');
		await expect.element(tooltip()).toHaveTextContent('£15 · 1 days ago');
		expect(document.activeElement).toBe(marks()[4]);
	});

	it('roving', async () => {
		const points = Array.from({ length: 300 }, (_, i) => point(300 - i));
		render(PriceChart, { input: input({ points, failures: [] }) });

		expect(marks()).toHaveLength(300);
		expect(tabStops()).toEqual([marks()[299]]);

		marks()[299].focus();
		await userEvent.keyboard('{ArrowLeft}');

		expect(document.activeElement).toBe(marks()[298]);
		expect(tabStops()).toEqual([marks()[298]]);
		await expect.element(tooltip()).toHaveTextContent('£10 · 2 days ago');

		await userEvent.keyboard('{Escape}');
		await expect.element(tooltip()).not.toBeInTheDocument();
		expect(document.activeElement).toBe(marks()[298]);
	});

	it('range drops active', async () => {
		const { rerender } = render(PriceChart, { input: input() });

		// A native click moves neither pointer nor focus, so only the range change can
		// do this work.
		const choose = async (name: string) => {
			const button = page.getByRole('button', { name });
			(button.element() as HTMLElement).click();
			await expect.element(button).toHaveAttribute('aria-pressed', 'true');
		};
		const leaveTabStopOn = (index: number) => {
			marks()[index].focus();
			marks()[index].blur();
		};

		// A tap, so no blur closes it, on an index still in bounds after the change.
		pointerAt(marks()[1], 'click');
		await expect.element(tooltip()).toHaveTextContent('£20 · 50 days ago');
		await choose('30 days');
		expect(marks()).toHaveLength(3);
		await expect.element(tooltip()).not.toBeInTheDocument();

		// A stale index in bounds is still one tab stop, so pin which mark holds it.
		await choose('All time');
		leaveTabStopOn(1);
		await choose('30 days');
		expect(tabStops()).toEqual([marks()[2]]);

		// A stale index past the end of the new marks.
		await choose('All time');
		leaveTabStopOn(4);
		await choose('30 days');
		expect(tabStops()).toEqual([marks()[2]]);

		// A reload that drops marks never goes through chooseRange.
		await choose('All time');
		leaveTabStopOn(4);
		const before = input();
		await rerender({ input: { ...before, points: before.points.slice(0, 2) } });
		expect(marks()).toHaveLength(3);
		expect(tabStops()).toEqual([marks()[2]]);
	});

	it('empty range', async () => {
		render(PriceChart, { input: input({ points: [point(100)], failures: [] }) });

		await page.getByRole('button', { name: '30 days' }).click();

		await expect.element(page.getByText('No checks in this range.')).toBeInTheDocument();
		expect(marks()).toHaveLength(0);
		for (const name of ['30 days', '90 days', 'All time']) {
			await expect.element(page.getByRole('button', { name })).toBeInTheDocument();
		}
	});

	it('new data', async () => {
		const { rerender } = render(PriceChart, { input: input() });
		await page.getByRole('button', { name: '30 days' }).click();
		expect(marks()).toHaveLength(3);

		const before = input();
		await rerender({ input: { ...before, points: [...before.points, point(0, 1100)] } });

		await expect
			.element(page.getByRole('button', { name: '30 days' }))
			.toHaveAttribute('aria-pressed', 'true');
		expect(marks()).toHaveLength(4);
		expect(marks()[3].getAttribute('aria-label')).toBe('£11 · 0 days ago');
	});

	it('chart semantics', async () => {
		render(PriceChart, { input: input() });

		expect(document.querySelector('[role="img"]')).toBeNull();
		const chart = page.getByRole('group', { name: 'Price chart' });
		await expect.element(chart).toBeInTheDocument();
		const describedBy = chart.element().getAttribute('aria-describedby') as string;
		expect(document.getElementById(describedBy)?.textContent).toContain('history table');
	});

	it('dense pointer', async () => {
		const points = Array.from({ length: 1460 }, (_, i) => ({
			at: NOW - (1460 - i) * (DAY / 4),
			pricePence: 1000,
			label: `mark ${i}`
		}));
		const { container } = render(PriceChart, { input: input({ points, failures: [] }) });
		container.style.width = '372px';

		const box = plot().getBoundingClientRect();
		expect(box.width).toBeLessThanOrEqual(340);

		const pointAtX = (clientX: number, type: 'click' | 'pointermove') =>
			plot().dispatchEvent(
				type === 'click'
					? new MouseEvent('click', { clientX, clientY: box.top + 50, bubbles: true })
					: new PointerEvent('pointermove', {
							clientX,
							clientY: box.top + 50,
							pointerType: 'mouse',
							bubbles: true
						})
			);

		// A flat series, so only x decides between neighbours under a half-pixel apart.
		pointAtX(box.left, 'click');
		await expect.element(tooltip()).toHaveTextContent('mark 0');

		pointAtX(box.right, 'pointermove');
		await expect.element(tooltip()).toHaveTextContent('mark 1459');

		const middle = marks()[730].getBoundingClientRect();
		expect(getComputedStyle(marks()[730]).pointerEvents).toBe('none');
		const hit = document.elementFromPoint(
			middle.left + middle.width / 2,
			middle.top + middle.height / 2
		);
		expect(hit?.closest('.mark')).toBeNull();
		expect(hit?.closest('.plot')).toBe(plot());

		// Both edges saturate, so only an interior position shows a wrong plot width.
		// Neighbours sit under a half-pixel apart, so this asserts near, not exact.
		pointAtX(middle.left + middle.width / 2, 'click');
		await expect.element(tooltip()).toHaveTextContent(/^mark 7[23]\d$/);
	});
});
