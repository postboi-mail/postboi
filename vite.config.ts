import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vitest/config"
import { sveltekit } from "@sveltejs/kit/vite"

// SvelteKit config (preprocess, adapter, aliases) lives in svelte.config.js.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	optimizeDeps: {
		exclude: ["@rollup/browser"],
	},
	worker: {
		format: "es",
	},
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
