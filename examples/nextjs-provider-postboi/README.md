# Next.js × Postboi Cloud

A contact form that turns a submission into a tidy HTML email via [postboi](https://docs.postboi.email), running on Postboi Cloud. Reply-to is set from the submitted email in the server action, so replying to the notification reaches the person who filled in the form.

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

- **`app/page.tsx`** — the contact form plus a `"use server"` Server Action that sets `_reply_to` / `_subject` and calls `mail({ body: formData })`. Fields named `group→field` (e.g. `contact→name`) become grouped sections in the rendered HTML email.
- **`postboi.config.ts`** — selects the provider (`postboi`, i.e. Postboi Cloud) and the default recipient the contact-form notification lands at.

Learn more in the [postboi docs](https://docs.postboi.email) or grab a token at [postboi.email](https://postboi.email).
