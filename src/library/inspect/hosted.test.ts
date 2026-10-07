import { describe, it, expect } from "vitest"
import { hosted_test, screenshots_settled } from "./hosted.js"

type Recorded = { path: string; method: string; headers: Record<string, string>; body?: unknown }

/** A fetch stub that answers from a script of responses and records every call. */
function stub_api(answers: Array<unknown>) {
	const calls: Array<Recorded> = []
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input))
		calls.push({
			path: url.pathname,
			method: init?.method ?? "GET",
			headers: Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
					k.toLowerCase(),
					v,
				])
			),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		})
		const answer = answers.shift()
		if (answer instanceof Response) return answer
		return new Response(JSON.stringify(answer), {
			headers: { "content-type": "application/json" },
		})
	}) as typeof fetch
	return { calls, fetcher }
}

const CREATED = { id: "run_1", address: "acme+test-abc@send.postboi.email" }

describe("hosted_test", () => {
	it("refuses to run without a token", async () => {
		await expect(
			hosted_test({ html: "<p>hi</p>", token: undefined, api: "https://x" })
		).rejects.toThrow(/POSTBOI_TOKEN/)
	})

	it("pastes HTML and returns the finished run in one call", async () => {
		const report = { status: "warning", findings: [{ id: "missing_plain_text" }] }
		const { calls, fetcher } = stub_api([
			CREATED,
			{ ok: true },
			{
				id: "run_1",
				status: "received",
				report,
				previews: [{ client: "gmail", name: "Gmail", status: "pending" }],
			},
		])

		const test = await hosted_test({
			html: "<p>hi</p>",
			text: "hi",
			subject: "Welcome v3",
			clients: ["gmail"],
			token: "tok",
			api: "https://api.test/",
			fetch: fetcher,
		})

		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /v1/testing",
			"POST /v1/testing/run_1/source",
			"GET /v1/testing/run_1",
		])
		expect(calls[0].headers.authorization).toBe("Bearer tok")
		expect(calls[0].body).toEqual({ label: "Welcome v3", clients: ["gmail"] })
		expect(calls[1].body).toEqual({ subject: "Welcome v3", html: "<p>hi</p>", text: "hi" })

		expect(test.id).toBe("run_1")
		expect(test.url).toBe("https://api.test/dashboard/testing/run_1")
		expect(test.status).toBe("received")
		expect(test.report).toEqual(report)
		expect(test.previews).toHaveLength(1)
	})

	it("prefers an explicit label over the subject", async () => {
		const { calls, fetcher } = stub_api([
			CREATED,
			{ ok: true },
			{ id: "run_1", status: "received" },
		])
		await hosted_test({
			html: "<p>hi</p>",
			subject: "Welcome",
			label: "welcome v3",
			token: "tok",
			api: "https://api.test",
			fetch: fetcher,
		})
		expect(calls[0].body).toEqual({ label: "welcome v3" })
	})

	it("mints an address and wait() polls the run home", async () => {
		const { calls, fetcher } = stub_api([
			CREATED,
			{ id: "run_1", status: "waiting" },
			{
				id: "run_1",
				status: "received",
				authentication: { spf: "pass" },
				spam: { score: 0.1, rules: [] },
			},
		])

		const test = await hosted_test({
			label: "welcome",
			token: "tok",
			api: "https://api.test",
			fetch: fetcher,
		})
		expect(test.status).toBe("waiting")
		expect(test.address).toBe(CREATED.address)
		expect(calls).toHaveLength(1) // no source paste, no premature poll

		const done = await test.wait({ poll_ms: 1 })
		expect(done.status).toBe("received")
		expect(done.authentication?.spf).toBe("pass")
		expect(done.spam?.score).toBe(0.1)
		expect(test.status).toBe("waiting") // the original object is left as it was
	})

	it("wait() gives up at the deadline", async () => {
		const { fetcher } = stub_api([
			CREATED,
			{ id: "run_1", status: "waiting" },
			{ id: "run_1", status: "waiting" },
		])
		const test = await hosted_test({ token: "tok", api: "https://api.test", fetch: fetcher })
		await expect(test.wait({ poll_ms: 1, timeout_ms: 0 })).rejects.toThrow(/no email arrived/)
	})

	it("reports the failing path and status on an API error", async () => {
		const { fetcher } = stub_api([new Response("nope", { status: 402 })])
		await expect(
			hosted_test({ html: "<p>hi</p>", token: "tok", api: "https://api.test", fetch: fetcher })
		).rejects.toThrow(/\/v1\/testing answered 402/)
	})

	it("takes a current server's paste answer whole, with set, fresh and the team's url", async () => {
		const run = {
			id: "run_1",
			status: "received",
			url: "https://api.test/dashboard/acc_1/testing/run_1",
			series_id: "run_0",
			screenshots: { state: "rendering", total: 1, ready: 0, failed: 0, pending: 1, notes: [] },
			previews: [{ id: "prev_1", client_id: "gmail", client_name: "Gmail", status: "pending" }],
		}
		const { calls, fetcher } = stub_api([{ ...CREATED, renders: { left: 40 } }, run])
		const test = await hosted_test({
			html: "<p>hi</p>",
			set: "Core",
			fresh: true,
			token: "tok",
			api: "https://api.test",
			fetch: fetcher,
		})
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /v1/testing",
			"POST /v1/testing/run_1/source",
		])
		expect(calls[0].body).toEqual({ set: "Core", fresh: true })
		expect(test.url).toBe("https://api.test/dashboard/acc_1/testing/run_1")
		expect(test.series_id).toBe("run_0")
		expect(test.renders).toEqual({ left: 40, used: undefined })
		// Both naming schemes, whichever the server sent.
		expect(test.previews[0]).toMatchObject({ client: "gmail", name: "Gmail", client_id: "gmail" })
	})

	it("wait({ screenshots: true }) polls past the email until every capture has settled", async () => {
		const summary = (pending: number) => ({
			state: pending ? "rendering" : "done",
			total: 1,
			ready: 1 - pending,
			failed: 0,
			pending,
			notes: [],
		})
		const { calls, fetcher } = stub_api([
			CREATED,
			{ id: "run_1", status: "received", screenshots: summary(1), previews: [] },
			{
				id: "run_1",
				status: "received",
				screenshots: summary(0),
				previews: [
					{
						id: "prev_1",
						client_id: "gmail",
						client_name: "Gmail",
						status: "ready",
						url: "/v1/testing/run_1/previews/prev_1",
					},
				],
			},
			new Response(new Uint8Array([137, 80]), { headers: { "content-type": "image/png" } }),
			{ share_url: "https://api.test/share/testing/tok_1" },
		])
		const test = await hosted_test({ token: "tok", api: "https://api.test", fetch: fetcher })
		const done = await test.wait({ screenshots: true, poll_ms: 1 })
		expect(done.screenshots?.state).toBe("done")
		expect(done.previews[0].url).toBe("https://api.test/v1/testing/run_1/previews/prev_1")

		const image = await done.capture(done.previews[0], { width: 480 })
		expect(image.headers.get("content-type")).toBe("image/png")
		expect(calls[3].path).toBe("/v1/testing/run_1/previews/prev_1")
		expect(calls[3].headers.authorization).toBe("Bearer tok")

		expect(await done.share()).toBe("https://api.test/share/testing/tok_1")
		expect(calls[4].method).toBe("POST")
		expect(calls[4].path).toBe("/v1/testing/run_1/share")
	})

	it("capture() refuses a preview that has nothing to fetch yet", async () => {
		const { fetcher } = stub_api([CREATED])
		const test = await hosted_test({ token: "tok", api: "https://api.test", fetch: fetcher })
		await expect(test.capture({ client_name: "Gmail", status: "pending" })).rejects.toThrow(
			/Gmail has no capture yet/
		)
	})
})

