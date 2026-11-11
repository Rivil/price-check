<script lang="ts">
	import {
		chartView,
		DEFAULT_RANGE,
		nearestMark,
		nextMark,
		RANGES,
		type ChartInput,
		type ChartRange
	} from '../chart.ts';
	import { formatPence } from '../money.ts';

	// `now` comes inside input: nothing here may read the viewer's clock, or the
	// server's render and the browser's would disagree.
	let { input }: { input: ChartInput } = $props();

	const descriptionId = $props.id();

	let range = $state<ChartRange>(DEFAULT_RANGE);
	/** The roving tab stop; null until a mark takes focus, which leaves it on the latest. */
	let active = $state<number | null>(null);
	/** The mark whose tooltip is open. */
	let shown = $state<number | null>(null);
	let plot = $state<HTMLElement>();

	const view = $derived(chartView(input, range));
	const stop = $derived(Math.min(active ?? Infinity, view.marks.length - 1));
	const tip = $derived(shown === null ? undefined : view.marks[shown]);

	function chooseRange(id: ChartRange) {
		range = id;
		// Indexes mean different marks in the new range.
		active = null;
		shown = null;
	}

	function showNearest(event: MouseEvent) {
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const { clientX, clientY } = event;
		shown = nearestMark(view.marks, clientX - box.left, clientY - box.top, box.width, box.height);
	}

	function hideOnLeave(event: PointerEvent) {
		// A touch leaves as the finger lifts, which would close the tooltip it just opened.
		if (event.pointerType !== 'mouse') return;
		// A mouse passing over the plot must not take a focused mark's tooltip with it.
		shown = plot?.contains(document.activeElement) ? active : null;
	}

	function onMarkKey(event: KeyboardEvent, index: number) {
		if (event.key === 'Escape') {
			shown = null;
			return;
		}
		const next = nextMark(index, event.key, view.marks.length);
		if (next === null) return;
		event.preventDefault();
		plot?.querySelectorAll<HTMLElement>('.mark')[next]?.focus();
	}
</script>

<div class="chart" role="group" aria-label="Price chart" aria-describedby={descriptionId}>
	<div class="ranges" role="group" aria-label="Chart range">
		{#each RANGES as { id, label } (id)}
			<button type="button" aria-pressed={id === range} onclick={() => chooseRange(id)}>
				{label}
			</button>
		{/each}
	</div>

	{#if view.empty}
		<p class="empty">No checks in this range.</p>
	{:else}
		<!-- The pointer only needs to be closest to a mark, which no single mark's target
		     can offer at 1,460 marks; keyboard and screen readers use the mark buttons. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="plot"
			bind:this={plot}
			onpointermove={showNearest}
			onpointerleave={hideOnLeave}
			onclick={showNearest}
		>
			<svg class="lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
				{#if view.targetY !== null}
					<line class="target" x1="0" x2="100" y1={view.targetY} y2={view.targetY} />
				{/if}
				<path class="line" d={view.line} />
			</svg>

			<!-- A mark only ever gets a click from the keyboard or a screen reader. That click
			     carries no pointer position, so it must not reach the plot's nearest-mark lookup. -->
			{#each view.marks as mark, index (index)}
				<button
					type="button"
					class={['mark', { failed: mark.kind === 'failure' }]}
					tabindex={index === stop ? 0 : -1}
					aria-label={mark.label}
					style:left="{mark.x}%"
					style:top="{mark.y}%"
					onfocus={() => {
						active = index;
						shown = index;
					}}
					onblur={() => (shown = null)}
					onkeydown={(event) => onMarkKey(event, index)}
					onclick={(event) => event.stopPropagation()}
				>
					<svg viewBox="0 0 10 10" aria-hidden="true">
						{#if mark.kind === 'failure'}
							<path class="cross" d="M1 1L9 9M9 1L1 9" />
						{:else}
							<circle class="dot" cx="5" cy="5" r="5" />
						{/if}
					</svg>
				</button>
			{/each}

			{#if tip}
				<!-- Anchored to the side with more room, and no wider than that room. -->
				<div
					class="tooltip"
					role="tooltip"
					style:left={tip.x < 50 ? `${tip.x}%` : null}
					style:right={tip.x < 50 ? null : `${100 - tip.x}%`}
					style:top={tip.y < 50 ? `${tip.y}%` : null}
					style:bottom={tip.y < 50 ? null : `${100 - tip.y}%`}
					style:max-width="min(16rem, {Math.max(tip.x, 100 - tip.x)}%)"
				>
					{tip.label}
				</div>
			{/if}
		</div>
	{/if}

	<ul class="legend">
		<li>
			<svg class="key" viewBox="0 0 10 10" aria-hidden="true">
				<circle class="dot" cx="5" cy="5" r="4" />
			</svg>
			Price check
		</li>
		<li>
			<svg class="key" viewBox="0 0 10 10" aria-hidden="true">
				<path class="cross" d="M1 1L9 9M9 1L1 9" />
			</svg>
			Failed check
		</li>
		{#if input.targetPence !== null}
			<li>
				<svg class="key" viewBox="0 0 10 10" aria-hidden="true">
					<line class="target" x1="0" x2="10" y1="5" y2="5" />
				</svg>
				Target {formatPence(input.targetPence)}
			</li>
		{/if}
	</ul>

	<p class="description" id={descriptionId}>
		Every check on this chart is also listed in the history table.
	</p>
</div>

<style>
	.chart {
		background: var(--surface);
		border: var(--border-width) solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3);
		margin-block: var(--space-3);
	}

	.ranges {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.ranges button {
		padding: var(--space-1) var(--space-3);
		font-size: var(--text-sm);
	}

	.ranges button[aria-pressed='false'] {
		background: var(--surface);
		color: var(--text);
		border-color: var(--border);
	}

	.empty {
		margin-block: var(--space-4);
		color: var(--text-muted);
	}

	/* The inline margin leaves room for a mark centred on either edge. */
	.plot {
		position: relative;
		height: 14rem;
		margin: var(--space-4) var(--space-2);
	}

	svg {
		display: block;
		overflow: visible;
	}

	.lines {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	.line,
	.target,
	.cross {
		fill: none;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
	}

	.line {
		stroke: var(--accent);
		stroke-linejoin: round;
		stroke-linecap: round;
	}

	.target {
		stroke: var(--text-muted);
		stroke-dasharray: 6 4;
	}

	.cross {
		stroke: var(--danger);
		stroke-linecap: round;
	}

	.dot {
		fill: var(--accent);
	}

	/* A reset of base.css's accent button: the mark itself is all that shows. */
	.mark {
		position: absolute;
		width: var(--space-2);
		height: var(--space-2);
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: none;
		transform: translate(-50%, -50%);
		pointer-events: none;
	}

	.mark.failed {
		width: var(--space-3);
		height: var(--space-3);
	}

	.mark svg {
		width: 100%;
		height: 100%;
	}

	.tooltip {
		position: absolute;
		z-index: 1;
		width: max-content;
		margin-block: var(--space-2);
		padding: var(--space-1) var(--space-2);
		background: var(--surface);
		color: var(--text);
		border: var(--border-width) solid var(--border);
		border-radius: var(--radius);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
		pointer-events: none;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.key {
		width: var(--space-3);
		height: var(--space-3);
	}

	.description {
		margin-block: var(--space-2) 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
</style>
