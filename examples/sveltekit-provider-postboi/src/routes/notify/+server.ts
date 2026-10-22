import { sms, whatsapp, slack } from "postboi"

// The other channels, from a SvelteKit endpoint. The calls are identical in every
// framework — what's SvelteKit about this file is only that it's a +server.ts.
//
//   curl -X POST localhost:5173/notify -H 'content-type: application/json' \
//     -d '{"channel":"sms","to":"+447700900123","message":"Your code is 428 916"}'
//
// In development SMS and WhatsApp are logged, not sent — POSTBOI_SMS_DEV=send /
// POSTBOI_WHATSAPP_DEV=send for real delivery, `bunx postboi init --sms` (etc.) for
// providers. Chat needs one env var: SLACK_WEBHOOK_URL.
//
// To reach someone on several channels at once — or walk a cheapest-first fallback
// chain — that's one `send()` call: https://docs.postboi.app/send
export async function POST({ request }) {
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
