import { createServer } from "node:http"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process, { cwd, pid } from "node:process"
import { INBOX_DISCOVERY, INBOX_PATH } from "../library/inbox.js"
import { create_inbox_store, inbox_middleware } from "../library/inbox_server.js"
import type { CapturedMessage } from "../library/inbox_server.js"

/**
 * `postboi dev` — the dev inbox as a standalone server.
 *
 * The `postboi/vite` plugin already serves this inside the dev server for anything built on
 * Vite (SvelteKit, Astro, Nuxt, Remix), and that's the better experience: no second command,
 * no second port. This is for everything else — Express, Hono, Next.js, bare `wrangler dev`
 * — where there's no Vite to hang it off.
 */

/** Where the inbox listens by default. Shared with maildev/MailCatcher, and rarely taken. */
const DEFAULT_PORT = 1080

/** Listen, stepping up a port at a time when one's already taken. */
function listen(
	server: ReturnType<typeof createServer>,
	port: number,
	attempts = 10
): Promise<number> {
	return new Promise((resolve, reject) => {
		const on_error = (error: NodeJS.ErrnoException) => {
			if (error.code !== "EADDRINUSE" || attempts <= 0) return reject(error)
			server.removeListener("error", on_error)
			listen(server, port + 1, attempts - 1).then(resolve, reject)
		}
		server.once("error", on_error)
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", on_error)
			resolve(port)
		})
	})
}

/** A moment ahead of now, so a scheduled demo send is still scheduled when you look at it. */
const LATER = new Date(Date.now() + 6 * 60 * 60 * 1000)

/** The send the seeding cancels afterwards, so the Deleted folder has something in it. */
const DEMO_CANCELLED = "demo-cancelled"

/**
 * Sample captures for `--demo`: one of each shape the inbox renders differently, across
 * every channel — the mail shapes (styled HTML, a FormData table with attachments, a body
 * with no HTML part), a text thread, a WhatsApp template, one window per chat platform,
 * and the notification shade. Oldest first: the list shows the last one added at the top.
 */
function demo_messages(): Array<CapturedMessage> {
	return [
		{
			to: [{ address: "ada@example.com", name: "Ada Lovelace" }],
			from: { address: "no-reply@acme.example", name: "Acme" },
			reply_to: [{ address: "support@acme.example" }],
			subject: "Your sign-in link",
			html: `<div style="font-family:system-ui;padding:24px;max-width:520px">
	<h1 style="font-size:20px">Welcome back</h1>
	<p>Click below to sign in. This link expires in 15 minutes.</p>
	<p><a href="https://acme.example/magic" style="background:#FDC005;color:#000;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Sign in</a></p>
	<p style="color:#666;font-size:13px">If you didn't request this, ignore it.</p>
</div>`,
			text: "Welcome back. Sign in: https://acme.example/magic",
			attachments: [],
		},
		{
			to: [{ address: "team@acme.example" }],
			cc: [{ address: "sales@acme.example" }],
			from: { address: "forms@acme.example" },
			subject: "New contact form submission",
			html: `<table border="1" cellpadding="8" style="border-collapse:collapse;font-family:system-ui">
	<tr><th align="left">Name</th><td>Grace Hopper</td></tr>
	<tr><th align="left">Email</th><td>grace@navy.example</td></tr>
	<tr><th align="left">Message</th><td>Found a bug in your compiler.</td></tr>
</table>`,
			attachments: [
				{
					name: "logbook.txt",
					mime_type: "text/plain",
					content: Buffer.from("moth found in relay 70, panel F\n").toString("base64"),
				},
			],
		},
		{
			to: [{ address: "ada@example.com" }],
			from: { address: "billing@acme.example" },
			subject: "Receipt for order #1042",
			text: "Thanks for your order.\n\nOrder #1042: £29.00\nVAT included.",
			attachments: [],
		},
		{
			to: [{ address: "ada@example.com" }],
			from: { address: "news@acme.example" },
			subject: "Our July newsletter",
			text: "Everything we shipped last month.",
			scheduled_at: LATER,
			// Cancelled once the store has it, so the Deleted folder isn't empty either.
			send_id: DEMO_CANCELLED,
		},
		{
			channel: "sms",
			to: [{ address: "+447700900123" }],
			from: { address: "ACME" },
			text: "Your Acme code is 448291. It expires in 10 minutes.",
			meta: [["Segments", "1 × GSM-7 (49 units)"]],
		},
		{
			channel: "sms",
			to: [{ address: "+447700900123" }],
			from: { address: "ACME" },
			text: "Order #1042 is out for delivery, arriving today between 14:00 and 16:00.",
			meta: [["Segments", "1 × GSM-7 (79 units)"]],
		},
		{
			channel: "sms",
			to: [{ address: "+447700900123" }],
			from: { address: "ACME" },
			text: "Rate your delivery: https://acme.example/r/1042",
			meta: [["Segments", "1 × GSM-7 (48 units)"]],
			scheduled_at: LATER,
		},
		{
			channel: "whatsapp",
			to: [{ address: "+447700900123" }],
			from: { address: "+15550100000" },
			subject: "Template: order_shipped",
			template: "order_shipped",
			text: "Hi Ada, order #1042 shipped. Track it any time.",
			meta: [
				["Language", "en_GB"],
				["Variables", JSON.stringify({ name: "Ada", order: "1042" })],
				["Buttons", JSON.stringify(["Track order", "Contact support"])],
			],
		},
		{
			channel: "whatsapp",
			to: [{ address: "+447700900123" }],
			from: { address: "+15550100000" },
			text: "Delivered. Reply STOP to opt out of updates.",
			meta: [],
		},
		{
			channel: "chat",
			provider: "slack",
			to: [{ address: "https://hooks.slack.com/services/T000/B000/xxx" }],
			subject: "Deploy started",
			text: "acme-web → production · commit 9c20658 by @ada",
			meta: [["Posts as", "deploybot"]],
		},
		{
			channel: "chat",
			provider: "slack",
			to: [{ address: "https://hooks.slack.com/services/T000/B000/xxx" }],
			subject: "Deploy finished",
			text: "acme-web → production in 42s. All checks green.",
			meta: [["Posts as", "deploybot"]],
		},
		{
			channel: "chat",
			provider: "discord",
			to: [{ address: "https://discord.com/api/webhooks/000/xxx" }],
			subject: "New signup",
			text: "grace@navy.example joined on the Pro plan. That's 12 today.",
			meta: [["Posts as", "acme-bot"]],
		},
		{
			channel: "chat",
			provider: "teams",
			to: [{ address: "https://acme.webhook.office.com/webhookb2/000/xxx" }],
			subject: "Nightly backup",
			text: "Snapshot completed: 4.2 GB in 38s.",
			meta: [],
		},
		{
			channel: "chat",
			provider: "telegram",
			to: [{ address: "@acme_dev_channel" }],
			text: "Error budget at 82%. Three 500s on /checkout in the last hour.",
			meta: [],
		},
		{
			channel: "chat",
			provider: "bluesky",
			to: [{ address: "acme.bsky.social" }],
			text: "Postboi 0.26 is out: push notifications, straight to Apple and Huawei.",
			meta: [],
		},
		{
			channel: "push",
			to: [{ address: "ada-iphone-token" }],
			subject: "Order shipped",
			text: "Order #1042 is on its way.",
			meta: [
				["Opens", "https://acme.example/orders/1042"],
				["Data", JSON.stringify({ order: "1042", type: "shipping" })],
			],
		},
		{
			channel: "push",
			to: [{ address: "ada-iphone-token" }],
			subject: "Grace replied",
			text: "“Found a bug in your compiler.”",
			meta: [],
		},
	]
}

