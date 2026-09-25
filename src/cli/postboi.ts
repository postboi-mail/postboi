import { env, platform } from "node:process"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

/**
 * The Postboi provider device-auth flow for `postboi init`:
 *
 *   1. `start_device_auth` asks the API for a one-time code and a claim URL
 *   2. the user signs in at that URL and authorises the device
 *   3. `poll_device_auth` exchanges the code for an API token, exactly once
 *
 * The token is then written to the project's env file(s) as `POSTBOI_TOKEN` — no other
 * configuration is needed for `mail()` to send through the Postboi provider.
 */

const DEFAULT_BASE = "https://postboi.app"

/** API base URL — `POSTBOI_API_URL` overrides for staging/local development. */
export function cloud_base(): string {
	return (env.POSTBOI_API_URL ?? DEFAULT_BASE).replace(/\/$/, "")
}

export interface DeviceStart {
	code: string
	url: string
	expires_in: number
	interval: number
}

/** A failure in the device flow with a message safe to print as-is. */
export class PostboiAuthError extends Error {}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Validate a start response's shape, defaulting the timing fields. */
function read_start(data: Partial<DeviceStart>, fallback_ttl: number): DeviceStart | undefined {
	if (typeof data.code !== "string" || typeof data.url !== "string") return undefined
	return {
		code: data.code,
		url: data.url,
		expires_in: typeof data.expires_in === "number" ? data.expires_in : fallback_ttl,
		interval: typeof data.interval === "number" ? data.interval : 2,
	}
}

/**
 * The polling loop shared by device auth and the connect flow: POST `{ code }` to `path`
 * until `parse` yields a result, the server declares the code dead (404/410), or the
 * deadline passes. Transient network errors and non-JSON bodies (a captive portal's 200)
 * never throw — they're just another tick of the loop.
 */
