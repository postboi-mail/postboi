import { mail } from "postboi"

// Bulk send: pass an array and each message becomes its own request, sent with bounded
// concurrency. The call never throws — you get one result per message, in order.
const results = await mail([
	{ to: "ada@example.com", subject: "Hello Ada", body: "<p>Hi Ada</p>" },
	{ to: "linus@example.com", subject: "Hello Linus", body: "<p>Hi Linus</p>" },
])

const sent = results.filter((r) => r.ok).length
console.log(`${sent}/${results.length} sent`)

for (const r of results) {
	if (r.ok) console.log(`  ✓ [${r.index}]`, r.response)
	else console.error(`  ✗ [${r.index}] ${r.error.message}`)
}

// Sending the *same* message to many people? Pass one `to` array plus per-recipient `data`
// and let `{name}` placeholders fill in — see https://docs.postboi.email/bulk#personalized-batches.
