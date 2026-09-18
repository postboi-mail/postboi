# Scheduled exports

A scheduled export emails a CSV or spreadsheet of the account's Sent log on a schedule.
It is a **hosted feature** of the Postboi provider — it runs on Postboi's clock, not in the
app, so there is nothing to deploy and no cron job to write. Don't build one: a cron route
that pages `/v1/messages` and mails a file is exactly what this replaces.

Needs a `POSTBOI_TOKEN` in the project (the Postboi provider). A project on Resend, SES or
another provider has no account to export from.

## "Send us a CSV of the enquiries every week" — the recipe

1. **Name the form on the existing send.** An unfiltered export is rows of the Sent log —
   to, subject, status — which is rarely what was asked for. Submissions with a column per
   field only exist once the send that files them names a form. One argument on the call
   that is already there:

   ```ts
   mail({ to, body: request.formData(), form: "Contact" })
   // SvelteKit's bare `{ default: mail }` action names no form — switch it to
   // action({ to: "…", form: "Contact" }) from postboi/kit
   ```

   The form is created on first use, matched case-insensitively. `bunx postboi sync` then
   types the name, so a rename is a build error rather than a silent new form. If the
   project has several sends, ask which one — one question — or name the one that reads
   `request.formData()`.

2. **Create the export**, filtered by that name:

   ```bash
   bunx postboi exports add "Weekly enquiries" --to james@example.com --form Contact --weekly
   ```

   Or from code, the same call the CLI makes:

   ```ts
   await mail.exports.create({
   	name: "Weekly enquiries",
   	recipients: "james@example.com",
   	filter: { form: "Contact" },
   	schedule: { frequency: "weekly", days: [1], send_time: "09:00", timezone: "Europe/London" },
   })
   ```

3. **Prove it**: `bunx postboi exports run <id>` sends one within a minute; `bunx postboi
messages` shows it in the log with its file. Then `bunx postboi exports` lists what is
   scheduled and when it next runs.

## Defaults to state rather than guess

- **`--weekly` is Monday, `--monthly` the 1st, always at 09:00 in `--tz`, which is UTC
  unless given.** Say so in your summary, or ask the user's zone — it is the one thing
  the request usually leaves out. `--day fri` / `--day 1,3` / `--month-day 15` / `--at
17:30` change them; `days` are `0`–`6` with `0` Sunday on the API.
- **Window is `since_last_run`**: each file holds what arrived since the previous one, so
  nothing is sent twice. `previous_period` is the last whole day, week or month in the
  schedule's zone; `all_matching` is everything the filter reaches, every time.
- **Format is CSV**; `--xlsx` for a spreadsheet, where dates sort as dates and are shown
  in the schedule's zone (a CSV keeps ISO UTC).
- **Columns** are the usual set (when, to, subject, status …), and `fields` is on, so a
  form's fields follow them one column each. `--no-fields` turns that off.
- **Sender** is the account's address unless `--from` names one on a verified domain.
- Up to 20 recipients: `--to "Ops <ops@acme.example>, james@example.com"`.
- The filter is the Sent log's own: `--form`, `--subject`, `--from-address`,
  `--to-address`, `--status delivered,bounced`, `--opens opened|unopened|untracked`. An
  export with no filter at all is the whole log.

## The rest of the surface

```bash
bunx postboi exports                   # (or `exports list`) NAME · SCHEDULE · TO · NEXT · STATE · ID
bunx postboi exports run <id>          # one file now; the schedule carries on
bunx postboi exports pause <id>        # keeps the row, stops the clock (run refuses while paused)
bunx postboi exports resume <id>
bunx postboi exports delete <id>       # immediate, unprompted
```

`mail.exports.all() / get(id) / update(id, changes) / run(id) / delete(id)` from code, or
`GET|POST /v1/exports`, `GET|PATCH|DELETE /v1/exports/:id`, `POST /v1/exports/:id/run`
with `Authorization: Bearer $POSTBOI_TOKEN` — a `PATCH` is partial, `{ "paused": true }`
pauses. Client-space keys (`pb_…` minted for a workspace) can't reach it; the token
`postboi init` wrote can.

Each run is an ordinary send: it sits in the Sent log with the file attached and its
delivery status, and webhooks see it like any other. An empty window sends a short note
and no file. A failed run keeps its window, so the next run covers it rather than
dropping it.

Full page: `https://docs.postboi.app/raw/forms` (forms and what an export of one holds).
