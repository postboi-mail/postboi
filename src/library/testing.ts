/**
 * `postboi/testing`: helpers for testing code that sends, and for writing a provider.
 *
 * - {@link mock_fetch} answers HTTP requests with responses you script, and records them,
 *   so a provider runs end to end without the network.
 * - {@link sms_contract_cases} and {@link run_sms_contract} hold an SMS provider to what
 *   every one here promises: one request per send, the common result, an honest error for
 *   a refusal and for an unknown outcome, no request for a check or a refused option. For
 *   anyone writing their own `SmsProvider`; the ones postboi ships pass it.
 */
import { PostboiError } from "./errors.js"
import type { SmsProvider } from "./sms/provider.js"
import type { SmsDelivery, SmsReceipt } from "./sms/types.js"

/** One scripted answer: a status, and a body as JSON or as text. */
export interface MockResponse {
	/** HTTP status. Defaults to 200. */
	status?: number
	/** A body to send as JSON. */
	json?: unknown
	/** A body to send as it is, when it isn't JSON (SNS answers XML). */
	text?: string
	headers?: Record<string, string>
	/** Throw this instead of answering: a dropped connection, a DNS failure. */
	error?: Error
}

/** One request `mock_fetch` saw. */
export interface MockRequest {
	url: string
	method: string
	headers: Headers
	/** The body as sent, or "" for none. */
	body: string
	/** The body read as JSON. Throws if it isn't. */
	json(): unknown
	/** The body read as form fields, for a form-encoded request. */
	form(): URLSearchParams
}

/** A `fetch` that answers from a script, with what it was asked. */
export interface MockFetch {
	(input: string | URL | Request, init?: RequestInit): Promise<Response>
	/** Every request, in order. */
	readonly calls: Array<MockRequest>
	/**
	 * Put it in place of the global `fetch`, which is what every provider calls. Returns the
	 * function that puts the original back.
	 */
	install(): () => void
}

/**
 * A `fetch` that answers each request with the next scripted response, then keeps answering
 * with the last one; or a function that decides from the request. Nothing touches the
 * network.
 *
 * @example
 * ```ts
 * import { mock_fetch } from "postboi/testing"
 *
 * const fetch = mock_fetch([{ status: 201, json: { sid: "SM1", status: "queued" } }])
 * const restore = fetch.install()
 * await sms({ to: "+447700900123", message: "hi" })
 * expect(fetch.calls[0].form().get("Body")).toBe("hi")
 * restore()
 * ```
 */
export function mock_fetch(
	script: Array<MockResponse> | ((request: MockRequest) => MockResponse | Promise<MockResponse>)
): MockFetch {
	const calls: Array<MockRequest> = []
	const fake = async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const body =
			init.body === undefined || init.body === null
				? ""
				: typeof init.body === "string"
					? init.body
					: init.body instanceof URLSearchParams
						? init.body.toString()
						: await new Response(init.body).text()
		const request: MockRequest = {
			url,
			method: (init.method ?? "GET").toUpperCase(),
			headers: new Headers(init.headers),
			body,
			json: () => JSON.parse(body),
			form: () => new URLSearchParams(body),
		}
		calls.push(request)
		const answer =
			typeof script === "function"
				? await script(request)
				: (script[Math.min(calls.length - 1, script.length - 1)] ?? {})
		if (answer.error) throw answer.error
		const text = answer.text ?? (answer.json === undefined ? "" : JSON.stringify(answer.json))
		return new Response(text, {
			status: answer.status ?? 200,
			headers: {
				...(answer.json !== undefined ? { "content-type": "application/json" } : {}),
				...answer.headers,
			},
		})
	}
	return Object.assign(fake, {
		calls,
		install() {
			const original = globalThis.fetch
			globalThis.fetch = fake as typeof fetch
			return () => {
				globalThis.fetch = original
			}
		},
	})
}

/** What {@link sms_contract_cases} needs to know about the provider under test. */
export interface SmsContractFixtures {
	/** A number the provider will take as a recipient, in E.164. */
	to: string
	/** The provider's answer to an accepted send, as the real API gives it. */
	accepted: MockResponse
	/** The provider's answer to a refused send, if it has a body worth reading (a 400). */
	refused?: MockResponse
	/** The answer to a scheduled send, when it differs from `accepted`. */
	scheduled?: MockResponse
	/**
	 * A field of the provider's own request that the send sets (Twilio's `To`, Plivo's
	 * `dst`), which `provider_options` must not be able to overwrite. Without it, that case
	 * only checks a provider that takes no `provider_options` says so.
	 */
	reserved?: string
}

/** One named check, to run in any test framework (`for (const c of cases) it(c.name, c.run)`). */
export interface ContractCase {
	name: string
	run: () => Promise<void>
}

/** What {@link run_sms_contract} found. */
export interface ContractReport {
	ok: boolean
	passed: Array<string>
	failed: Array<{ name: string; error: string }>
}

const DELIVERIES: ReadonlyArray<SmsDelivery> = [
	"queued",
	"scheduled",
	"sent",
	"delivered",
	"unknown",
]

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

/** Run `body` with `script` installed as `fetch`, and hand it the calls. */
async function with_fetch<T>(
	script: Array<MockResponse>,
	body: (fetch: MockFetch) => Promise<T>
): Promise<T> {
	const fetch = mock_fetch(script)
	const restore = fetch.install()
	try {
		return await body(fetch)
	} finally {
		restore()
	}
}

/** The error `promise` rejects with, or a failure if it resolves. */
async function rejection(promise: Promise<unknown>, what: string): Promise<PostboiError> {
	try {
		await promise
	} catch (error) {
		assert(error instanceof PostboiError, `${what} threw something other than a PostboiError`)
		return error
	}
	throw new Error(`${what} resolved; it should have thrown`)
}

