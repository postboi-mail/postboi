// Service worker, created by `bunx postboi init --push`.
// Receive-only: no fetch handler and no caching — a worker that intercepts requests is a
// different feature, and this one only exists to deliver notifications.

import { receive } from "postboi/push/sw"

// Shows the notification, opens the right tab on click, and re-subscribes when the browser
// rotates this subscription. With managed push the rotation goes to Postboi itself, which
// moves the old subscription's person and lists onto the new one, so no arguments.
receive()
