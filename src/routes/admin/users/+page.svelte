<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Household accounts · Amazon price check</title>
</svelte:head>

<main>
	<h1>Household accounts</h1>

	<table>
		<thead>
			<tr>
				<th scope="col">Name</th>
				<th scope="col">Email</th>
				<th scope="col">Role</th>
				<th scope="col"><span class="visually-hidden">Actions</span></th>
			</tr>
		</thead>
		<tbody>
			{#each data.accounts as account (account.id)}
				<tr>
					<td>{account.name}</td>
					<td>{account.email}</td>
					<td>{account.role ?? 'user'}</td>
					<td>
						<a href={resolve('/admin/users/[id]/password', { id: account.id })}>Reset password</a>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<h2>Create an account</h2>

	<!-- defaultValue, not value: hydration must not wipe what was typed before it finished -->
	<form method="post" action="?/create" use:enhance>
		<label>
			Name
			<input name="name" autocomplete="off" required defaultValue={form?.name ?? ''} />
		</label>
		<label>
			Email
			<input
				type="email"
				name="email"
				autocomplete="off"
				required
				defaultValue={form?.email ?? ''}
			/>
		</label>
		<label>
			Initial password
			<input type="password" name="password" autocomplete="new-password" required />
		</label>
		<label>
			<input type="checkbox" name="role" value="admin" defaultChecked={form?.role === 'admin'} />
			Admin
		</label>
		{#if form?.message}
			<p role="alert">{form.message}</p>
		{:else if form?.created}
			<p role="status">Created {form.created}.</p>
		{/if}
		<button>Create account</button>
	</form>
</main>

<style>
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
