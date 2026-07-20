import { sveltekit } from "@sveltejs/kit/vite"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [sveltekit()],
	// postboi/remote is a SvelteKit remote-functions module — it must reach the
	// SvelteKit transform, not Vite's dependency prebundle (which empties it).
	optimizeDeps: { exclude: ["postboi/remote"] },
})
