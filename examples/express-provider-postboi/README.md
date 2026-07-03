# Express × Postboi Cloud

A contact form that turns submissions into a tidy HTML email via [postboi](https://docs.postboi.email) on [Postboi Cloud](https://postboi.email). A hidden `_reply_to` field — mirrored from the submitted email address with a one-line `oninput` handler — means replies land straight in the sender's inbox. The wrinkle: Express doesn't expose a Web `FormData`, so this example parses the multipart body with `multer` and rebuilds a `FormData` to hand to `mail({ body })`.

## Set up

1. `bunx postboi init` — writes your `POSTBOI_TOKEN` into `.env`.
2. `npm install`
3. `npm run dev`

Then open http://localhost:3000.

## How it works

- **`src/server.js`** — `GET /` renders the form with hidden `_subject` and `_reply_to` fields. `POST /contact` uses `multer().none()` to parse the multipart text fields, rebuilds a Web `FormData` from `req.body`, and calls `mail({ body })`.
- **`postboi.config.js`** — sets the provider and the default recipient for contact-form notifications.
