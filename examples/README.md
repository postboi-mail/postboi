# Postboi examples

Runnable examples for [Postboi](https://github.com/darbymanning/postboi).

The framework apps all do the same thing — a `multipart/form-data` contact form whose
submission becomes a tidy HTML email, with a hidden `_reply_to` field bound to the sender's
email so hitting **Reply** goes straight back to the person who filled it in. They're named
`<framework>-provider-<provider>` so each framework can have one per provider.

## Framework apps

- [`sveltekit-provider-postboi`](./sveltekit-provider-postboi) — SvelteKit on Postboi Cloud.
  Shows both the one-line `postboi/kit` action and a hand-built top-level `mail()` call, plus
  the typed `from` that Cloud enables.
- [`sveltekit-provider-resend`](./sveltekit-provider-resend) — the same app on Resend (plain
  API key). Same code, different provider.

## Scripts

- [`scripts`](./scripts) — plain Bun/Node scripts, no framework: [bulk sending](./scripts/bulk.ts)
  and [scheduling](./scripts/scheduling.ts).

More coming (Next.js, Remix, Astro, …). PRs welcome.
