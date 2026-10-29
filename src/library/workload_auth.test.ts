import { afterEach, describe, expect, it, vi } from "vitest"
import { workload_token } from "./workload_auth.js"
import Postboi from "./postboi_provider.js"
import { mailbox } from "./mailbox.js"
import { mail } from "./mail.js"

let counter = 0
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

function setup(scope: "team" | "mailbox" = "team") {
	const env: Record<string, string | undefined> = {
		POSTBOI_WORKLOAD_ID: `wl_test${++counter}`,
		GITHUB_ACTIONS: "true",
		ACTIONS_ID_TOKEN_REQUEST_URL:
			"https://pipelines.actions.githubusercontent.com/job/idtoken?api-version=2",
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: `runner-token-${counter}`,
		GITHUB_REPOSITORY_ID: "123",
		GITHUB_REPOSITORY_OWNER_ID: "456",
		GITHUB_REF: "refs/heads/main",
		GITHUB_RUN_ID: String(counter),
		GITHUB_JOB: "send",
		POSTBOI_TOKEN: undefined,
		POSTBOI_MAILBOX_KEY: undefined,
		POSTBOI_API_URL: undefined,
		POSTBOI_AUTH_URL: undefined,
	}
	let now = Date.now(),
		issued = 0
	vi.spyOn(Date, "now").mockImplementation(() => now)
	const calls: Array<{ url: URL; headers: Headers; body?: string }> = []
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString())
		calls.push({
			url,
			headers: new Headers(init?.headers),
			body: init?.body ? String(init.body) : undefined,
		})
		if (url.hostname.endsWith(".actions.githubusercontent.com"))
			return Response.json({ value: "signed.github.assertion" })
		if (url.pathname === "/v1/auth/token") {
			issued++
			return Response.json({
				token_type: "Bearer",
				issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
				access_token: `${scope === "team" ? "pb" : "mb"}_issued${issued}`,
				workload_id: env.POSTBOI_WORKLOAD_ID,
				account_id: "acct_team",
				expires_in: 3600,
				scope,
				...(scope === "mailbox"
					? { mailbox: { id: "mbx_orders", address: "orders@agentboi.email" } }
					: {}),
			})
		}
		if (url.pathname === "/v1/send") return Response.json({ id: "msg_test" })
		if (url.pathname === "/v1/mailboxes")
			return Response.json({
				id: "mbx_orders",
				address: "orders@agentboi.email",
				domain: "agentboi.email",
				name: "Orders",
				key_prefix: "mb_issued",
				claimed: true,
				created: "2026-10-01T00:00:00.000Z",
				count: 0,
				cursor: 0,
				urls: { messages: "", wait: "", threads: "", send: "" },
			})
		if (url.pathname.endsWith("/messages")) return Response.json({ data: [], cursor: 0 })
		return new Response("Unexpected request", { status: 500 })
	}
	const get = (name: string) => env[name]
	const activate = () => {
		for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
		vi.spyOn(globalThis, "fetch").mockImplementation(fetcher)
	}
	return {
		env,
		get,
		fetcher,
		calls,
		activate,
		advance: (ms: number) => {
			now += ms
		},
		issued: () => issued,
	}
}

