// ── Demo shim — not something you'd normally write ────────────────────────────────────
// On Postboi Cloud, `bunx postboi sync` generates this exact augmentation *inside*
// node_modules/postboi from your account's verified domains — you don't commit it. It's
// committed here so the example (and the `@ts-expect-error` in typed-from-demo.ts) typecheck
// without a real Cloud account. After running `bunx postboi init` in a real project, delete
// this file so it doesn't clash with the generated types.
//
// `Register["from"]` narrows `FromAddress`, which types every `from` — the config default,
// the `postboi/kit` action, and top-level `mail()` calls.
declare module "postboi" {
	interface Register {
		from:
			| "Acme <hello@acme.example>"
			| `${string}@acme.example`
			| `${string}@acme.example>`
	}
}

export {}
