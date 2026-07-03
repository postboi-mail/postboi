# Postboi scripts

Plain Bun/Node scripts for two library features from the docs — no framework involved.

- [`bulk.ts`](./bulk.ts) — send an array of messages with bounded concurrency
  ([Bulk sending](https://postboi.dev/bulk)).
- [`scheduling.ts`](./scheduling.ts) — send later with `scheduled_at`
  ([Scheduling](https://postboi.dev/scheduling)).

## Run

```bash
bunx postboi init   # or: cp .env.example .env and fill in POSTBOI_TOKEN
bun install
bun run bulk
bun run schedule
```

Both use the top-level `mail()`, which picks up the provider from
[`postboi.config.ts`](./postboi.config.ts) — Postboi Cloud by default. Swap `provider`
there for any of the [supported providers](https://postboi.dev/providers) and set that
provider's API key in `.env` instead.

> Scheduling only takes effect on providers that support it (Postboi Cloud, Resend, Brevo,
> Mailgun, SendGrid). On the others, `scheduled_at` is ignored and the message sends
> immediately.
