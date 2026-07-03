<script setup lang="ts">
const route = useRoute()
const sent = computed(() => route.query.sent === "1")
</script>

<template>
	<main>
		<h1>Contact us</h1>

		<p v-if="sent" class="thanks">Thanks — your message is on its way.</p>

		<form method="post" action="/api/contact" enctype="multipart/form-data">
			<input name="contact→name" placeholder="Name" required />
			<input name="contact→email" type="email" placeholder="Email" required />
			<textarea name="details→message" placeholder="Message"></textarea>
			<button type="submit">Send</button>
		</form>
	</main>
</template>

<style>
	main {
		max-width: 32rem;
		margin: 4rem auto;
		padding: 0 1rem;
		font-family: system-ui, sans-serif;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	input,
	textarea,
	button {
		font: inherit;
		padding: 0.5rem 0.75rem;
	}

	.thanks {
		color: green;
	}
</style>
