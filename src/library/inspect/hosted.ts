import { ensure_env_loaded, read_env } from "../env.js"
import type { Report } from "./types.js"

/**
 * A test run at the hosted testing API — the same runs the dashboard shows,
 * driven from code. Two ways in, one function:
 *
 * ```ts
 * import { hosted_test } from "postboi/inspect"
 *
 * // Paste path: hand over the HTML, get the report back on the same call.
 * const test = await hosted_test({ html, subject: "Welcome v3" })
 * test.report?.status // "pass" | "info" | "warning" | "error"
 *
 * // Send path: mint the address, send to it however you send, then wait.
 * const test = await hosted_test({ label: "welcome v3" })
 * await mail({ to: test.address, subject: "Welcome", body: html })
 * const done = await test.wait()
 * done.authentication?.spf // "pass" — a real send gets the real checks
 *
 * // Screenshots: wait until every capture has settled, then take the images home.
 * const shot = await (await hosted_test({ html, series: "welcome" })).wait({ screenshots: true })
 * for (const preview of shot.previews.filter((p) => p.status === "ready")) {
 * 	const bytes = await (await shot.capture(preview)).arrayBuffer()
 * }
 * ```
 *
 * The paste path is the tight loop — same analysis, same screenshots, report
 * on return — while the send path exercises the whole journey, so SPF, DKIM,
 * DMARC and the SpamAssassin score are judged for real. Either way `url` is
 * the run's dashboard page, screenshots and all.
 *
 * Authenticated with a Postboi API token (`POSTBOI_TOKEN`, or pass `token`).
 * Every run counts against the account's daily cap, and every screenshot
 * client on it is a rendered preview from the monthly allowance — a test
 * suite that runs on every commit wants this behind an `if`.
 */
export interface HostedTestOptions {
	/** The email's HTML. Present, the run ingests immediately — the paste path. */
	html?: string
	/** Plain-text part to go with `html`. */
	text?: string
	subject?: string
	/** The run's name in the dashboard list. Defaults to `subject`. */
	label?: string
	/**
	 * A named test entry to continue. Runs sharing a `series` name stack as
	 * attempts of one email in the dashboard — the edit-and-re-run loop — and a
	 * continued entry keeps its screenshot clients unless `clients` says otherwise.
	 * Doubles as the label; the first run under a name starts the entry.
	 */
	series?: string
	/** Screenshot client ids (GET /v1/testing/clients) — omit for the curated set. */
	clients?: Array<string>
	/**
	 * A saved client set, by name (case-insensitive): the ones saved in the dashboard
	 * or with `postboi testing sets save`. Instead of `clients`, not beside it.
	 */
	set?: string
	/**
	 * Render every client again, even where an identical earlier capture of the same
	 * content could be reused for free.
	 */
	fresh?: boolean
	/** API token. Defaults to the `POSTBOI_TOKEN` environment variable. */
	token?: string
	/** API base. Defaults to `POSTBOI_API_URL` or `https://postboi.app`. */
	api?: string
	/** The fetch to use — inject a stub in tests. Defaults to the platform's. */
	fetch?: typeof globalThis.fetch
}

/** How a run's screenshots are coming along, as the API sums them up. */
export interface ScreenshotSummary {
	/**
	 * `disabled`: no rendering on this server. `submitting`: the email is in, the
	 * captures aren't ordered yet. `rendering`: at least one is pending. `done`:
	 * nothing pending, or nothing was ordered.
	 */
	state: "disabled" | "submitting" | "rendering" | "done"
	total: number
	ready: number
	failed: number
	pending: number
	/** Why some clients have no capture at all ("Out of renders: 3 clients skipped…"). */
	notes: Array<string>
}

/** One client's capture, as the API answers it. Image paths are relative to the API. */
export interface TestingPreview {
	id?: string
	client_id?: string
	client_name?: string
	/** The same as `client_id` and `client_name`: the names older servers answer with. */
	client?: string
	name?: string
	status: "pending" | "ready" | "failed"
	error?: string
	group?: string
	family?: string
	platform?: string
	os?: string
	dark?: boolean
	url?: string
	thumbnail_url?: string
	/** Copied from an identical earlier render of the same content, not billed. */
	reused?: boolean
	/** The same client's capture in the latest earlier attempt of the series. */
	previous?: {
		run_id: string
		preview_id: string
		url: string
		created_at: string
		/** Byte-identical image, or null when that isn't known. */
		identical: boolean | null
	} | null
}