async function poll_code<T>(
	base: string,
	path: string,
	start: DeviceStart,
	parse: (data: Record<string, unknown>) => T | undefined,
	deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {}
): Promise<T | "dead" | "timeout"> {
	const { fetch: fetch_fn = fetch, sleep = delay, now = Date.now } = deps
	const deadline = now() + start.expires_in * 1000

	while (now() < deadline) {
		let response: Response | undefined
		try {
			response = await fetch_fn(`${base}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code: start.code }),
			})
		} catch {
			// transient network blip — keep polling until the deadline
		}
		if (response) {
			// Only the statuses the API actually uses for a dead code are terminal. Anything
			// else — a 429 from an edge rate-limiter throttling the 2s polling, a WAF 403, a
			// 5xx — is transient and must not abort a sign-in the user is mid-way through.
			if (response.status === 404 || response.status === 410) return "dead"
			if (response.ok) {
				const data = (await response.json().catch(() => undefined)) as
					| Record<string, unknown>
					| undefined
				if (data) {
					const result = parse(data)
					if (result !== undefined) return result
				}
			}
		}
		await sleep(start.interval * 1000)
	}
	return "timeout"
}

/**
 * One POST with the auth flows' shared failure behavior: network problems and non-OK
 * statuses become a PostboiAuthError whose message is safe to print as-is — and lives
 * here once, so a wording fix reaches every flow. A JSON error body's `message` wins
 * over the generic status line (the API writes those to be shown).
 */
async function post_json(
	base: string,
	path: string,
	body: unknown | undefined,
	fetch_fn: FetchLike
): Promise<Record<string, unknown>> {
	let response: Response
	try {
		response = await fetch_fn(`${base}${path}`, {
			method: "POST",
			...(body !== undefined
				? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
				: {}),
		})
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new PostboiAuthError(`Could not reach ${base} (${reason}). Are you online?`)
	}
	const data = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
	if (!response.ok) {
		throw new PostboiAuthError(
			typeof data?.message === "string" && data.message
				? data.message
				: `the Postboi provider responded with ${response.status}. Try again shortly.`
		)
	}
	return data ?? {}
}

export async function start_device_auth(
	base: string,
	fetch_fn: FetchLike = fetch
): Promise<DeviceStart> {
	const start = read_start(
		(await post_json(base, "/api/cli/start", undefined, fetch_fn)) as Partial<DeviceStart>,
		600
	)
	if (!start) {
		throw new PostboiAuthError(
			"Unexpected response from the Postboi provider. Update postboi and retry."
		)
	}
	return start
}

/** What a claimed code exchanges into: the API token, plus the account's sending address. */
export interface DeviceClaim {
	token: string
	send_address?: string
}

/** A zero-setup account, minted with no sign-in — sandboxed until claimed at `claim_url`. */
export interface ProvisionResult {
	token: string
	send_address?: string
	claim_url?: string
	expires_in_days?: number
	/** Publishable managed-captcha key — rides along so init needs no second request. */
	captcha_key?: string
}

/**
 * The `--agent` path: mint an account in one round trip, no browser and no human. The
 * account is sandboxed (sends run the whole pipeline, nothing is delivered) until
 * someone signs in at `claim_url` — which is why this needs no auth to call. `name` and
 * `slug` come from the project's package.json, so the sending address reads like the
 * project rather than a random phrase.
 */
export async function provision_account(
	base: string,
	body: { name?: string; slug?: string } = {},
	fetch_fn: FetchLike = fetch
): Promise<ProvisionResult> {
	let data: Partial<Record<keyof ProvisionResult, unknown>>
	try {
		data = await post_json(base, "/api/cli/provision", body, fetch_fn)
	} catch (error) {
		// An API that predates provisioning 404s the route — "try again shortly" would
		// send an unattended agent into a retry loop that can never succeed.
		if (error instanceof PostboiAuthError && error.message.includes("404")) {
			throw new PostboiAuthError(
				"This Postboi API doesn't support zero-setup provisioning. Run `postboi init` without --agent to sign in."
			)
		}
		throw error
	}
	if (typeof data.token !== "string") {
		// An older API without the provision endpoint answers with HTML or a 404 shape.
		throw new PostboiAuthError(
			"This Postboi API doesn't support zero-setup provisioning. Run `postboi init` without --agent to sign in."
		)
	}
	return {
		token: data.token,
		send_address: typeof data.send_address === "string" ? data.send_address : undefined,
		claim_url: typeof data.claim_url === "string" ? data.claim_url : undefined,
		expires_in_days: typeof data.expires_in_days === "number" ? data.expires_in_days : undefined,
		captcha_key: typeof data.captcha_key === "string" ? data.captcha_key : undefined,
	}
}

/** Poll until the browser side authorises (resolves with the claim) or the code dies. */
export async function poll_device_auth(
	base: string,
	start: DeviceStart,
	deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {}
): Promise<DeviceClaim> {
	const result = await poll_code<DeviceClaim>(
		base,
		"/api/cli/poll",
		start,
		(data) =>
			data.status === "claimed" && typeof data.token === "string"
				? {
						token: data.token,
						send_address: typeof data.send_address === "string" ? data.send_address : undefined,
					}
				: undefined,
		deps
	)
	if (result === "dead") {
		throw new PostboiAuthError("This sign-in code is no longer valid. Run `postboi init` again.")
	}
	if (result === "timeout") {
		throw new PostboiAuthError("Timed out waiting for the browser. Run `postboi init` again.")
	}
	return result
}

/**
 * The OAuth webhook connect flow for chat platforms, mirroring device auth: `start`
 * mints a code and a browser URL, the user picks a channel on the provider's own consent
 * screen, `poll` collects the created webhook URL. Everything here degrades to
 * `undefined` rather than throwing — the paste-a-webhook prompt is always the fallback.
 */
export interface ConnectStart {
	code: string
	url: string
	expires_in: number
	interval: number
}

export async function start_connect(
	base: string,
	provider: string,
	fetch_fn: FetchLike = fetch
): Promise<ConnectStart | undefined> {
	try {
		const response = await fetch_fn(`${base}/api/connect/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider }),
		})
		if (!response.ok) return undefined
		return read_start((await response.json()) as Partial<ConnectStart>, 900)
	} catch {
		return undefined
	}
}

/** The connected webhook, plus the provider's label for it ("#alerts in Acme"). */
export interface ConnectResult {
	webhook_url: string
	label?: string
}

/** Poll until the browser side connects, or the code dies — undefined means fall back. */
export async function poll_connect(
	base: string,
	start: ConnectStart,
	deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {}
): Promise<ConnectResult | undefined> {
	const result = await poll_code<ConnectResult>(
		base,
		"/api/connect/poll",
		start,
		(data) =>
			data.status === "connected" && typeof data.webhook_url === "string"
				? {
						webhook_url: data.webhook_url,
						label: typeof data.label === "string" ? data.label : undefined,
					}
				: undefined,
		deps
	)
	return result === "dead" || result === "timeout" ? undefined : result
}

/** A domain on the account. `status` is `"verified"` when it can deliver; anything else
 * (`"pending"`, …) means DNS verification hasn't completed. */
export interface PostboiDomain {
	domain: string
	status: string
}

/** A form on the account, as `GET /v1/forms` lists it — what `form:` narrows to. */
export interface PostboiForm {
	id: string
	name: string
}

/**
 * Best-effort fetch of the account's forms, for the generated `form` types. Undefined when
 * the endpoint is unreachable or unrecognised (an older API), which the caller treats as
 * "no opinion" — the previously generated names are kept — rather than as an account
 * with no forms, which is an empty array.
 */
