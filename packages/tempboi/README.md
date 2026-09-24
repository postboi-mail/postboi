# tempboi

Throwaway email inboxes from your terminal, at [tempboi.email](https://tempboi.email). No sign-up.
Made for developers, tests and agents, and run by [Postboi](https://postboi.app).

```sh
npx tempboi                          # make an inbox and print its address
npx tempboi watch                    # print new mail as it arrives
CODE=$(npx tempboi wait --code)      # wait for a verification email, print its code
npx tempboi watch --json             # one JSON message per line
npx tempboi watch --forward http://localhost:5173/api/inbound
```

`npx tempboi <command>` is the same as `npx postboi inbox <command>`. In test code, use
`import { temp } from "postboi/inbox"`.

Inboxes last an hour (up to a day), hold 100 messages and are deleted when they expire.
Docs: https://docs.postboi.app/temp-inbox
