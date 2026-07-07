# Postboi examples

Runnable examples for [Postboi](https://github.com/darbymanning/postboi).

The framework apps all do the same thing — a `multipart/form-data` contact form whose
submission becomes a tidy HTML email, with reply-to set to the sender's email so hitting
**Reply** goes straight back to the person who filled it in. They're named
`<framework>-provider-<provider>` so each framework can have one per provider.

Every one is the same handful of lines: read the request's `FormData`, and pass it to the
top-level `mail()`. The provider lives entirely in `postboi.config.ts`.

## SvelteKit

- [`sveltekit-provider-postboi`](./sveltekit-provider-postboi) — SvelteKit on the Postboi provider.
  Shows both the one-line `postboi/kit` action and a hand-built top-level `mail()` call, plus
  the typed `from` that Postboi enables.
- [`sveltekit-provider-custom`](./sveltekit-provider-custom) — the same app on any
  bring-your-own provider (Resend, Postmark, SendGrid, Mailgun, SES, SMTP, …). Shows that
  `postboi.config.ts` is the only file that changes between providers.

## Other frameworks

All on the Postboi provider, each using its framework's server handler to call `mail({ body })`:

- [`nextjs-provider-postboi`](./nextjs-provider-postboi) — Next.js App Router, via a Server Action.
- [`astro-provider-postboi`](./astro-provider-postboi) — Astro, via an API route.
- [`nuxt-provider-postboi`](./nuxt-provider-postboi) — Nuxt (Vue), via a Nitro server route.
- [`remix-provider-postboi`](./remix-provider-postboi) — Remix, via a route `action`.
- [`hono-provider-postboi`](./hono-provider-postboi) — Hono on Bun (framework-agnostic,
  Web-standard `Request`/`FormData`).
- [`express-provider-postboi`](./express-provider-postboi) — Express (plain JS). Shows the
  one place the pattern differs: parse multipart with `multer`, then rebuild a `FormData`.
- [`cloudflare-workers-provider-postboi`](./cloudflare-workers-provider-postboi) — a Worker.
  No filesystem or ambient env, so the token comes from the `env` binding: `new Postboi({ token })`.

## Scripts

- [`scripts`](./scripts) — plain Bun/Node scripts, no framework:
  [transactional](./scripts/transactional.ts), [bulk sending](./scripts/bulk.ts), and
  [scheduling](./scripts/scheduling.ts).

Want another framework or provider? PRs welcome.
