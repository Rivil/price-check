<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Watchlist · Amazon price check</title>
</svelte:head>

<main>
	<h1>Your watchlist</h1>

	<h2>Add a product</h2>
	<!-- defaultValue, not value: hydration must not wipe what was typed before it finished -->
	<form method="post" action="?/add" use:enhance>
		<label>
			Product link
			<input
				name="url"
				type="text"
				inputmode="url"
				autocomplete="off"
				placeholder="https://www.amazon.co.uk/dp/…"
				required
				defaultValue={form?.url ?? ''}
			/>
		</label>
		<label>
			Target price (£, optional)
			<input
				name="target"
				type="text"
				inputmode="decimal"
				autocomplete="off"
				placeholder="24.99"
				defaultValue={form?.target ?? ''}
			/>
		</label>
		{#if form?.message}
			<p role="alert">{form.message}</p>
		{:else if form?.added}
			<p role="status">Added {form.added}.</p>
		{/if}
		<button>Add to watchlist</button>
	</form>

	<h2>Watching</h2>
	{#if data.watches.length === 0}
		<p>Nothing on your watchlist yet.</p>
	{:else}
		<ul class="watches">
			{#each data.watches as watch (watch.id)}
				<li data-watch-id={watch.id}>
					{#if watch.imageUrl}
						<img src={watch.imageUrl} alt={watch.label} width="80" height="80" loading="lazy" />
					{/if}
					<div>
						<p class="label">
							<a href={resolve('/watches/[id]', { id: watch.id })}>{watch.label}</a>
						</p>
						{#if watch.failure}
							{#if watch.price}
								<p class="price">Last known {watch.price}</p>
							{/if}
						{:else if watch.price}
							<!-- Colour is never the only signal: the label says it in words. -->
							<p class="price" class:at-target={watch.atOrBelowTarget}>
								Now {watch.price}{#if watch.atOrBelowTarget}
									· <span class="at-target-label">at or below target</span>{/if}
							</p>
						{/if}
						{#if watch.target}
							<p class="target">Target {watch.target}</p>
						{/if}
						{#if watch.sparkline}
							<!-- The drawing stretches to fit, so the dot is a round-capped stroke: a circle
							     would stretch with it. -->
							<svg
								class="sparkline"
								role="img"
								aria-label={watch.sparklineLabel}
								width="120"
								height="32"
								viewBox="0 0 100 100"
								preserveAspectRatio="none"
							>
								<path class="line" d={watch.sparkline.path} />
								<path class="dot" d="M{watch.sparkline.dot.x} {watch.sparkline.dot.y}h0" />
							</svg>
						{:else if watch.price}
							<p class="no-sparkline">No recent prices</p>
						{:else}
							<p class="no-sparkline">No successful check yet</p>
						{/if}
						<p class={watch.status.failed ? 'failure' : 'status'}>{watch.status.text}</p>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	.watches {
		list-style: none;
		padding: 0;
	}
	.watches li {
		display: flex;
		gap: var(--space-4);
		align-items: flex-start;
		margin-block: var(--space-4);
	}
	.watches img {
		object-fit: contain;
		flex: none;
	}
	/* A flex child's min-width is its content's by default: let long titles wrap (c-4). */
	.watches li > div {
		min-width: 0;
	}
	.at-target {
		color: var(--ok);
	}
	.at-target-label {
		font-weight: 600;
	}
	.label,
	.price,
	.target,
	.status,
	.no-sparkline,
	.failure {
		margin: 0;
	}
	.status,
	.no-sparkline {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	/* Overflow, because the latest point sits on the right edge. */
	.sparkline {
		display: block;
		max-width: 100%;
		margin-block: var(--space-1);
		overflow: visible;
	}
	.sparkline path {
		fill: none;
		stroke: var(--accent);
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}
	.line {
		stroke-width: 2;
	}
	.dot {
		stroke-width: 6;
	}
</style>
