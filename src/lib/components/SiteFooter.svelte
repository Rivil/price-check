<!--
	Every page's footer. The Source link offers the running code to its users, as
	AGPL-3.0 §13 requires of a network-served modified version.
-->
<script lang="ts">
	const SOURCE_URL = 'https://github.com/Rivil/price-check';
</script>

<footer class="site-footer">
	<div class="bar">
		<a href={SOURCE_URL}>Source</a>
	</div>
</footer>

<style>
	.site-footer {
		border-block-start: var(--border-width) solid var(--border);
	}

	.bar {
		max-width: 44rem;
		margin-inline: auto;
		padding: var(--space-3) var(--space-4);
	}
</style>
