import { config, SkipSendError } from "postboi"

const unsubscribed = new Set(["grace@example.com"])

export default config({
	provider: "postboi",

	default: {
		from: "Acme <hello@acme.example>",
	},

	hooks: {
		before: {
			send({ message }) {
				if (unsubscribed.has(String(message.to)))
					throw new SkipSendError(`unsubscribed: ${message.to}`)
			},
		},
	},
})
