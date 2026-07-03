# Postboi examples

Runnable starter apps showing how to wire a contact form to
[Postboi](https://github.com/darbymanning/postboi).

Every example does the same thing: a `multipart/form-data` contact form whose submission
becomes a tidy HTML email, with a hidden `_reply_to` field bound to the sender's email so
hitting **Reply** goes straight back to the person who filled it in.

## Frameworks

- [`sveltekit`](./sveltekit) — SvelteKit form action via `postboi/kit`, running on Postboi
  Cloud so it can also demo the typed `from`.

More coming (Next.js, Remix, Astro, …), plus provider-specific variants (e.g. a plain
API-key Resend setup). PRs welcome.
