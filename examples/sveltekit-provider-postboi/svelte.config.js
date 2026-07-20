import adapter from "@sveltejs/adapter-auto"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// For the /remote page — SvelteKit remote functions are still experimental.
		experimental: { remoteFunctions: true },
	},
}

export default config
