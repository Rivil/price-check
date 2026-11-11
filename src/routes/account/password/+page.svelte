<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>Account · Amazon price check</title>
</svelte:head>

<main>
	<h1>Account</h1>

	<h2>Change password</h2>

	<form method="post" use:enhance>
		<label>
			Current password
			<input type="password" name="currentPassword" autocomplete="current-password" required />
		</label>
		<label>
			New password
			<input type="password" name="newPassword" autocomplete="new-password" required />
		</label>
		{#if form?.message}
			<p role="alert">{form.message}</p>
		{:else if form?.changed}
			<p role="status">Password changed. Other devices have been signed out.</p>
		{/if}
		<button>Change password</button>
	</form>
</main>
