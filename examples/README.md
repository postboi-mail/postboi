# Postboi examples

Runnable starter apps showing how to wire a contact form to
[Postboi](https://github.com/darbymanning/postboi).

Every example does the same thing: a `multipart/form-data` contact form whose submission
becomes a tidy HTML email, with a hidden `_reply_to` field bound to the sender's email so
hitting **Reply** goes straight back to the person who filled it in.

Examples are named `<framework>-provider-<provider>` so each framework can have one per
provider.

## Examples

- [`sveltekit-provider-postboi`](./sveltekit-provider-postboi) — SvelteKit on Postboi Cloud.
  Shows both the one-line `postboi/kit` action and a hand-built top-level `mail()` call, plus
  the typed `from` that Cloud enables.

More coming (Next.js, Remix, Astro, …) and other providers (e.g. `sveltekit-provider-resend`
for a plain API-key setup). PRs welcome.
