<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type Card = (typeof data.channels)[string];

	const text = (card: Card, field: string) =>
		card && typeof card[field] === 'string' ? (card[field] as string) : null;

	// A new card starts with its type's default kinds, as load reports them.
	const ticks = (kind: string, card: Card) => ({
		priceDrops: card?.priceDrops ?? data.defaults[kind]?.priceDrops ?? true,
		checkFailures: card?.checkFailures ?? data.defaults[kind]?.checkFailures ?? false
	});

	const ntfy = $derived(data.channels.ntfy);
	const topic = $derived(text(ntfy, 'topic'));
	const ntfyTicks = $derived(ticks('ntfy', ntfy));

	const resend = $derived(data.channels.resend);
	const sender = $derived(text(resend, 'from'));
	// A new card's recipient starts as the login email (decision recipient_default).
	const recipient = $derived(text(resend, 'to') ?? data.loginEmail);
	const resendTicks = $derived(ticks('resend', resend));

	const smtp = $derived(data.channels.smtp);
	const smtpHost = $derived(text(smtp, 'host'));
	// A new card's port starts as 587, STARTTLS submission (decision port_default).
	const smtpPort = $derived(text(smtp, 'port') ?? '587');
	const smtpUsername = $derived(text(smtp, 'username'));
	const smtpSender = $derived(text(smtp, 'from'));
	const smtpRecipient = $derived(text(smtp, 'to') ?? data.loginEmail);
	const smtpTicks = $derived(ticks('smtp', smtp));

	// The card a save or enable/disable refusal belongs to.
	const messageKind = $derived(form && 'kind' in form ? form.kind : null);
</script>