export async function fetch_forms(
	base: string,
	token: string,
	fetch_fn: FetchLike = fetch
): Promise<Array<PostboiForm> | undefined> {
	try {
		const response = await fetch_fn(`${base}/v1/forms`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		if (!response.ok) return undefined
		const data = (await response.json()) as { forms?: Array<Partial<PostboiForm>> }
		if (!Array.isArray(data.forms)) return undefined
		return data.forms
			.filter((f) => typeof f.id === "string" && typeof f.name === "string")
			.map((f) => ({ id: f.id as string, name: f.name as string }))
	} catch {
		return undefined
	}
}

/** The account's sending identity, as reported by `GET /v1/domains`. */
export interface PostboiAccount {
	send_address?: string
	domains: Array<PostboiDomain>
	/** Publishable managed-captcha key (pk_…), baked into node_modules by `postboi sync`. */
	captcha_key?: string
	/** Every webhook endpoint's whsec_ secret — written to POSTBOI_WEBHOOK_SECRET together. */
	webhook_secrets: Array<string>
	/** True while the account is a zero-setup project nobody has claimed. */
	unclaimed?: boolean
	/** Where a human claims it — init re-surfaces this on every run until it's claimed. */
	claim_url?: string
}

/**
 * Best-effort fetch of the account's sendable domains. Returns undefined when the endpoint
 * is unreachable or unrecognised (e.g. an older API) — callers degrade to no domain info.
 */
export async function fetch_domains(
	base: string,
	token: string,
	fetch_fn: FetchLike = fetch
): Promise<PostboiAccount | undefined> {
	try {
		const response = await fetch_fn(`${base}/v1/domains`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		if (!response.ok) return undefined
		const data = (await response.json()) as {
			send_address?: unknown
			domains?: Array<Partial<PostboiDomain>>
			captcha_key?: unknown
			webhook_secrets?: unknown
		}
		if (!Array.isArray(data.domains)) return undefined
		const extras = data as { unclaimed?: unknown; claim_url?: unknown }
		return {
			unclaimed: extras.unclaimed === true || undefined,
			claim_url: typeof extras.claim_url === "string" ? extras.claim_url : undefined,
			send_address: typeof data.send_address === "string" ? data.send_address : undefined,
			domains: data.domains
				.filter((d) => typeof d.domain === "string")
				.map((d) => ({
					domain: d.domain as string,
					status: typeof d.status === "string" ? d.status : "pending",
				})),
			captcha_key: typeof data.captcha_key === "string" ? data.captcha_key : undefined,
			webhook_secrets: Array.isArray(data.webhook_secrets)
				? data.webhook_secrets.filter((s): s is string => typeof s === "string")
				: [],
		}
	} catch {
		return undefined
	}
}

/**
 * The account's synced channel credentials, or undefined when unreachable (or on an API
 * that predates them). An empty object is a real answer: nothing synced yet.
 */
export async function fetch_env_vars(
	base: string,
	token: string,
	fetch_fn: FetchLike = fetch
): Promise<{ vars: Record<string, string> } | undefined> {
	try {
		const response = await fetch_fn(`${base}/v1/env`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		if (!response.ok) return undefined
		const data = (await response.json()) as { vars?: unknown }
		if (data.vars === null || typeof data.vars !== "object") return undefined
		const vars: Record<string, string> = {}
		for (const [key, value] of Object.entries(data.vars as Record<string, unknown>)) {
			if (typeof value === "string") vars[key] = value
		}
		return { vars }
	} catch {
		return undefined
	}
}

/**
 * Merge vars into the account's synced set. A null value deletes. A rejection carries the
 * API's reason so the caller can relay it — "the vars cap is hit" and "the network is
 * down" need different advice, and collapsing them told users to retry a 422 forever.
 */
export async function push_env_vars(
	base: string,
	token: string,
	vars: Record<string, string | null>,
	fetch_fn: FetchLike = fetch
): Promise<{ ok: true } | { ok: false; reason?: string }> {
	try {
		const response = await fetch_fn(`${base}/v1/env`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ vars }),
		})
		if (response.ok) return { ok: true }
		let reason = `the API answered ${response.status}`
		try {
			const data = (await response.json()) as { message?: unknown }
			if (typeof data.message === "string" && data.message) reason = data.message
		} catch {
			// Empty or non-JSON error body — the status line will have to do.
		}
		return { ok: false, reason }
	} catch {
		return { ok: false }
	}
}

/** Best-effort: open `url` in the default browser. The URL is always printed anyway. */
export function open_browser(url: string, os: string = platform): boolean {
	const spec =
		os === "darwin"
			? { cmd: "open", args: [url] }
			: os === "win32"
				? { cmd: "cmd", args: ["/c", "start", "", url] }
				: { cmd: "xdg-open", args: [url] }
	try {
		const child = spawn(spec.cmd, spec.args, { stdio: "ignore", detached: true })
		child.on("error", () => {}) // ENOENT etc. — the printed URL is the fallback
		child.unref()
		return true
	} catch {
		return false
	}
}
