#!/usr/bin/env bun
/**
 * Send tempboi-extension.zip to the Chrome Web Store and submit it, through the v2 API.
 * CI runs it (.github/workflows/extension.yml) after `bun run pack`; it runs by hand too.
 *
 *   CWS_PUBLISHER_ID  the publisher's id (Developer Dashboard → Account)
 *   CWS_EXTENSION_ID  the item's id (its dashboard URL, and its store URL)
 *   CWS_ACCESS_TOKEN  an OAuth token with the chromewebstore scope
 *   CWS_STAGED=1      hold an approved version back until it's published by hand
 *   CWS_API           another API origin, for testing the script against a stand-in
 *
 * The version is the gate: a manifest version the store already has (or passed) is a
 * skip and exits 0, so pushing an edit that didn't bump it does nothing.
 */
import { readFile, appendFile } from "node:fs/promises"
import { API, plan, publish_body, publish_outcome, upload_outcome } from "./store_rules.js"

const root = new URL("..", import.meta.url)
const { CWS_PUBLISHER_ID, CWS_EXTENSION_ID, CWS_ACCESS_TOKEN, CWS_STAGED } = process.env
const api = process.env.CWS_API ?? API

function stop(message) {
	console.error(`✗ ${message}`)
	process.exit(1)
}

if (!CWS_PUBLISHER_ID || !CWS_EXTENSION_ID || !CWS_ACCESS_TOKEN)
	stop("Set CWS_PUBLISHER_ID, CWS_EXTENSION_ID and CWS_ACCESS_TOKEN.")

const item = `publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}`
const auth = { authorization: `Bearer ${CWS_ACCESS_TOKEN}` }

async function call(url, init = {}) {
	const response = await fetch(url, { ...init, headers: { ...auth, ...init.headers } })
	const text = await response.text()
	let body
	try {
		body = text ? JSON.parse(text) : {}
	} catch {
		body = { raw: text }
	}
	if (!response.ok)
		stop(
			`${init.method ?? "GET"} ${url} answered ${response.status}: ${body?.error?.message ?? text}`
		)
	return body
}

const status = () => call(`${api}/v2/${item}:fetchStatus`)

async function summary(line) {
	console.log(line)
	if (process.env.GITHUB_STEP_SUMMARY)
		await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
}

const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"))
const decided = plan(manifest.version, await status())
if (!decided.upload) {
	await summary(`${decided.fail ? "✗" : "–"} ${decided.reason}`)
	process.exit(decided.fail ? 1 : 0)
}
await summary(`Chrome Web Store: ${decided.reason}`)

const zip = await readFile(new URL("tempboi-extension.zip", root)).catch(() =>
	stop("No tempboi-extension.zip here. Run `bun run pack` first.")
)
const uploaded = await call(`${api}/upload/v2/${item}:upload`, {
	method: "POST",
	headers: { "content-type": "application/zip" },
	body: zip,
})

// A large package is processed after the answer; the status says when it's through.
let state = uploaded.uploadState
for (let tries = 0; upload_outcome(state) === "waiting" && tries < 40; tries++) {
	await new Promise((done) => setTimeout(done, 3000))
	state = (await status()).lastAsyncUploadState
}
if (upload_outcome(state) !== "done") stop(`The upload didn't go through (${state ?? "no state"}).`)
await summary(`Uploaded ${uploaded.crxVersion ?? manifest.version}.`)

const published = await call(`${api}/v2/${item}:publish`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(publish_body({ staged: CWS_STAGED === "1" || CWS_STAGED === "true" })),
})
for (const warning of published.warningInfo ?? [])
	await summary(`Warning: ${warning.description ?? warning.reason}`)
const outcome = publish_outcome(published.state)
await summary(outcome.said)
if (outcome.failed) process.exit(1)
