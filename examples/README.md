# Postboi examples

Runnable examples for [Postboi](https://github.com/postboi-mail/postboi).

The framework apps all start from the same thing — a `multipart/form-data` contact form
whose submission becomes a tidy HTML email, with reply-to set to the sender's email so
hitting **Reply** goes straight back to the person who filled it in. They're named
`<framework>-provider-<provider>` so each framework can have one per provider.

Every one is the same handful of lines: read the request's `FormData`, and pass it to the
top-level `mail()`. The provider lives entirely in `postboi.config.ts`.

Since postboi went multi-channel, each app also carries the rest, in its framework's own
idiom — deliberately WET, so "postboi in `<framework>`" is one folder, complete:

- **`POST /webhooks`** — provider delivery events, signature-verified and normalized.
  Since 0.29.0 the endpoint is `webhook()` from `postboi/webhooks` — the same one-liner
  in every web-standard framework — and `webhook.node()` owns Express's raw-body
  requirement, so the classic body-parser footgun can't be built.
- **`POST /notify`** — `sms()`, `whatsapp()` and `slack()` from one endpoint. The calls
  are identical everywhere; the file shows where they live in each framework.
- **`/push`** (every app with a client build: SvelteKit, Next.js, Astro, Nuxt, Remix) —
  Web Push end to end: `subscribe()` in the browser, the subscription stored, `push()`
  sending to it, and the service worker that shows it. No key plumbing anywhere —
  `bunx postboi init --push` mints the VAPID pair and bakes the public half into the
  package, so nothing carries it to the browser by hand. The server-only apps (Hono,
  Express, Workers) carry the full server surface and point here for the browser half.
  The SvelteKit app shows managed push instead: Postboi keeps the subscriptions, the route
  is one `push.handler` line, `push({ to: { user } })` sends to a person, and a public
  list is followed from the page with no route at all.

Every example is exercised by CI (`bun run ci` in each folder — a typecheck or build),
so none of this rots quietly.

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
  The `POSTBOI_TOKEN` binding is read for you, so `mail({ body })` needs no wiring; the one
  thing a Worker can't do is auto-load `postboi.config.ts` off a filesystem.

## Scripts

- [`scripts`](./scripts) — plain Bun/Node scripts, no framework. Email:
  [transactional](./scripts/transactional.ts), [bulk sending](./scripts/bulk.ts),
  [scheduling](./scripts/scheduling.ts). The other channels:
  [SMS](./scripts/sms.ts), [WhatsApp](./scripts/whatsapp.ts),
  [chat](./scripts/chat.ts), and [`send()` across all of them](./scripts/notify.ts) —
  fan-out and the cheapest-first fallback chain.

Want another framework or provider? PRs welcome.
