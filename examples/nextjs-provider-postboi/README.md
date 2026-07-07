# Next.js × Postboi

A contact form that turns a submission into a tidy HTML email via [postboi](https://docs.postboi.email), running on the Postboi provider. The form carries a hidden `_reply_to` field mirrored from the submitted email, so replying to the notification reaches the person who filled it in.

## Set up

1. Get a token and write it to `.env`:

   ```sh
   bunx postboi init
   ```

   This writes `POSTBOI_TOKEN` for you.

2. Install dependencies:

   ```sh
   npm install
   # or: bun install
   ```

3. Run the dev server:

   ```sh
   npm run dev
   ```

Open http://localhost:3000.

## How it works

- **`app/page.tsx`** — the contact form (a client component). Hidden `_subject` and `_reply_to` fields ride along; `_reply_to` mirrors the email via `useState`. Fields named `group→field` (e.g. `contact→name`) become grouped sections in the rendered HTML email.
- **`app/actions.ts`** — a `"use server"` Server Action that just hands the whole `FormData` to `mail({ body })`.
- **`postboi.config.ts`** — selects the provider (`postboi`, i.e. the Postboi provider) and the default recipient the contact-form notification lands at.

Learn more in the [postboi docs](https://docs.postboi.email) or grab a token at [postboi.email](https://postboi.email).
