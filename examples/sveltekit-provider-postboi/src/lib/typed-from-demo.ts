import { mail } from "postboi"

/**
 * Compile-time proof that `from` is typed — this function is never called, it only has to
 * typecheck. On Postboi Cloud, `from` is narrowed to your verified sending domains (see
 * postboi-cloud.d.ts, which `bunx postboi sync` generates for real inside node_modules).
 */
export async function demo_typed_from() {
	// ✅ one of your Cloud domains — compiles.
	await mail({
		from: "Acme <hello@acme.example>",
		to: "you@example.com",
		subject: "Hello",
		body: "<p>Hello world</p>",
	})

	await mail({
		// @ts-expect-error — not one of your verified Cloud domains, so it won't compile.
		from: "hello@totally-not-your-domain.example",
		to: "you@example.com",
		subject: "Hello",
		body: "<p>Hello world</p>",
	})
}
