// Live check of GitHub workload sign-in against production. Lives on a throwaway branch only.
// SMOKE_EXPECT=ok: the exchange works and the credential does what its scope allows and no more.
// SMOKE_EXPECT=refused: the exchange must be refused and nothing sent.
import { mail } from "../src/library/postboi.js"
import { temp } from "../src/library/temp_inbox.js"
import { mailbox } from "../src/library/mailbox.js"
import { workload_token } from "../src/library/workload_auth.js"

const BASE = "https://postboi.app"
const expect = process.env.SMOKE_EXPECT ?? "ok"
const run = `${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT}`
let failed = false

function check(name: string, ok: boolean, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`)
	if (!ok) failed = true
}

function code_of(error: unknown) {
	const e = error as { code?: string; status?: number; message?: string }
	return `${e.code ?? "?"} ${e.status ?? ""} ${e.message ?? String(error)}`.trim()
}

async function refused(name: string, work: () => Promise<unknown>) {
	try {
		const answer = await work()
		check(name, false, `went through: ${JSON.stringify(answer)}`)
	} catch (error) {
		check(name, true, code_of(error))
	}
}

if (expect === "refused") {
	await refused("exchange refused", () => workload_token(BASE))
	process.exit(failed ? 1 : 0)
}

const grant = await workload_token(BASE).catch((error) => {
	check("exchange", false, code_of(error))
	process.exit(1)
})
const lifetime = Math.round((grant!.expires_at - Date.now()) / 1000)
check("exchange", lifetime > 0 && lifetime <= 3600, `scope=${grant!.mailbox ? "mailbox" : "team"} expires_in~${lifetime}s`)

// Whatever the scope, the credential must not open the team's account API.
const account = await fetch(`${BASE}/v1/account`, {
	headers: { authorization: `Bearer ${grant!.access_token}` },
})
if (grant!.mailbox) check("team API refused", [401, 403].includes(account.status), String(account.status))

const inbox = await temp()
const subject = `Workload smoke ${run}`

if (grant!.mailbox) {
	const box = await mailbox()
	check("mailbox opened", box.id === grant!.mailbox.id, box.address)
	const page = await box.list().then(
		(mail) => ({ ok: true, n: mail.length }),
		(error) => ({ ok: false, n: code_of(error) })
	)
	check("mailbox read", page.ok, `messages=${page.n}`)
	await refused("mailbox credential cannot change review", () => box.set_review(box.review))
	await refused("mailbox credential cannot send through mail()", () =>
		mail({ to: inbox.address, subject, text: "Should not send." })
	)
} else {
	try {
		const sent = await mail({ to: inbox.address, subject, text: "Sent by a GitHub workload." })
		check("send", true, JSON.stringify(sent))
		const got = await inbox.wait({ subject, timeout: 180_000 })
		check("arrived", got.subject === subject, got.from)
	} catch (error) {
		check("send", false, code_of(error))
	}
	const name = process.env.SMOKE_MAILBOX
	if (name) {
		try {
			const box = await mailbox(name)
			const review = box.review
			const result = await box.send({
				to: inbox.address,
				subject: `${subject} (mailbox, new recipient)`,
				text: "A new conversation from the mailbox.",
			})
			check(
				"mailbox review holds a new send",
				review === "none" ? result.status === "sent" : result.status === "draft",
				`review=${review} status=${result.status}`
			)
			// Asks for the setting it already has, so a broken gate changes nothing.
			await refused("workload cannot change review", () => box.set_review(review))
			if (result.status === "draft")
				await refused("workload cannot send its own held draft", () => box.send_draft(result.draft_id))
		} catch (error) {
			check("mailbox checks", false, code_of(error))
		}
	}
}

await inbox.delete()
process.exit(failed ? 1 : 0)
