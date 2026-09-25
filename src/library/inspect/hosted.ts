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
	/** API token. Defaults to the `POSTBOI_TOKEN` environment variable. */
	token?: string
	/** API base. Defaults to `POSTBOI_API_URL` or `https://postboi.app`. */
	api?: string
	/** The fetch to use — inject a stub in tests. Defaults to the platform's. */
	fetch?: typeof globalThis.fetch
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
	previews: Array<{ client: string; name: string; status: string }>
	/**
	 * Poll until the run's email arrives (or the run expires — check `status`).
	 * Answers the finished run; the object it's called on is left as it was.
	 */
	wait(options?: { poll_ms?: number; timeout_ms?: number }): Promise<HostedTest>
}

interface RunAnswer {
	id: string
	status: "waiting" | "received" | "expired"
	report?: Report | null
	spam?: HostedTest["spam"] | null
	authentication?: HostedTest["authentication"]
	previews?: Array<{ client: string; name: string; status: string }>
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
		if (!response.ok) throw new Error(`postboi/inspect: ${path} answered ${response.status}`)
		return (await response.json()) as T
	}

	const created = await call<{ id: string; address: string }>("/v1/testing", {
		method: "POST",
		body: JSON.stringify({
			label: options.series ? undefined : (options.label ?? options.subject),
			series: options.series,
			clients: options.clients,
		}),
	})
	const url = `${api}/dashboard/testing/${created.id}`

	function decorate(run: RunAnswer): HostedTest {
		return {
			id: created.id,
			url,
			address: created.address,
			status: run.status,
			report: run.report ?? undefined,
			spam: run.spam ?? undefined,
			authentication: run.authentication,
			previews: run.previews ?? [],
			wait,
		}
	}

	async function wait(poll: { poll_ms?: number; timeout_ms?: number } = {}): Promise<HostedTest> {
		const poll_ms = poll.poll_ms ?? 5000
		const deadline = Date.now() + (poll.timeout_ms ?? 120_000)
		for (;;) {
			const run = await call<RunAnswer>(`/v1/testing/${created.id}`)
			if (run.status !== "waiting") return decorate(run)
			if (Date.now() >= deadline) {
				throw new Error(`postboi/inspect: no email arrived for ${created.id} in time`)
			}
			await new Promise((resolve) => setTimeout(resolve, poll_ms))
		}
	}

	if (options.html !== undefined) {
		await call(`/v1/testing/${created.id}/source`, {
			method: "POST",
			body: JSON.stringify({ subject: options.subject, html: options.html, text: options.text }),
		})
		// The paste ingests synchronously — the report is on the run already.
		return decorate(await call<RunAnswer>(`/v1/testing/${created.id}`))
	}

	return decorate({ id: created.id, status: "waiting" })
}
