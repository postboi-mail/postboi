import { config } from "postboi"

// Resend. The provider and the from/to defaults are committed here; the only secret — your
// RESEND_API_KEY — lives in .env. Swap `provider` for any of https://postboi.dev/providers.
export default config({
	provider: "resend",
	default: {
		// Must be an address on a domain you've verified in Resend.
		from: "Acme <hello@acme.example>",
		to: "team@acme.example",
	},
})
