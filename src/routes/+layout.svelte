<script lang="ts">
	import '#lib/styles/tokens.css';
	import '#lib/styles/base.css';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import favicon from '#lib/assets/favicon.svg';
	import { navItems } from '#lib/nav.ts';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// Server-rendered from the request URL, so aria-current is right before hydration.
	const items = $derived(
		data.nav ? navItems({ pathname: page.url.pathname, isAdmin: data.nav.isAdmin }) : []
	);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if data.nav}
	<header class="site-header">
		<div class="bar">
			<!-- Plain text, not a heading: each page owns its one h1. -->
			<span class="brand">Amazon price check</span>
			<nav aria-label="Main">
				<ul>
					{#each items as item (item.href)}
						<li>
							<a href={resolve(item.href)} aria-current={item.current}>{item.label}</a>
						</li>
					{/each}
					<li>
						<!-- A POST, never a GET link: logout must not be prefetchable (sign_out_control). -->
						<form method="post" action="/logout">
							<button class="link">Sign out</button>
						</form>
					</li>
				</ul>
			</nav>
		</div>
	</header>
{/if}

{@render children()}

<style>
	.site-header {
		background: var(--surface);
		border-block-end: var(--border-width) solid var(--border);
	}

	.bar {
		max-width: 44rem;
		margin-inline: auto;
		padding: var(--space-3) var(--space-4);
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2) var(--space-5);
	}

	.brand {
		font-weight: 600;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}

	a {
		text-decoration: none;
	}

	a:hover,
	a[aria-current='page'] {
		text-decoration: underline;
	}

	a[aria-current='page'] {
		font-weight: 600;
		color: var(--text);
	}

	form {
		margin: 0;
	}

	/* Sign out looks like the links beside it; it keeps the global focus outline. */
	.link {
		background: none;
		border: none;
		border-radius: 0;
		padding: 0;
		color: var(--accent);
		font: inherit;
	}

	.link:hover {
		text-decoration: underline;
	}
</style>
