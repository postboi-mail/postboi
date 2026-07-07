import { config } from "postboi"

// the Postboi provider — the zero-config provider. `bunx postboi init` authenticates, writes your
// POSTBOI_TOKEN to .env, and generates the typed `from` (see the README). Nothing here is
// secret, so it's committed.
export default config({
	provider: "postboi",
	default: {
		// After `bunx postboi sync`, `from` is narrowed to your verified Postboi domains — a
		// domain you don't own won't typecheck. See "Typed from" in the README.
		from: "Acme <hello@acme.example>",
		to: "team@acme.example",
	},
})
