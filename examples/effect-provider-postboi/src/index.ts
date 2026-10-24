import { Effect } from "effect"
import { Mailer, with_retry } from "postboi/effect"

export const welcome = Effect.fn("welcome")(function* (to: string) {
	const mailer = yield* Mailer
	yield* with_retry(
		mailer.send({ to, subject: "Welcome to Acme", body: "<p>Glad you're here.</p>" })
	)
	return "sent" as const
})

export const program = Effect.forEach(["ada@example.com", "grace@example.com"], (to) =>
	welcome(to).pipe(
		Effect.catchTag("SkipSend", (skip) => Effect.succeed(skip.message)),
		Effect.catchTag("PostboiError", (error) => Effect.succeed(`failed: ${error.message}`)),
		Effect.tap((outcome) => Effect.log(`${to}: ${outcome}`))
	)
)

if (import.meta.main) await Effect.runPromise(program.pipe(Effect.provide(Mailer.layer)))
