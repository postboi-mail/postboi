# Cloudflare Workers × Postboi Cloud

A contact form that turns into a tidy HTML email via [postboi](https://docs.postboi.email/) on [Postboi Cloud](https://postboi.email), running on a Cloudflare Worker. A hidden `_reply_to` field — mirrored from the submitted email with a one-line `oninput` — means your replies reach the person who wrote in.

The wrinkle worth noticing: Workers have no filesystem and no ambient env, so there's no `postboi.config.ts` to auto-load. Instead you construct the provider explicitly with the token from the `env` binding — `new Postboi({ token: env.POSTBOI_TOKEN })` — and call `mail.send({ body })`.

## Set up

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and add your `POSTBOI_TOKEN` (or run `bunx postboi init` and move the token into `.dev.vars`). Get a token at https://postboi.email.
3. `npm run dev`
4. Open the URL wrangler prints (usually http://localhost:8787).

For production, set the token as a secret and deploy:

```
npx wrangler secret put POSTBOI_TOKEN
npm run deploy
```

## How it works

- **`src/index.ts`** — the `fetch` handler renders the form and, on POST to `/contact`, builds `new Postboi({ token: env.POSTBOI_TOKEN })`, reads `await request.formData()`, and calls `mail.send({ body })`.
- **`wrangler.jsonc`** — Worker config, with `nodejs_compat` turned on.

Full docs live at https://docs.postboi.email and Postboi Cloud is at https://postboi.email.