/**
 * A run as the API answers it: `GET /v1/testing/{id}`, the paste's answer, and the
 * `data` of the `testing.*` webhooks. Fields an older server doesn't send are absent.
 */
export interface TestingRun {
	id: string
	status: "waiting" | "received" | "expired"
	label?: string
	subject?: string
	from?: string
	address?: string
	/** The run's dashboard page, in the team that owns it. */
	url?: string
	/** The first attempt of the entry this run belongs to (its own id on a first attempt). */
	series_id?: string
	report?: Report | null
	spam?: HostedTest["spam"] | null
	authentication?: HostedTest["authentication"]
	previews?: Array<TestingPreview>
	screenshots?: ScreenshotSummary
	/** Renders this run spent, and (on the create answer) what the account has left. */
	renders?: { used?: number; left?: number | null }
	fresh?: boolean
	share_url?: string | null
	created_at?: string
	received_at?: string
}

/** A capture with both naming schemes filled in and its image paths made absolute. */
export type HostedPreview = TestingPreview & {
	client: string
	name: string
	client_id: string
	client_name: string
}

/** A run in whatever state it has reached. `wait()` carries it to a finished one. */
export interface HostedTest {
	/** The run id — the `{id}` in every /v1/testing call. */
	id: string
	/** The run's dashboard page: the full report, screenshots included. */
	url: string
	/** The run's one-shot address. Send to it, then {@link wait}. */
	address: string
	status: "waiting" | "received" | "expired"
	/** The postboi/inspect report, once the email is in. */
	report?: Report
	/** SpamAssassin over the exact bytes that arrived — real sends only. */
	spam?: { score: number; rules: Array<{ score: number; description: string }> }
	/** The receiving server's verdicts — real sends only. */
	authentication?: {
		spf: string | null
		dkim: string | null
		dmarc: string | null
		spf_record: string | null
		dmarc_record: string | null
	}
	/** Screenshot captures, when rendering is enabled on the account. */
	previews: Array<HostedPreview>
	/** The first attempt of this run's entry; every attempt in a series shares it. */
	series_id?: string
	/** How the captures are coming along. Absent from servers that predate it. */
	screenshots?: ScreenshotSummary
	/** `left`: renders the account had when the run was ordered (null is unlimited). `used`: what this run spent. */
	renders?: { used?: number; left?: number | null }
	/** The read-only link anyone can open, once {@link share} made one. */
	share_url?: string | null
	/**
	 * Poll until the run's email arrives (or the run expires — check `status`). With
	 * `screenshots: true`, keep polling until every capture has settled too (default
	 * timeout then 15 minutes). Answers the finished run; the object it's called on is
	 * left as it was.
	 */
	wait(options?: {
		poll_ms?: number
		timeout_ms?: number
		screenshots?: boolean
	}): Promise<HostedTest>
	/**
	 * One capture's image, fetched with the run's token. `width` asks the server for a
	 * resized copy. The bytes are yours to keep: `await (await test.capture(p)).arrayBuffer()`.
	 */
	capture(preview: TestingPreview, options?: { width?: number }): Promise<Response>
	/** Make (or, with `revoke`, take down) the run's read-only share link. Answers the link. */
	share(options?: { revoke?: boolean }): Promise<string | null>
}

/** The grace an older server (no `screenshots` summary) gets to show its first capture row. */
const ROWS_GRACE_MS = 120_000

/**
 * Whether a run is finished, screenshots included. Servers with the `screenshots`
 * summary say so outright; older ones are settled once rows exist and none is pending,
 * or when no row turned up within a two-minute grace (nothing was ordered).
 */
export function screenshots_settled(run: TestingRun, waited_ms: number): boolean {
	if (run.status === "waiting") return false
	if (run.status === "expired") return true
	if (run.screenshots) {
		return run.screenshots.state === "done" || run.screenshots.state === "disabled"
	}
	const previews = run.previews ?? []
	if (previews.length) return previews.every((preview) => preview.status !== "pending")
	return waited_ms >= ROWS_GRACE_MS
}

/** Fill in both naming schemes and make image paths absolute against `api`. */
export function hosted_preview(preview: TestingPreview, api: string): HostedPreview {
	const client = preview.client_id ?? preview.client ?? ""
	const name = preview.client_name ?? preview.name ?? client
	const absolute = (path?: string) => (path ? new URL(path, `${api}/`).href : undefined)
	return {
		...preview,
		client,
		name,
		client_id: client,
		client_name: name,
		url: absolute(preview.url),
		thumbnail_url: absolute(preview.thumbnail_url),
	}
}