/**
 * Start the inbox and advertise its port, so a `mail()` in another process finds it with
 * nothing configured. Runs until interrupted.
 */
export async function dev_command(args: Array<string>): Promise<void> {
	const flag = args.indexOf("--port")
	const requested = flag === -1 ? DEFAULT_PORT : Number(args[flag + 1])
	if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
		throw new Error(`Invalid --port "${args[flag + 1]}".`)
	}

	const store = create_inbox_store()
	// Sample captures, so the inbox has something in it without an app wired up — and so a
	// restart (`bun --watch`, editing the UI) doesn't leave you staring at an empty mailbox.
	if (args.includes("--demo")) {
		for (const message of demo_messages()) store.add(message)
		store.cancel(DEMO_CANCELLED)
	}
	// Sound stays toggleable in the UI; these only set what the page starts with.
	const middleware = inbox_middleware(store, INBOX_PATH, {
		sounds: !args.includes("--no-sound") && !args.includes("--no-sounds"),
		intro: !args.includes("--no-intro"),
	})
	const server = createServer((request, response) => {
		middleware(request, response, () => {
			response.statusCode = 404
			response.end("Not found")
		})
	})

	const port = await listen(server, requested)
	const file = join(cwd(), INBOX_DISCOVERY)
	try {
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, JSON.stringify({ port, pid }))
	} catch {
		// No node_modules yet, or a read-only checkout. The inbox still works — it just has to
		// be pointed at by hand, which the notice below covers.
	}

	const cleanup = () => {
		try {
			rmSync(file, { force: true })
		} catch {
			// A leftover file costs one failed POST, which falls back to printing the mail.
		}
	}
	process.once("exit", cleanup)
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			cleanup()
			server.close(() => process.exit(0))
		})
	}

	const url = `http://localhost:${port}${INBOX_PATH}`
	console.log(`\n  Postboi dev inbox: ${url}`)
	console.log(`  Mail from this project is captured here instead of being sent.`)
	console.log(`  In another runtime or directory, set POSTBOI_INBOX=${port}.\n`)
	console.log(`  Press Ctrl+C to stop.`)
}
