# Effect × Postboi

A Bun script that sends welcome emails from an [Effect](https://effect.website) program
with `postboi/effect`, on the Postboi provider. Sends are Effects, and their failures are
tagged errors in the error channel.

## Run

```sh
bun install
bun run dev    # no token needed: in development each mail is printed instead of sent
bun test       # the same program against Mailer.layerMock()
```

To send for real, run `bunx postboi init` (it writes `POSTBOI_TOKEN` to `.env`) and then
`bun run start`.

## How it works

- **`src/index.ts`**: `welcome(to)` asks for the `Mailer` service and sends through it,
  wrapped in `with_retry` so a 429 or a 5xx that proves nothing was sent is tried again.
  `program` welcomes two people and handles each outcome with `Effect.catchTag`:
  `SkipSend` when a hook cancelled the send, `PostboiError` when the provider failed. It
  runs with `Mailer.layer`, which reads `POSTBOI_PROVIDER` and `POSTBOI_TOKEN` through
  Effect's `Config`.
- **`postboi.config.ts`**: the provider (the Postboi provider), the default `from`, and a
  `before.send` hook that throws `SkipSendError` for an unsubscribed address. That throw
  arrives in the program as `SkipSend`.
- **`src/index.test.ts`**: provides `Mailer.layerMock(mock)` instead, so nothing leaves
  the process, and reads `mock.sent` back.

Swap `provider` in `postboi.config.ts` (or set `POSTBOI_PROVIDER`) for any of the
[supported providers](https://docs.postboi.app/providers). The full API is on the
[Effect page](https://docs.postboi.app/effect) of the docs.