export async function hosted_test(options: HostedTestOptions = {}): Promise<HostedTest> {
	// Makes `.env` values and Worker bindings visible before the token is read.
	await ensure_env_loaded()
	const token = options.token ?? read_env("POSTBOI_TOKEN")
	if (!token) {
		throw new Error(
			"postboi/inspect: hosted_test needs an API token. Pass `token` or set POSTBOI_TOKEN"
		)
	}
	const api = (options.api ?? read_env("POSTBOI_API_URL") ?? "https://postboi.app").replace(
		/\/+$/,
		""
	)
	const fetcher = options.fetch ?? globalThis.fetch
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }

	async function call<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetcher(`${api}${path}`, { ...init, headers })
		if (!response.ok) {
			const body = (await response.json().catch(() => undefined)) as
				| { message?: string }
				| undefined
			const why = body?.message ? `: ${body.message}` : ""
			throw new Error(`postboi/inspect: ${path} answered ${response.status}${why}`)
		}
		if (response.status === 204) return undefined as T
		return (await response.json()) as T
	}

	const created = await call<TestingRun & { address: string }>("/v1/testing", {
		method: "POST",
		body: JSON.stringify({
			label: options.series ? undefined : (options.label ?? options.subject),
			series: options.series,
			clients: options.clients,
			set: options.set,
			fresh: options.fresh,
		}),
	})
	const run_path = `/v1/testing/${created.id}`
	let share_url: string | null | undefined

	function decorate(run: TestingRun): HostedTest {
		return {
			id: created.id,
			url: run.url ?? created.url ?? `${api}/dashboard/testing/${created.id}`,
			address: created.address,
			status: run.status,
			report: run.report ?? undefined,
			spam: run.spam ?? undefined,
			authentication: run.authentication,
			previews: (run.previews ?? []).map((preview) => hosted_preview(preview, api)),
			series_id: run.series_id ?? created.series_id,
			screenshots: run.screenshots,
			renders: { left: created.renders?.left, used: run.renders?.used },
			share_url: share_url !== undefined ? share_url : run.share_url,
			wait,
			capture,
			share,
		}
	}

	async function wait(
		poll: { poll_ms?: number; timeout_ms?: number; screenshots?: boolean } = {}
	): Promise<HostedTest> {
		const poll_ms = poll.poll_ms ?? 5000
		const started = Date.now()
		const deadline = started + (poll.timeout_ms ?? (poll.screenshots ? 15 * 60_000 : 120_000))
		for (;;) {
			const run = await call<TestingRun>(run_path)
			const done = poll.screenshots
				? screenshots_settled(run, Date.now() - started)
				: run.status !== "waiting"
			if (done) return decorate(run)
			if (Date.now() >= deadline) {
				throw new Error(
					run.status === "waiting"
						? `postboi/inspect: no email arrived for ${created.id} in time`
						: `postboi/inspect: ${created.id} is still rendering screenshots`
				)
			}
			await new Promise((resolve) => setTimeout(resolve, poll_ms))
		}
	}

	async function capture(preview: TestingPreview, image: { width?: number } = {}) {
		if (!preview.url) {
			throw new Error(
				`postboi/inspect: ${preview.client_name ?? preview.name ?? "that preview"} has no capture yet`
			)
		}
		const url = new URL(preview.url, `${api}/`)
		if (image.width) url.searchParams.set("width", String(image.width))
		const response = await fetcher(url.href, { headers: { authorization: headers.authorization } })
		if (!response.ok)
			throw new Error(`postboi/inspect: ${url.pathname} answered ${response.status}`)
		return response
	}

	async function share(choice: { revoke?: boolean } = {}): Promise<string | null> {
		if (choice.revoke) {
			await call(`${run_path}/share`, { method: "DELETE" })
			return (share_url = null)
		}
		const answer = await call<{ share_url: string }>(`${run_path}/share`, { method: "POST" })
		return (share_url = answer.share_url)
	}

	if (options.html !== undefined) {
		const pasted = await call<Partial<TestingRun>>(`${run_path}/source`, {
			method: "POST",
			body: JSON.stringify({ subject: options.subject, html: options.html, text: options.text }),
		})
		// A current server answers the paste with the whole run; an older one with just
		// `{ id, status }`, so the run is read back. Either way the report is on it.
		if (pasted?.screenshots) return decorate(pasted as TestingRun)
		return decorate(await call<TestingRun>(run_path))
	}

	return decorate({ id: created.id, status: "waiting" })
}
