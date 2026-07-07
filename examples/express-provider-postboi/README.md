# Express × Postboi

A contact form that turns submissions into a tidy HTML email via [postboi](https://docs.postboi.email) on [the Postboi provider](https://postboi.email). A hidden `_reply_to` field — mirrored from the submitted email address with a one-line `oninput` handler — means replies land straight in the sender's inbox. No extra dependencies: Express's built-in `express.urlencoded()` parses the form onto `req.body`, and `mail({ body })` takes that object directly.

> Because there are no file uploads, a plain (urlencoded) form needs no multipart parser. If you add a file input, switch the form to `enctype="multipart/form-data"` and parse it with [`multer`](https://github.com/expressjs/multer) (or busboy) — `req.body` still flows into `mail({ body })` the same way.

## Set up

1. `bunx postboi init` — writes your `POSTBOI_TOKEN` into `.env`.
2. `npm install`
3. `npm run dev`

Then open http://localhost:3000.

## How it works

- **`src/server.js`** — `express.urlencoded()` parses the submitted fields onto `req.body`. `GET /` renders the form with hidden `_subject` and `_reply_to` fields; `POST /contact` calls `mail({ body })` with `req.body` directly.
- **`postboi.config.js`** — sets the provider and the default recipient for contact-form notifications.
