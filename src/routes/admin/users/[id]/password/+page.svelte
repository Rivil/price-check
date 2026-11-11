<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Reset password · Amazon price check</title>
</svelte:head>

<main>
	<p><a href={resolve('/admin/users')}>Household accounts</a></p>
	<h1>Reset password for {data.account.name}</h1>
	<p>{data.account.email}</p>

	<form method="post" use:enhance>
		<label>
			New password
			<input type="password" name="newPassword" autocomplete="new-password" required />
		</label>
		{#if form?.message}
			<p role="alert">{form.message}</p>
		{:else if form?.warning}
			<p role="alert">{form.warning}</p>
		{:else if form?.reset}
			<p role="status">Password reset. They have been signed out everywhere.</p>
		{/if}
		<button>Reset password</button>
	</form>
</main>