describe("GitHub workload credentials", () => {
	it("shares concurrent exchanges, binds the audience, and refreshes before expiry", async () => {
		const s = setup()
		const tokens = await Promise.all(
			Array.from({ length: 8 }, () => workload_token("https://postboi.app", s.fetcher, s.get))
		)
		expect(s.issued()).toBe(1)
		expect(tokens.every((token) => token?.access_token === "pb_issued1")).toBe(true)
		expect(s.calls[0].url.searchParams.get("audience")).toBe(
			`https://postboi.app/workloads/${s.env.POSTBOI_WORKLOAD_ID}`
		)
		expect(s.calls[0].headers.get("authorization")).toContain("runner-token-")
		expect(s.calls[1].headers.has("authorization")).toBe(false)
		expect(JSON.parse(s.calls[1].body!)).toMatchObject({
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: "signed.github.assertion",
		})
		s.advance(3481_000)
		expect((await workload_token("https://postboi.app", s.fetcher, s.get))?.access_token).toBe(
			"pb_issued2"
		)
		s.env.GITHUB_RUN_ID = "other-run"
		await workload_token("https://postboi.app", s.fetcher, s.get)
		expect(s.issued()).toBe(3)
	})

	it("fails closed outside Actions, without permission, or with an untrusted runner URL", async () => {
		const s = setup()
		s.env.GITHUB_ACTIONS = "false"
		await expect(workload_token("https://postboi.app", s.fetcher, s.get)).rejects.toMatchObject({
			code: "workload_auth_failed",
		})
		s.env.GITHUB_ACTIONS = "true"
		s.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = undefined
		await expect(workload_token("https://postboi.app", s.fetcher, s.get)).rejects.toThrow(
			"id-token: write"
		)
		s.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner"
		s.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://attacker.test/idtoken"
		await expect(workload_token("https://postboi.app", s.fetcher, s.get)).rejects.toThrow(
			"supported GitHub Actions host"
		)
		expect(s.calls).toHaveLength(0)
	})

	it("does not cache a synchronous transport failure forever", async () => {
		const s = setup()
		const broken: typeof fetch = () => {
			throw new Error("offline")
		}
		await expect(workload_token("https://postboi.app", broken, s.get)).rejects.toMatchObject({
			code: "workload_auth_failed",
		})
		expect((await workload_token("https://postboi.app", s.fetcher, s.get))?.access_token).toBe(
			"pb_issued1"
		)
	})

	it("mail() and reusable Postboi providers obtain and refresh team email credentials", async () => {
		const s = setup()
		s.activate()
		await mail({ to: "a@example.com", subject: "CI", text: "Hello" })
		const provider = new Postboi()
		await provider.send({ to: "a@example.com", subject: "CI", text: "Hello" })
		s.advance(3481_000)
		await provider.send({ to: "a@example.com", subject: "CI", text: "Hello" })
		expect(
			s.calls
				.filter((call) => call.url.pathname === "/v1/send")
				.map((call) => call.headers.get("authorization"))
		).toEqual(["Bearer pb_issued1", "Bearer pb_issued1", "Bearer pb_issued2"])
		expect(s.env.POSTBOI_TOKEN).toBeUndefined()
	})

	it("mailbox() uses and refreshes its scoped key while mail() rejects mailbox authority", async () => {
		const s = setup("mailbox")
		s.activate()
		const box = await mailbox({ remember: false })
		expect(box.address).toBe("orders@agentboi.email")
		await box.list()
		s.advance(3481_000)
		await box.list()
		expect(
			s.calls
				.filter((call) => call.url.pathname.endsWith("/messages"))
				.map((call) => call.headers.get("authorization"))
		).toEqual(["Bearer mb_issued1", "Bearer mb_issued2"])
		expect(
			s.calls
				.filter((call) => call.url.pathname === "/v1/auth/token")
				.every((call) => call.url.origin === "https://postboi.app")
		).toBe(true)
		await expect(
			new Postboi().send({ to: "a@example.com", subject: "No", text: "No" })
		).rejects.toMatchObject({ code: "workload_scope" })
		await expect(mailbox.create({ remember: false })).rejects.toMatchObject({
			code: "workload_scope",
		})
	})

	it("a team workload opens an existing mailbox and never tries to make one", async () => {
		const s = setup()
		s.activate()
		const posts: Array<string> = []
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString())
			if (url.pathname === "/v1/mailboxes") {
				if (init?.method === "POST") posts.push(url.pathname)
				return Response.json({ data: [] })
			}
			return s.fetcher(input, init)
		})
		await expect(mailbox({ remember: false })).rejects.toMatchObject({ code: "workload_scope" })
		expect(posts).toEqual([])
	})

	it("explicit keys take precedence and never request workload identity", async () => {
		const s = setup()
		s.activate()
		await new Postboi({ token: "pb_explicit" }).send({
			to: "a@example.com",
			subject: "CI",
			text: "Hello",
		})
		expect(s.issued()).toBe(0)
		expect(s.calls[0].headers.get("authorization")).toBe("Bearer pb_explicit")
	})
})
