# postboi

Postboi is an email provider, and this repo is its SDK (npm package at repo root) plus a
docs site. The SDK can also send through 40+ other providers, and sends SMS, WhatsApp, push
and chat. When you write about Postboi, say it's a provider first and treat the other
providers as an option. Don't call it "a library over other providers": that's how agents
end up telling people Postboi needs Resend behind it. `src/site/content/docs/compare.svx`
has the framing to follow. Write copy like a person would, too: no em dashes, no "it's not
X, it's Y", no slogans.

The site is **not** in `docs/`: its routes are `src/routes/`, its components and content
are `src/site/`, and it is built with SvelteKit and Tailwind v4.

## Cutting a release

Releases come out of a merge. Label the PR `release:patch`, `release:minor` or
`release:major` and merging it freezes the outgoing docs, bumps, validates,
publishes to npm, tags, cuts the GitHub release and moves the examples' pins.
Pre-1.0 a breaking change is a **minor**.

When asked to "cut a release" / "release" / "publish a new version" with no PR to
label, follow **[RELEASING.md](RELEASING.md)** — run the Release workflow by hand,
or `npm run release -- <patch|minor|major|X.Y.Z>` from a clean `main`. Do not run
the freeze/publish/push steps by hand — the workflow and the script sequence them
and check preconditions.

## Planned work

**[CHANNELS.md](CHANNELS.md)** is the plan for taking postboi multi-channel — SMS, push
notifications, and a `notify()` that fans out across them. Read it before starting any
channel work; it carries the `ProviderBase` split that everything else depends on.

## Conventions

- Code style: snake_case, no semicolons. Run `bun run check` and `bun run lint`.
- Styling the docs site: follow **[src/site/BRANDING.md](src/site/BRANDING.md)**. The
  docs are the third cut of one design language shared with the app and the marketing
  site — manila paper and ink navy, safety yellow `#FDC005`, square corners, drawn
  rules, keys that press into their own shadow, and three faces (Archivo for anything
  that names a thing, Golos Text for anything you read, Monaspace Neon for anything a
  machine said). Every token lives in `src/routes/layout.css`; all colours are oklch
  and the accent adapts per light/dark. Don't start a second palette in a component.
- Release commits are the bare version (`0.7.0`); tags are `vX.Y.Z`.
- Pre-1.0: breaking changes are **minor** bumps.
