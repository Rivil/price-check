<script lang="ts">
	import { enhance } from '$app/forms';
	import PriceChart from '#lib/components/PriceChart.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const watch = $derived(data.watch);
</script>

<svelte:head>
	<title>{watch.label} · Amazon price check</title>
</svelte:head>

<main>
	<h1>{watch.label}</h1>

	{#if watch.imageUrl}
		<img src={watch.imageUrl} alt={watch.label} width="240" height="240" />
	{/if}

	<dl>
		<!-- A failed check keeps the last known price (failure_keeps_price). -->
		<dt>{watch.failure ? 'Last known price' : 'Current price'}</dt>
		<!-- Colour is never the only signal: the label says it in words. -->
		<dd class:at-target={watch.atOrBelowTarget}>
			{watch.price ?? 'Not known yet'}{#if watch.atOrBelowTarget}
				· <span class="at-target-label">at or below target</span>{/if}
		</dd>
		<dt>Target price</dt>
		<dd>{watch.target ?? 'No target'}</dd>
		<dt>Last checked</dt>
		<dd>{watch.checkedAt ?? 'Never'}</dd>
		{#if watch.failure}
			<dt>Last check failed</dt>
			<dd class="failure">
				{watch.failure.label}{watch.failure.message ? ` — ${watch.failure.message}` : ''}
			</dd>
		{/if}
	</dl>

	<p>
		<a href={watch.canonicalUrl} rel="external noreferrer noopener" target="_blank"
			>View on Amazon</a
		>
	</p>

	<form method="post" action="?/check" use:enhance>
		<button>Check now</button>
		{#if form?.checkMessage}
			<p role="alert">{form.checkMessage}</p>
		{:else if form?.checked !== undefined}
			<p role="status">
				{form.checked ? 'Checked just now.' : 'Checked just now — the check failed.'}
			</p>
		{/if}
	</form>

	<h2>Price history</h2>
	{#if data.chart && data.stats}
		<PriceChart input={data.chart} />
		<dl class="stats">
			<dt>Lowest ever</dt>
			<dd>{data.stats.lowest}</dd>
			<dt>Highest ever</dt>
			<dd>{data.stats.highest}</dd>
			<dt>Average</dt>
			<dd>{data.stats.average}</dd>
			<dt>Change since added</dt>
			<dd>{data.stats.change ?? 'Not known'}</dd>
		</dl>
	{:else}
		<p>No successful check yet, so there's no chart or price stats.</p>
	{/if}
	{#if data.timeline.length > 0}
		<table>
			<thead>
				<tr>
					<th scope="col">Checked</th>
					<th scope="col">Result</th>
				</tr>
			</thead>
			<tbody>
				{#each data.timeline as row, i (i)}
					<tr>
						<td>{row.checkedAt}</td>
						{#if row.kind === 'failure'}
							<td class="failure">Failed: {row.reason}</td>
						{:else}
							<td>{row.price}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<h2>Target price</h2>
	<form method="post" action="?/target" use:enhance>
		<label>
			New target (£, leave empty to clear)
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
		{:else if form?.saved}
			<p role="status">Target saved.</p>
		{/if}
		<button>Save target</button>
	</form>

	<h2>Stop watching</h2>
	<form method="post" action="?/delete" use:enhance>
		<button>Delete this watch</button>
	</form>
</main>

<style>
	dl {
		display: grid;
		/* minmax(0, …): the value column may shrink below its longest word (c-4). */
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--space-1) var(--space-4);
	}
	dd {
		margin: 0;
	}
	img {
		object-fit: contain;
	}
	/* A long unbroken reason in the next cell would otherwise squeeze the time to nothing. */
	td:first-child {
		white-space: nowrap;
	}
	.at-target {
		color: var(--ok);
	}
	.at-target-label {
		font-weight: 600;
	}
</style>
