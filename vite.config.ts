import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vitest/config"
import { sveltekit } from "@sveltejs/kit/vite"
import adapter from "@sveltejs/adapter-auto"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			preprocess: vitePreprocess(),
			adapter: adapter(),
			alias: {
				$components: "src/components",
				$library: "src/library",
			},
		}),
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: "./vite.config.ts",
				test: {
					name: "server",
					environment: "node",
					include: ["src/**/*.{test,spec}.{js,ts}"],
					exclude: ["src/**/*.svelte.{test,spec}.{js,ts}"],
				},
			},
		],
	},
})
