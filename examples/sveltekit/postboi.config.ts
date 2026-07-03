import { config } from "postboi"

// Committed, non-secret config. The only secret — your provider's API key — lives in .env.
// Swap `provider` for any of the supported providers: https://postboi.dev/providers
export default config({
	provider: "resend",
	default: {
		from: "Acme <no-reply@example.com>",
		to: "team@example.com",
	},
})
