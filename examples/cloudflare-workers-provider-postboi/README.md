# Cloudflare Workers × Postboi

A contact form that turns into a tidy HTML email via [postboi](https://docs.postboi.email/) on [the Postboi provider](https://postboi.email), running on a Cloudflare Worker. A hidden `_reply_to` field — mirrored from the submitted email with a one-line `oninput` — means your replies reach the person who wrote in.

The wrinkle worth noticing: Workers pass config as bindings rather than env vars, but Postboi reads them off `cloudflare:workers`, so `mail({ body })` finds `POSTBOI_TOKEN` with nothing passed in — no `env` threading, no `new Postboi({ token })`.

The one thing a Worker can't do is auto-load a `postboi.config.ts`, since there's no filesystem to find it on. This example doesn't need one (the token is the only setting), but if yours does: build with Vite and add the [`postboi/vite`](https://docs.postboi.email/config#edge-runtimes) plugin, which bundles the file for you. Building with wrangler alone, as here, `import "../postboi.config"` from `src/index.ts` — esbuild inlines it and `config()` registers it as a side effect.

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

- **`src/index.ts`** — the `fetch` handler renders the form and, on POST to `/contact`, calls `mail({ body: request.formData(), to })` (`body` takes the promise directly).
- **`wrangler.jsonc`** — Worker config, with `nodejs_compat` turned on. `POSTBOI_TOKEN` isn't declared here: secrets come from `.dev.vars` locally and `wrangler secret` in production, and Postboi picks the binding up either way.

Full docs live at https://docs.postboi.email and the Postboi provider is at https://postboi.email.
