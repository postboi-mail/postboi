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

const DEFAULT_BASE = "https://postboi.email"

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

export async function start_device_auth(
	base: string,
	fetch_fn: FetchLike = fetch
): Promise<DeviceStart> {
	let response: Response
	try {
		response = await fetch_fn(`${base}/api/cli/start`, { method: "POST" })
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new PostboiAuthError(`Could not reach ${base} (${reason}). Are you online?`)
	}
	if (!response.ok) {
		throw new PostboiAuthError(
			`the Postboi provider responded with ${response.status} — try again shortly.`
		)
	}
	const data = (await response.json()) as Partial<DeviceStart>
	if (typeof data.code !== "string" || typeof data.url !== "string") {
		throw new PostboiAuthError(
			"Unexpected response from the Postboi provider — update postboi and retry."
		)
	}
	return {
		code: data.code,
		url: data.url,
		expires_in: typeof data.expires_in === "number" ? data.expires_in : 600,
		interval: typeof data.interval === "number" ? data.interval : 2,
	}
}

/** What a claimed code exchanges into: the API token, plus the account's sending address. */
export interface DeviceClaim {
	token: string
	send_address?: string
}

/** Poll until the browser side authorises (resolves with the claim) or the code dies. */
export async function poll_device_auth(
	base: string,
	start: DeviceStart,
	deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {}
): Promise<DeviceClaim> {
	const { fetch: fetch_fn = fetch, sleep = delay, now = Date.now } = deps
	const deadline = now() + start.expires_in * 1000

	while (now() < deadline) {
		let response: Response | undefined
		try {
			response = await fetch_fn(`${base}/api/cli/poll`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code: start.code }),
			})
		} catch {
			// transient network blip — keep polling until the deadline
		}
		if (response) {
			if (response.status === 404 || response.status === 410) {
				throw new PostboiAuthError(
					"This sign-in code is no longer valid — run `postboi init` again."
				)
			}
			if (response.ok) {
				const data = (await response.json()) as {
					status?: string
					token?: string
					send_address?: string
				}
				if (data.status === "claimed" && typeof data.token === "string") {
					return {
						token: data.token,
						send_address: typeof data.send_address === "string" ? data.send_address : undefined,
					}
				}
			}
		}
		await sleep(start.interval * 1000)
	}

	throw new PostboiAuthError("Timed out waiting for the browser — run `postboi init` again.")
}

/** A domain on the account. `status` is `"verified"` when it can deliver; anything else
 * (`"pending"`, …) means DNS verification hasn't completed. */
export interface PostboiDomain {
	domain: string
	status: string
}

/** The account's sending identity, as reported by `GET /v1/domains`. */
export interface PostboiAccount {
	send_address?: string
	domains: Array<PostboiDomain>
	/** Publishable managed-captcha key (pk_…), baked into node_modules by `postboi sync`. */
	captcha_key?: string
	/** Every webhook endpoint's whsec_ secret — written to POSTBOI_WEBHOOK_SECRET together. */
	webhook_secrets: Array<string>
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
		return {
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
