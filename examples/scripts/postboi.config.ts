import { config } from "postboi"

// Runs on the Postboi provider by default (a POSTBOI_TOKEN in .env is all it needs). Swap
// `provider` for any of https://docs.postboi.email/providers and set that provider's API key
// in .env instead.
export default config({
	provider: "postboi",
	default: {
		from: "Acme <hello@acme.example>",
	},
})
