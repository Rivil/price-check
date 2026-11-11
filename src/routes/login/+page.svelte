<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>Sign in · Amazon price check</title>
</svelte:head>

<main>
	<h1>Sign in</h1>

	<form method="post" use:enhance>
		<label>
			Email
			<!-- defaultValue, not value: hydration must not wipe what was typed before it finished -->
			<input
				type="email"
				name="email"
				autocomplete="username"
				required
				defaultValue={form?.email ?? ''}
			/>
		</label>
		<label>
			Password
			<input type="password" name="password" autocomplete="current-password" required />
		</label>
		{#if form?.message}
			<p role="alert">{form.message}</p>
		{/if}
		<button>Sign in</button>
	</form>
</main>
