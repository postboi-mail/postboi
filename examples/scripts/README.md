# Postboi scripts

Plain Bun/Node scripts — no framework, no form. Just call `mail()` from your backend.

- [`transactional.ts`](./transactional.ts) — the simplest send: one `mail({ to, subject, body })`
  (a welcome email, a receipt, a reset link).
- [`bulk.ts`](./bulk.ts) — send an array of messages with bounded concurrency
  ([Bulk sending](https://docs.postboi.email/bulk)).
- [`scheduling.ts`](./scheduling.ts) — send later with `scheduled_at`
  ([Scheduling](https://docs.postboi.email/scheduling)).

## Run

```bash
bunx postboi init   # or: cp .env.example .env and fill in POSTBOI_TOKEN
bun install
bun run transactional
bun run bulk
bun run schedule
```

Both use the top-level `mail()`, which picks up the provider from
[`postboi.config.ts`](./postboi.config.ts) — Postboi Cloud by default. Swap `provider`
there for any of the [supported providers](https://docs.postboi.email/providers) and set that
provider's API key in `.env` instead.

> Scheduling only takes effect on providers that support it (Postboi Cloud, Resend, Brevo,
> Mailgun, SendGrid). On the others, `scheduled_at` is ignored and the message sends
> immediately.
