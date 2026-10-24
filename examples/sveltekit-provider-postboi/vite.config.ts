import adapter from "@sveltejs/adapter-auto"
import { sveltekit } from "@sveltejs/kit/vite"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		sveltekit({
			preprocess: vitePreprocess(),
			adapter: adapter(),
			// For the /remote page — SvelteKit remote functions are still experimental.
			experimental: { remoteFunctions: true },
		}),
	],
	// postboi/remote is a SvelteKit remote-functions module — it must reach the
	// SvelteKit transform, not Vite's dependency prebundle (which empties it).
	optimizeDeps: { exclude: ["postboi/remote"] },
})
