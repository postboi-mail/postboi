<script lang="ts">
	import { enhance } from "$app/forms"

	let { form } = $props()

	// Bound to the email field below and mirrored into the hidden `_reply_to` field,
	// so replying to the notification goes straight back to the sender.
	let email = $state("")
</script>

<main>
	<h1>Contact us</h1>

	<form method="POST" use:enhance enctype="multipart/form-data">
		<input type="hidden" name="_subject" value="Contact Form" />
		<input type="hidden" name="_reply_to" value={email} />

		<label>
			Name
			<input name="contact→name" placeholder="Ada Lovelace" required />
		</label>

		<label>
			Email
			<input
				name="contact→email"
				type="email"
				placeholder="ada@example.com"
				required
				bind:value={email}
			/>
		</label>

		<label>
			Message
			<textarea name="details→message" placeholder="Say hello…"></textarea>
		</label>

		<label>
			Attachments
			<input type="file" name="details→attachments" multiple />
		</label>

		<button type="submit">Send</button>
	</form>

	{#if form?.success}
		<p role="status">Thanks — your message is on its way.</p>
	{:else if form?.error}
		<p role="alert">{form.error}</p>
	{/if}

	<p>Or see the <a href="/welcome">top-level <code>mail()</code> example</a>.</p>
</main>

<style>
	main {
		max-width: 32rem;
		margin: 4rem auto;
		padding: 0 1rem;
		font-family: system-ui, sans-serif;
	}

	form {
		display: grid;
		gap: 1rem;
	}

	label {
		display: grid;
		gap: 0.25rem;
	}

	input,
	textarea {
		padding: 0.5rem;
		font: inherit;
	}

	button {
		justify-self: start;
		padding: 0.5rem 1rem;
		font: inherit;
		cursor: pointer;
	}
</style>