/**
 * The contract every SMS provider keeps, as cases to run. `make` builds a fresh provider for
 * each case, configured as a user would (credentials, a default `from`); the cases put a
 * scripted `fetch` in place of the network while they run.
 */
export function sms_contract_cases(
	make: () => SmsProvider<SmsReceipt>,
	fixtures: SmsContractFixtures
): Array<ContractCase> {
	const message = { to: fixtures.to, message: "contract test" }
	return [
		{
			name: "a send makes one request and answers with the common result",
			run: () =>
				with_fetch([fixtures.accepted], async (fetch) => {
					const provider = make()
					const receipt = await provider.send(message)
					assert(fetch.calls.length === 1, `made ${fetch.calls.length} requests, not 1`)
					assert(fetch.calls[0].url.startsWith("https://"), "the request isn't https")
					assert(typeof receipt.id === "string" && receipt.id !== "", "no id")
					assert(receipt.ids.includes(receipt.id), "ids doesn't include id")
					assert(typeof receipt.provider === "string" && receipt.provider !== "", "no provider")
					assert(DELIVERIES.includes(receipt.delivery), `delivery is ${receipt.delivery}`)
				}),
		},
		{
			name: "validate() asks nothing of the provider",
			run: () =>
				with_fetch([fixtures.accepted], async (fetch) => {
					const check = await make().validate(message)
					assert(check.ok, `validate() found ${JSON.stringify(check.issues)}`)
					assert(fetch.calls.length === 0, "validate() made a request")
				}),
		},
		{
			name: "a scheduled send is scheduled, or refused before any request",
			run: () =>
				with_fetch([fixtures.scheduled ?? fixtures.accepted], async (fetch) => {
					const scheduled_at = new Date(Date.now() + 3_600_000)
					let receipt: SmsReceipt
					try {
						receipt = await make().send({ ...message, scheduled_at })
					} catch (error) {
						assert(error instanceof PostboiError, "threw something other than a PostboiError")
						assert(
							["scheduling_not_supported", "scheduling_needs_service"].includes(String(error.code)),
							`refused with ${error.code}, not scheduling_not_supported`
						)
						assert(fetch.calls.length === 0, "made a request before refusing")
						return
					}
					assert(receipt.delivery === "scheduled", `a scheduled send answered ${receipt.delivery}`)
				}),
		},
		{
			name: "a refusal is a PostboiError with a reason, and not an unknown outcome",
			run: () =>
				with_fetch([fixtures.refused ?? { status: 400, json: {} }], async () => {
					const error = await rejection(make().send(message), "a 400")
					assert(!error.outcome_unknown, "a 400 was called an unknown outcome")
					assert(error.reason !== undefined, "a 400 has no reason")
				}),
		},
		{
			name: "a 401 is an auth refusal",
			run: () =>
				with_fetch([{ status: 401, json: {} }], async () => {
					const error = await rejection(make().send(message), "a 401")
					assert(error.reason === "auth", `a 401's reason is ${error.reason}, not auth`)
				}),
		},
		{
			name: "a 429 is rate_limited",
			run: () =>
				with_fetch([{ status: 429, json: {} }], async () => {
					const error = await rejection(make().send(message), "a 429")
					assert(
						error.reason === "rate_limited",
						`a 429's reason is ${error.reason}, not rate_limited`
					)
				}),
		},
		{
			name: "a 5xx is an unknown outcome, and isn't retried without a key",
			run: () =>
				with_fetch([{ status: 502, text: "Bad Gateway" }], async (fetch) => {
					const error = await rejection(make().send(message), "a 502")
					assert(error.outcome_unknown, "a 502 wasn't called an unknown outcome")
					assert(fetch.calls.length === 1, `a 502 was sent ${fetch.calls.length} times`)
				}),
		},
		{
			name: "a dropped connection is an unknown outcome",
			run: () =>
				with_fetch([{ error: new TypeError("fetch failed") }], async () => {
					const error = await rejection(make().send(message), "a dropped connection")
					assert(error.outcome_unknown, "a dropped connection wasn't called an unknown outcome")
				}),
		},
		{
			name: "provider_options can't overwrite what the send sets",
			run: () =>
				with_fetch([fixtures.accepted], async (fetch) => {
					const field = fixtures.reserved ?? "postboi_contract_probe"
					const check = await make().validate({
						...message,
						provider_options: { [field]: "+15550000000" },
					})
					const codes = check.issues.map((issue) => issue.code)
					if (codes.includes("provider_options_not_supported")) return
					if (fixtures.reserved) {
						assert(
							codes.includes("reserved_provider_option"),
							`provider_options naming ${field} wasn't refused`
						)
					}
					assert(fetch.calls.length === 0, "validate() made a request")
				}),
		},
	]
}

/**
 * Run {@link sms_contract_cases} and report, rather than throw: `ok` when every case passed.
 *
 * @example
 * ```ts
 * import { run_sms_contract } from "postboi/testing"
 *
 * const report = await run_sms_contract(() => new MyProvider({ api_key: "k", default: { from: "ACME" } }), {
 * 	to: "+447700900123",
 * 	accepted: { status: 200, json: { id: "m1" } },
 * })
 * expect(report.failed).toEqual([])
 * ```
 */
export async function run_sms_contract(
	make: () => SmsProvider<SmsReceipt>,
	fixtures: SmsContractFixtures
): Promise<ContractReport> {
	const report: ContractReport = { ok: true, passed: [], failed: [] }
	for (const contract of sms_contract_cases(make, fixtures)) {
		try {
			await contract.run()
			report.passed.push(contract.name)
		} catch (error) {
			report.ok = false
			report.failed.push({
				name: contract.name,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return report
}