<!-- Each message renders only in the card whose kind it carries. -->
{#snippet saveMessage(kind: string)}
	{#if messageKind === kind && form?.message}
		<p role="alert">{form.message}</p>
	{:else if form?.saved === kind}
		<p role="status">Saved.</p>
	{/if}
{/snippet}

{#snippet sendMe(ticked: { priceDrops: boolean; checkFailures: boolean })}
	<fieldset>
		<legend>Send me</legend>
		<label class="check">
			<input type="checkbox" name="price_drops" defaultChecked={ticked.priceDrops} />
			Price drops
		</label>
		<label class="check">
			<input type="checkbox" name="check_failures" defaultChecked={ticked.checkFailures} />
			Failed checks
		</label>
	</fieldset>
{/snippet}

{#snippet channelState(card: NonNullable<Card>)}
	<p data-testid="channel-state">
		{#if card.enabled}
			Status: <strong>Enabled</strong>.
		{:else}
			Status: <strong>Disabled</strong> — no alerts are sent here until you enable it.
		{/if}
	</p>
{/snippet}

{#snippet channelActions(kind: string, card: Card)}
	{#if card}
		<div class="actions">
			<form method="post" action={card.enabled ? '?/disable' : '?/enable'} use:enhance>
				<input type="hidden" name="kind" value={kind} />
				<button>{card.enabled ? 'Disable' : 'Enable'}</button>
			</form>

			<form method="post" action="?/test" use:enhance>
				<input type="hidden" name="kind" value={kind} />
				<button>Send test</button>
			</form>

			<form method="post" action="?/remove" use:enhance>
				<input type="hidden" name="kind" value={kind} />
				<button>Remove</button>
			</form>
		</div>
		{#if form?.testKind === kind && form?.testMessage}
			<p role="alert">{form.testMessage}</p>
		{:else if form?.tested === kind}
			<p role="status">Test alert sent.</p>
		{/if}
	{:else if form?.removed === kind}
		<p role="status">Channel removed.</p>
	{/if}
{/snippet}

<svelte:head>
	<title>Alerts · Amazon price check</title>
</svelte:head>

<main>
	<h1>Alerts</h1>

	<p>
		Choose where price drops and failed checks are sent. Each channel can get either kind of alert,
		or both, and can be switched off without losing its settings.
	</p>

	<section class="channel" aria-labelledby="ntfy-heading" data-testid="channel-ntfy">
		<h2 id="ntfy-heading">ntfy</h2>
		<p>
			Alerts go to an <a href="https://ntfy.sh" rel="noreferrer noopener" target="_blank">ntfy</a>
			topic. Install the ntfy app, subscribe to a topic with a hard-to-guess name, and paste its link
			here. Anyone who knows the link can read it, so keep it private.
		</p>

		<p data-testid="current-topic">
			{#if topic}
				Alerts go to <code>{topic}</code>
			{:else if ntfy?.unreadable}
				The saved settings could not be read: save the topic link again.
			{:else}
				No topic saved: you will not get alerts here.
			{/if}
		</p>

		{#if ntfy}
			{@render channelState(ntfy)}
		{/if}

		<!-- defaultValue, not value: hydration must not wipe what was typed before it finished -->
		<form method="post" action="?/save" use:enhance>
			<input type="hidden" name="kind" value="ntfy" />
			<label>
				ntfy topic link
				<input
					name="topic"
					type="text"
					inputmode="url"
					autocomplete="off"
					placeholder="https://ntfy.sh/your-topic"
					required
					defaultValue={topic ?? ''}
				/>
			</label>
			<label>
				Access token (only for a private ntfy server)
				<input
					name="token"
					type="password"
					autocomplete="off"
					placeholder={ntfy?.tokenSet ? 'Set — leave empty to keep it' : 'tk_…'}
				/>
			</label>
			<p data-testid="token-state">
				{ntfy?.tokenSet ? 'Access token: set.' : 'Access token: none.'}
			</p>
			{@render sendMe(ntfyTicks)}
			{@render saveMessage('ntfy')}
			<button>Save topic</button>
		</form>

		{@render channelActions('ntfy', ntfy)}
	</section>

	<section class="channel" aria-labelledby="resend-heading" data-testid="channel-resend">
		<h2 id="resend-heading">Email (Resend)</h2>
		<p>
			Alerts are emailed through your own
			<a href="https://resend.com" rel="noreferrer noopener" target="_blank">Resend</a> account. Create
			an API key that can send emails, and send from an address on a domain you have verified in Resend.
		</p>

		<p data-testid="current-email">
			{#if sender && recipient}
				Alerts are emailed from <code>{sender}</code> to <code>{recipient}</code>
			{:else if resend?.unreadable}
				The saved settings could not be read: enter the API key and addresses again.
			{:else}
				No email settings saved: you will not get alerts here.
			{/if}
		</p>

		{#if resend}
			{@render channelState(resend)}
		{/if}

		<form method="post" action="?/save" use:enhance>
			<input type="hidden" name="kind" value="resend" />
			<label>
				Resend API key
				<input
					name="api_key"
					type="password"
					autocomplete="off"
					placeholder={resend?.keySet ? 'Set — leave empty to keep it' : 're_…'}
				/>
			</label>
			<p data-testid="key-state">
				{resend?.keySet ? 'API key: set.' : 'API key: none.'}
			</p>
			<label>
				Sender address
				<input
					name="from"
					type="email"
					autocomplete="off"
					placeholder="alerts@your-domain.com"
					required
					defaultValue={sender ?? ''}
				/>
			</label>
			<label>
				Recipient address
				<input
					name="to"
					type="email"
					autocomplete="email"
					required
					defaultValue={recipient ?? ''}
				/>
			</label>
			{@render sendMe(resendTicks)}
			{@render saveMessage('resend')}
			<button>Save email settings</button>
		</form>

		{@render channelActions('resend', resend)}
	</section>

	<section class="channel" aria-labelledby="smtp-heading" data-testid="channel-smtp">
		<h2 id="smtp-heading">Email (SMTP)</h2>
		<p>
			Alerts are emailed through your own mail server or provider, such as Gmail. The connection is
			always encrypted: port 465 uses TLS from the start, any other port must offer STARTTLS. For
			Gmail use smtp.gmail.com, port 587 and an app password.
		</p>

		<p data-testid="current-smtp">
			{#if smtpHost && smtpSender && smtpRecipient}
				Alerts are emailed through <code>{smtpHost}</code> from <code>{smtpSender}</code> to
				<code>{smtpRecipient}</code>
			{:else if smtp?.unreadable}
				The saved settings could not be read: enter the server details and password again.
			{:else}
				No SMTP settings saved: you will not get alerts here.
			{/if}
		</p>

		{#if smtp}
			{@render channelState(smtp)}
		{/if}

		<form method="post" action="?/save" use:enhance>
			<input type="hidden" name="kind" value="smtp" />
			<label>
				SMTP server host
				<input
					name="host"
					type="text"
					autocomplete="off"
					placeholder="smtp.gmail.com"
					required
					defaultValue={smtpHost ?? ''}
				/>
			</label>
			<label>
				Port
				<input
					name="port"
					type="text"
					inputmode="numeric"
					autocomplete="off"
					required
					defaultValue={smtpPort}
				/>
			</label>
			<label>
				Username
				<input
					name="username"
					type="text"
					autocomplete="off"
					required
					defaultValue={smtpUsername ?? ''}
				/>
			</label>
			<label>
				Password
				<input
					name="password"
					type="password"
					autocomplete="off"
					placeholder={smtp?.passwordSet ? 'Set — leave empty to keep it' : 'App password'}
				/>
			</label>
			<p data-testid="password-state">
				{smtp?.passwordSet ? 'Password: set.' : 'Password: none.'}
			</p>
			<label>
				Sender address
				<input
					name="from"
					type="email"
					autocomplete="off"
					placeholder="alerts@your-domain.com"
					required
					defaultValue={smtpSender ?? ''}
				/>
			</label>
			<label>
				Recipient address
				<input
					name="to"
					type="email"
					autocomplete="email"
					required
					defaultValue={smtpRecipient ?? ''}
				/>
			</label>
			{@render sendMe(smtpTicks)}
			{@render saveMessage('smtp')}
			<button>Save SMTP settings</button>
		</form>

		{@render channelActions('smtp', smtp)}
	</section>
</main>

<style>
	.channel {
		display: grid;
		gap: var(--space-3);
		min-inline-size: 0;
	}

	.channel code {
		overflow-wrap: anywhere;
	}

	fieldset {
		border: var(--border-width) solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		margin-block: var(--space-3);
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}

	.check {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
