// Live check of GitHub workload sign-in against production. Lives on a throwaway branch only.
// SMOKE_EXPECT=ok: exchange, send, arrival, and (with SMOKE_MAILBOX) the mailbox review gate.
// SMOKE_EXPECT=refused: the exchange must be refused and nothing sent.
import { mail } from "../src/library/postboi.js"
import { temp } from "../src/library/temp_inbox.js"
import { mailbox } from "../src/library/mailbox.js"

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

const inbox = await temp()
const subject = `Workload smoke ${run}`

if (expect === "refused") {
	try {
		const sent = await mail({ to: inbox.address, subject, text: "This should not have been sent." })
		check("exchange refused", false, `send went through: ${JSON.stringify(sent)}`)
	} catch (error) {
		const code = code_of(error)
		check("exchange refused", /workload_auth_failed|invalid_grant/.test(code), code)
	}
} else {
	try {
		const sent = await mail({ to: inbox.address, subject, text: "Sent by a GitHub workload." })
		check("exchange and send", true, JSON.stringify(sent))
		const got = await inbox.wait({ subject, timeout: 180_000 })
		check("arrived", got.subject === subject, got.from)
	} catch (error) {
		check("exchange and send", false, code_of(error))
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
			try {
				await box.set_review(review)
				check("workload cannot change review", false, "set_review succeeded")
			} catch (error) {
				check("workload cannot change review", true, code_of(error))
			}
			if (result.status === "draft") {
				try {
					await box.send_draft(result.draft_id)
					check("workload cannot send its own held draft", false, "draft sent")
				} catch (error) {
					check("workload cannot send its own held draft", true, code_of(error))
				}
			}
		} catch (error) {
			check("mailbox opened", false, code_of(error))
		}
	}
}

await inbox.delete()
process.exit(failed ? 1 : 0)
