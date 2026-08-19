// Service worker, created by `bunx postboi init --push`.
// Receive-only: no fetch handler and no caching — a worker that intercepts requests is a
// different feature, and this one only exists to deliver notifications.

import { receive } from "postboi/push/sw"

// Shows the notification, opens the right tab on click, and re-subscribes when the browser
// rotates this subscription — the last of which only fires inside a worker, which is why
// it can't live on the page with the rest of postboi/push.
receive({ register: "/push" })