describe("screenshots_settled", () => {
	const received = { id: "run_1", status: "received" as const }

	it("trusts a current server's summary", () => {
		const summary = { total: 1, ready: 0, failed: 0, pending: 1, notes: [] }
		expect(
			screenshots_settled({ ...received, screenshots: { ...summary, state: "rendering" } }, 0)
		).toBe(false)
		expect(
			screenshots_settled({ ...received, screenshots: { ...summary, state: "submitting" } }, 0)
		).toBe(false)
		expect(
			screenshots_settled({ ...received, screenshots: { ...summary, state: "done" } }, 0)
		).toBe(true)
		expect(
			screenshots_settled({ ...received, screenshots: { ...summary, state: "disabled" } }, 0)
		).toBe(true)
	})

	it("on an older server, waits for rows, then for none pending, with a grace for no rows", () => {
		expect(screenshots_settled({ id: "run_1", status: "waiting" }, 999_999)).toBe(false)
		expect(screenshots_settled(received, 0)).toBe(false)
		expect(screenshots_settled(received, 120_000)).toBe(true)
		expect(screenshots_settled({ ...received, previews: [{ status: "pending" }] }, 999_999)).toBe(
			false
		)
		expect(
			screenshots_settled({ ...received, previews: [{ status: "ready" }, { status: "failed" }] }, 0)
		).toBe(true)
	})
})
