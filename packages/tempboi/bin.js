#!/usr/bin/env node
// `npx tempboi …` is `postboi inbox …`. The CLI lives in postboi; this package only
// gives it the short name. The publish workflow pins the postboi version this
// release was cut with, so the two can't drift apart.
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const entry = createRequire(import.meta.url).resolve("postboi")
process.argv.splice(2, 0, "inbox")
await import(pathToFileURL(join(dirname(entry), "cli.js")).href)
