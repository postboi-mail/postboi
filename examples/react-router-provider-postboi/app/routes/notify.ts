import { sms, whatsapp, slack } from "postboi"
import type { Route } from "./+types/notify"

// The other channels, from a React Router resource route. The calls are identical in every
// framework — what's React Router about this file is only where it lives.
//
//   curl -X POST localhost:3000/notify -H 'content-type: application/json' \
//     -d '{"channel":"sms","to":"+447700900123","message":"Your code is 428 916"}'
//
// In development SMS and WhatsApp are logged, not sent — POSTBOI_SMS_DEV=send /
// POSTBOI_WHATSAPP_DEV=send for real delivery, `bunx postboi init --sms` (etc.) for
// providers. Chat needs one env var: SLACK_WEBHOOK_URL. For several channels in one
// call — or a cheapest-first fallback chain — see send(): https://docs.postboi.app/send
export async function action({ request }: Route.ActionArgs) {
	const { channel, to, message } = await request.json()

	switch (channel) {
		case "sms":
			return Response.json(await sms({ to, message }))

		case "whatsapp":
			// Free-form text only lands within 24h of the person's last reply — for
			// anytime delivery, name a template: https://docs.postboi.app/whatsapp
			return Response.json(await whatsapp({ to, message }))

		case "chat":
			return Response.json(await slack({ message }))

		default:
			return Response.json({ error: `unknown channel "${channel}"` }, { status: 400 })
	}
}
