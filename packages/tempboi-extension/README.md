# tempboi for Chrome

A throwaway inbox in the browser toolbar, at [tempboi.email](https://tempboi.email). No
sign-up. The code in a sign-up email is picked out as it lands, and a right-click fills your
address (or the code) into the form you are looking at.

It speaks only the public `/v1/inboxes` API, the same one `npx tempboi` and
`postboi/inbox` use, so nothing here needs the app's code or an account.

## What it does

- **An address on one press**, copied on the next. The card counts down to expiry, `+1h`
  adds an hour up to the day an anonymous inbox may live, **New** swaps it for a fresh one
  (random or named) and **Delete** takes it and its mail now.
- **Mail as it lands.** The worker follows the inbox by Web Push, the same push the page's
  Notify me uses, so it is woken the moment mail is filed even with the popup shut. The
  push is silent and carries nothing we read: it is a bell, and the worker fetches the mail
  itself. An alarm every five minutes backs it up, and becomes every thirty seconds where
  push can't be had (a server with no VAPID key, a browser that refused). While the popup
  is open it long-polls as well (`messages?wait=25`). The badge counts unopened mail.
- **The code and the link up front.** Each row carries the code as a copy chip and an
  **Open link** key for the verify link, both read out by the server at arrival.
- **A notification per message**, titled with the code when there is one, with **Copy
  code** and **Open link** buttons. Clicking it opens the message on tempboi.email.
- **Fill the form.** Right-click any field for _Fill in my tempboi address_ (makes an inbox
  if there isn't one) or _Fill in the latest code_. `Alt+Shift+E` and `Alt+Shift+C` do the
  same for the focused field; `Alt+Shift+T` opens the popup. The value goes in the way
  typing would, so React and friends hear it.
- **A reader that can't be used against you.** The html is a stranger's, so it goes into a
  sandboxed frame with scripts and forms off, and a CSP that holds back remote images (a
  read receipt) until you press **Show**. Attachments and the `.eml` download with the
  token in a header, never in a URL.
- **Bring an inbox in** from the page or the CLI: paste the page's _Watch this inbox in a
  terminal_ command (or the bare `tb_…` token) on the settings page. A preview's command
  names its server with `POSTBOI_INBOX_URL`, and that is honoured.
- **Settings**: the lifetime of a new inbox (1 hour, 6 hours, a day), notifications on or
  off, and the server, for testing against a Postboi preview or `bun dev`. A server other
  than tempboi.email is asked for as an optional host permission when it is saved.

## Working on it

There is no build step: `manifest.json` points at the files in `src/` as they are.

1. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick
   this folder.
2. After an edit, press the reload arrow on the extension's card. The popup and the
   options page pick changes up when reopened; the worker needs the reload.

To try it against a local app, run `bun dev` in postboi-app and set the server to
`http://localhost:5173` in the extension's settings. Mail can be filed there with the
app's `inject` route, which exists on previews and `bun dev` only.

```sh
bun test src   # the pure rules (rules.js)
bun run pack   # tempboi-extension.zip, for the Chrome Web Store
```

`src/rules.js` is everything that can be decided without `chrome`, `fetch` or a DOM and is
where a change should go first. `src/api.js` is the one place the API is called.
`src/state.js` is what is held in `chrome.storage.local` and the few things that change it;
the popup and the worker both go through it, so the badge and the list never disagree.
`src/fill.js` runs in the page and may use nothing outside its own body.

The fonts are the latin subsets of Archivo, Golos Text and Monaspace Neon, from fontsource,
bundled because a store extension shouldn't load them from a CDN. The icons are
`assets/mark.svg` (the app's favicon) rendered at 16, 32, 48 and 128.

## Publishing

CI publishes it (`.github/workflows/extension.yml`). **Raise `"version"` in
`manifest.json` and merge to `main`**: the workflow tests, packs, uploads the zip and
submits it for review, and it goes live when Google approves it. Any other change under
this folder runs the same steps and stops at "the store already has it", because the
store refuses a version that isn't higher than the last. Run the workflow by hand from
the Actions tab to retry, or tick **staged** to hold an approved version until you publish
it from the dashboard.

`bun run release` is the same step by hand, after `bun run pack`, with `CWS_PUBLISHER_ID`,
`CWS_EXTENSION_ID` and `CWS_ACCESS_TOKEN` in the environment (a token with the
`https://www.googleapis.com/auth/chromewebstore` scope, for example from
`gcloud auth print-access-token --impersonate-service-account=… --scopes=…`).

### Once, before CI can publish

1. **Publish the first version by hand.** The API can only update an item that exists
   and whose **Store listing** and **Privacy** tabs are filled in. Upload the zip from
   `bun run pack` in the Developer Dashboard and submit it. The account needs 2-step
   verification.
2. **Note two ids**: the publisher id (Developer Dashboard → **Account**) and the
   extension's id (in its dashboard URL).
3. **Make a service account** in a Google Cloud project, with the **Chrome Web Store
   API** enabled. It needs no roles. Add its email in the Developer Dashboard under
   **Account** (one service account per publisher).
4. **Let GitHub sign in as it**, keyless (preferred): create a Workload Identity pool and
   an OIDC provider for `https://token.actions.githubusercontent.com`, restricted to this
   repository (`assertion.repository == 'postboi-mail/postboi'`), and grant the
   repository's principal `roles/iam.workloadIdentityUser` on the service account.
   Or, if that's more than you want to set up, create a JSON key for the service account
   instead.
5. **Set these in the repository** (Settings → Secrets and variables → Actions):

   | Name                             | Kind     | Value                                                                                  |
   | -------------------------------- | -------- | -------------------------------------------------------------------------------------- |
   | `CWS_PUBLISHER_ID`               | variable | the publisher id                                                                       |
   | `CWS_EXTENSION_ID`               | variable | the extension id                                                                       |
   | `CWS_SERVICE_ACCOUNT`            | variable | the service account's email                                                            |
   | `CWS_WORKLOAD_IDENTITY_PROVIDER` | variable | `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
   | `CWS_SERVICE_ACCOUNT_KEY`        | secret   | the JSON key, only if you skipped Workload Identity                                    |

   Until the two ids are set the workflow's job is skipped, so nothing fails in the
   meantime.

## For the store listing

The listing's own copy is in `store/`: `description.txt` for the Description field and
`icon-128.png` for the Store icon (the mark at 96px with 16px of transparent padding,
as the store's image guidelines ask; `icons/128.png` is the toolbar's and runs to the
edge). `bun run pack` leaves the folder out of the zip.

**Summary**: A throwaway inbox in your toolbar. Codes picked out as they land, filled into
the page for you. No sign-up.

**Category**: Developer Tools (or Productivity).

**Single purpose**: give the person a temporary email address at tempboi.email and show
the mail that arrives at it.

Why each permission is asked for:

| Permission                    | Why                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `storage`                     | Keeps the current inbox, its token, the messages already read and the settings on this device.           |
| `alarms`                      | A backstop check for new mail in case a push is dropped.                                                 |
| `notifications` (and push)    | Says when mail arrives, with the code on it.                                                             |
| `contextMenus`                | The right-click items that fill the address or the code into a field.                                    |
| `activeTab`, `scripting`      | Puts the address or code into the field that was right-clicked or focused, on that tab only, when asked. |
| `offscreen`, `clipboardWrite` | Copies a code from a notification's button, which the worker can't do by itself.                         |
| `https://tempboi.email/*`     | The API the inboxes live on.                                                                             |
| optional hosts                | Only when the person points the extension at another server (a Postboi preview or a local app).          |

**Data**: the extension sends nothing anywhere but the tempboi server it is set to. The
inbox token is stored locally and sent only to that server, in a header. No analytics.
Privacy policy: https://postboi.app/privacy. Terms: https://tempboi.email/terms.
