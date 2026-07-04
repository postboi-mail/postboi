import { config } from "postboi"

// Postboi Cloud — a POSTBOI_TOKEN in .env is all it needs. Swap `provider` for any of
// https://docs.postboi.email/providers to use a different one.
export default config({
	provider: "postboi",
	default: {
		// Where contact-form notifications land.
		to: "team@acme.example",
	},
})
