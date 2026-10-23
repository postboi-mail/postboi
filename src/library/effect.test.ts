import { describe, it, expect, vi, afterEach } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import Mock from "./mock.js"
import MockSms from "./sms/mock.js"
import { MailboxTimeoutError } from "./mailbox.js"
import {
	FailoverError,
	PostboiError as PostboiErrorClass,
	SkipSendError,
	SpamError,
	fails_over,
} from "./errors.js"
import { push } from "./push/send.js"
import { whatsapp } from "./whatsapp/send.js"
import {
	Mailer,
	PostboiError,
	SkipSend,
	Spam,
	SendRequest,
	decode_send_request,
	from_error,
	retryable,
	send_mail,
	send_options,
	send_sms,
	tried,
	validate_sms,
	with_retry,
} from "./effect.js"
import type { FromAddress } from "./index.js"

const FROM = "Tests <tests@example.com>" as FromAddress

describe("Mailer", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	// Made here rather than inside the test: a layer is built from the instance before
	// the test body runs, and the body reads the same instance back.
	const recording = new Mock({ default: { from: FROM } })

	it.effect("layerMock sends through the mock and records what went", () =>
		Effect.gen(function* () {
			const mock = recording
			const mailer = yield* Mailer
			const response = yield* mailer.send({
				to: "ada@example.com",
				subject: "Hi",
				body: "<p>Hello</p>",
			})
			expect(response).toMatchObject({ id: expect.any(String) })
			expect(mock.sent).toHaveLength(1)
			expect(mock.last?.to[0].address).toBe("ada@example.com")
			expect(mock.last?.subject).toBe("Hi")

			yield* mailer.cancel("msg_1")
			expect(mock.canceled).toEqual(["msg_1"])
		}).pipe(Effect.provide(Mailer.layerMock(recording)))
	)

	it.effect("layerMock without an instance still sends, to nowhere", () =>
		Effect.gen(function* () {
			const mailer = yield* Mailer
			const response = yield* mailer.send({ to: "ada@example.com", body: "<p>Hello</p>" })
			expect(response).toMatchObject({ id: expect.any(String) })
		}).pipe(Effect.provide(Mailer.layerMock()))
	)

	it.effect("a failing provider is a tagged PostboiError, not a defect", () =>
		Effect.gen(function* () {
			const mailer = yield* Mailer
			const error = yield* Effect.flip(mailer.send({ to: "ada@example.com", body: "<p>Hello</p>" }))
			expect(error._tag).toBe("PostboiError")
			expect(error).toBeInstanceOf(PostboiError)
			if (error._tag === "PostboiError") expect(error.provider).toBe("mock")
		}).pipe(Effect.provide(Mailer.layerMock(new Mock({ fail: true, default: { from: FROM } }))))
	)

	it.effect("layer reads POSTBOI_PROVIDER from Config and resolves through mail()'s rule", () =>
		Effect.gen(function* () {
			// The console mock announces every send; the test is about the choice, not the print.
			vi.spyOn(console, "log").mockImplementation(() => {})
			const mailer = yield* Mailer
			const response = yield* mailer.send({
				to: "ada@example.com",
				from: FROM,
				subject: "Hi",
				body: "<p>Hello</p>",
			})
			expect(response).toMatchObject({ id: expect.any(String) })
		}).pipe(
			Effect.provide(
				Mailer.layer.pipe(
					Layer.provide(
						ConfigProvider.layer(ConfigProvider.fromUnknown({ POSTBOI_PROVIDER: "mock" }))
					)
				)
			)
		)
	)

	it.effect("layer fails with the no_provider error when nothing is configured", () =>
		Effect.gen(function* () {
			vi.stubEnv("POSTBOI_PROVIDER", "")
			vi.stubEnv("POSTBOI_TOKEN", "")
			const error = yield* Effect.flip(Layer.build(Mailer.layer))
			expect(error._tag).toBe("PostboiError")
			if (error._tag === "PostboiError") expect(error.code).toBe("no_provider")
		}).pipe(Effect.scoped)
	)
})

describe("from_error", () => {
	// The last test stubs the environment; a failed assertion must not leak it.
	afterEach(() => vi.unstubAllEnvs())

	it.effect("maps a PostboiError onto the tagged error with every field", () =>
		Effect.gen(function* () {
			const thrown = new PostboiErrorClass({
				provider: "resend",
				message: "Rate limited",
				channel: "email",
				status: 429,
				code: "rate_limit",
				raw: { hint: "slow down" },
			})
			const error = yield* Effect.flip(from_error(thrown))
			expect(error).toBeInstanceOf(PostboiError)
			expect(error).toMatchObject({
				_tag: "PostboiError",
				message: "Rate limited",
				provider: "resend",
				channel: "email",
				status: 429,
				code: "rate_limit",
				raw: { hint: "slow down" },
			})
		})
	)

	it.effect("carries an unknown outcome and a refusal's reason across", () =>
		Effect.gen(function* () {
			const unknown = yield* Effect.flip(
				from_error(
					new PostboiErrorClass({ provider: "twilio", message: "timeout", outcome_unknown: true })
				)
			)
			expect(unknown).toMatchObject({ outcome_unknown: true, reason: undefined })
			const refused = yield* Effect.flip(
				from_error(
					new PostboiErrorClass({ provider: "twilio", message: "no", status: 401, reason: "auth" })
				)
			)
			expect(refused).toMatchObject({ outcome_unknown: false, reason: "auth" })
		})
	)

	it.effect("maps a failover chain's FailoverError with every provider's error", () =>
		Effect.gen(function* () {
			const chain = new FailoverError([
				new PostboiErrorClass({ provider: "twilio", message: "no", status: 401, reason: "auth" }),
				new PostboiErrorClass({
					provider: "puresms",
					message: "down",
					status: 503,
					outcome_unknown: true,
					retry_after: 9,
				}),
			])
			const error = yield* Effect.flip(from_error(chain))
			expect(error._tag).toBe("PostboiError")
			if (error._tag !== "PostboiError") return
			expect(error).toMatchObject({
				provider: "puresms",
				status: 503,
				outcome_unknown: true,
				retry_after: 9,
			})
			expect(error.errors?.map((e) => [e.provider, e.reason])).toEqual([
				["twilio", "auth"],
				["puresms", undefined],
			])
			expect(error.errors?.[0]).toBeInstanceOf(PostboiError)
		})
	)

	it.effect("carries Retry-After and a timed-out wait's cursor across", () =>
		Effect.gen(function* () {
			const limited = yield* Effect.flip(
				from_error(
					new PostboiErrorClass({
						provider: "resend",
						message: "slow down",
						status: 429,
						retry_after: 7,
					})
				)
			)
			expect(limited).toMatchObject({ status: 429, retry_after: 7, cursor: undefined })
			const waited = yield* Effect.flip(from_error(new MailboxTimeoutError("No mail", 41)))
			expect(waited).toMatchObject({
				_tag: "PostboiError",
				provider: "postboi",
				code: "timeout",
				status: 408,
				cursor: 41,
			})
		})
	)

	it.effect(
		"fails with the provider's error when its body's code is neither text nor a number",
		() =>
			Effect.gen(function* () {
				const thrown = new PostboiErrorClass({
					provider: "teams",
					message: "refused",
					status: 400,
					code: null as unknown as string,
				})
				const error = yield* Effect.flip(tried(() => Promise.reject(thrown)))
				expect(error).toMatchObject({ _tag: "PostboiError", status: 400, code: undefined })
			})
	)

	it("encodes to JSON with a thrown cause as raw", () => {
		const error = new PostboiError({
			provider: "resend",
			message: "resend request failed: fetch failed",
			outcome_unknown: true,
			raw: new TypeError("fetch failed"),
		})
		expect(Schema.encodeSync(Schema.toCodecJson(PostboiError))(error)).toMatchObject({
			outcome_unknown: true,
			raw: { name: "TypeError", message: "fetch failed" },
		})
	})

	it.effect("maps a SkipSendError onto SkipSend, keeping its code", () =>
		Effect.gen(function* () {
			const thrown = new SkipSendError("Unsubscribed", "unsubscribed")
			thrown.channel = "sms"
			const error = yield* Effect.flip(from_error(thrown))
			expect(error).toBeInstanceOf(SkipSend)
			expect(error).toMatchObject({ _tag: "SkipSend", code: "unsubscribed", channel: "sms" })
		})
	)

	it.effect("maps a SpamError onto Spam", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(from_error(new SpamError()))
			expect(error).toBeInstanceOf(Spam)
			expect(error._tag).toBe("Spam")
		})
	)

	it.effect("anything else is a defect", () =>
		Effect.gen(function* () {
			const boom = new Error("boom")
			const exit = yield* Effect.exit(from_error(boom))
			expect(Exit.isFailure(exit)).toBe(true)
			if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(boom)
		})
	)

	it.effect("tried wraps a promise the same way", () =>
		Effect.gen(function* () {
			const ok = yield* tried(async () => 42)
			expect(ok).toBe(42)
			const error = yield* Effect.flip(
				tried(async () => {
					throw new PostboiErrorClass({ provider: "x", message: "no" })
				})
			)
			expect(error._tag).toBe("PostboiError")
		})
	)

	it.effect("send_mail fails with the zero-config refusal when nothing is configured", () =>
		Effect.gen(function* () {
			vi.stubEnv("POSTBOI_PROVIDER", "")
			vi.stubEnv("POSTBOI_TOKEN", "")
			const error = yield* Effect.flip(send_mail({ to: "ada@example.com", body: "<p>Hi</p>" }))
			expect(error._tag).toBe("PostboiError")
			if (error._tag === "PostboiError") expect(error.code).toBe("no_provider")
		})
	)
})

describe("send_sms and validate_sms", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it.effect("send through the configured SMS provider and answer its receipt", () =>
		Effect.gen(function* () {
			vi.spyOn(console, "log").mockImplementation(() => {})
			vi.stubEnv("POSTBOI_SMS_PROVIDER", "mock")
			const receipt = yield* send_sms({ to: "+447700900123", from: "ACME", message: "Hi" })
			expect(receipt).toMatchObject({ id: expect.any(String), provider: "mock" })
			const check = yield* validate_sms({
				to: "07700 900123",
				from: "ACME",
				message: "Hi",
				country: "GB",
			})
			expect(check).toMatchObject({
				ok: true,
				to: ["+447700900123"],
				encoding: "gsm7",
				segments: 1,
			})
		})
	)
})

describe("SendRequest", () => {
	it.effect("decodes a request to send and turns it into send options", () =>
		Effect.gen(function* () {
			const request = yield* decode_send_request({
				to: ["ada@example.com", "Lin <lin@example.com>"],
				from: "Acme <hello@acme.example>",
				subject: "Welcome",
				html: "<p>Hi</p>",
				text: "Hi",
				reply_to: "support@acme.example",
				headers: { "X-Campaign": "welcome" },
				tags: ["onboarding"],
				idempotency_key: "welcome-42",
				in_reply_to: "in_123",
			})
			expect(request.to).toEqual(["ada@example.com", "Lin <lin@example.com>"])
			const options = send_options(request)
			expect(options).toEqual({
				body: "<p>Hi</p>",
				text: "Hi",
				to: ["ada@example.com", "Lin <lin@example.com>"],
				from: "Acme <hello@acme.example>",
				reply_to: "support@acme.example",
				subject: "Welcome",
				headers: { "X-Campaign": "welcome" },
				tags: ["onboarding"],
				idempotency_key: "welcome-42",
				in_reply_to: "in_123",
			})
			// What was handed in isn't what goes out: a caller may keep mutating their own.
			expect(options.tags).not.toBe(request.tags)
		})
	)

	it.effect("a text-only request sends its text as the body, escaped, line breaks kept", () =>
		Effect.gen(function* () {
			const request = yield* decode_send_request({ to: "ada@example.com", text: "Hi" })
			expect(send_options(request)).toEqual({ body: "Hi", text: "Hi", to: "ada@example.com" })
			// A string body is HTML to every provider, so what was typed must not become markup.
			const typed = yield* decode_send_request({ to: "ada@example.com", text: "1 < 2 & so\non" })
			expect(send_options(typed).body).toBe("1 &lt; 2 &amp; so<br>on")
			expect(send_options(typed).text).toBe("1 < 2 & so\non")
		})
	)

	it.effect("refuses an empty list of addresses", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(decode_send_request({ to: [], html: "<p>Hi</p>" }))
			expect(error.message).toMatch(/to/)
		})
	)

	it.effect("refuses a request with neither html nor text", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(decode_send_request({ to: "ada@example.com" }))
			expect(error.message).toContain("a send needs html or text")
			const blank = yield* Effect.flip(
				decode_send_request({ to: "ada@example.com", html: "", text: "" })
			)
			expect(blank.message).toContain("a send needs html or text")
			const fallback = yield* decode_send_request({ to: "ada@example.com", html: "", text: "Hi" })
			expect(send_options(fallback).body).toBe("Hi")
		})
	)

	it.effect("refuses an empty address and a wrongly typed field", () =>
		Effect.gen(function* () {
			const empty = yield* Effect.flip(decode_send_request({ to: "", html: "<p>Hi</p>" }))
			expect(empty.message).toMatch(/to/)
			const typed = yield* Effect.flip(
				decode_send_request({ to: "ada@example.com", html: "<p>Hi</p>", tags: "onboarding" })
			)
			expect(typed.message).toMatch(/tags/)
		})
	)

	it("is a plain Schema, so it can be used synchronously too", () => {
		expect(() => Schema.decodeUnknownSync(SendRequest)({ html: 1 })).toThrow()
		expect(Schema.decodeUnknownSync(SendRequest)({ html: "<p>Hi</p>" })).toEqual({
			html: "<p>Hi</p>",
		})
	})
})

describe("with_retry", () => {
	/** An effect that fails `failures` times with the given status, then succeeds. */
	function flaky(status: number, failures: number) {
		let attempts = 0
		const effect = Effect.suspend(() => {
			attempts += 1
			return attempts <= failures
				? Effect.fail(new PostboiError({ provider: "test", message: `HTTP ${status}`, status }))
				: Effect.succeed({ id: `msg_${attempts}` })
		})
		return { effect, attempts: () => attempts }
	}

	it.effect("retries a 503 with backoff and then succeeds", () =>
		Effect.gen(function* () {
			const { effect, attempts } = flaky(503, 2)
			const fiber = yield* Effect.forkChild(with_retry(effect, { times: 3, base: "500 millis" }))
			// 500ms before the second attempt, 1s before the third: the TestClock has to move
			// past both for the fiber to finish, which is what proves the backoff is real.
			yield* TestClock.adjust("500 millis")
			expect(attempts()).toBe(2)
			yield* TestClock.adjust("1 second")
			const response = yield* Fiber.join(fiber)
			expect(response).toEqual({ id: "msg_3" })
			expect(attempts()).toBe(3)
		})
	)

	it.effect("gives up after `times` more attempts", () =>
		Effect.gen(function* () {
			const { effect, attempts } = flaky(500, 10)
			const fiber = yield* Effect.forkChild(Effect.flip(with_retry(effect, { times: 2 })))
			yield* TestClock.adjust("2 seconds")
			const error = yield* Fiber.join(fiber)
			expect(error.status).toBe(500)
			expect(attempts()).toBe(3)
		})
	)

	it.effect("does not retry a 400", () =>
		Effect.gen(function* () {
			const { effect, attempts } = flaky(400, 10)
			const error = yield* Effect.flip(with_retry(effect, { times: 3 }))
			expect(error.status).toBe(400)
			expect(attempts()).toBe(1)
		})
	)

	it.effect("retries an unknown outcome only when told it is safe", () =>
		Effect.gen(function* () {
			let attempts = 0
			const unknown = Effect.suspend(() => {
				attempts += 1
				return attempts === 1
					? Effect.fail(
							new PostboiError({
								provider: "t",
								message: "HTTP 503",
								status: 503,
								outcome_unknown: true,
							})
						)
					: Effect.succeed({ id: "msg_2" })
			})
			yield* Effect.flip(with_retry(unknown, { times: 3 }))
			expect(attempts).toBe(1)

			attempts = 0
			const fiber = yield* Effect.forkChild(with_retry(unknown, { times: 3, retry_unknown: true }))
			yield* TestClock.adjust("500 millis")
			expect(yield* Fiber.join(fiber)).toEqual({ id: "msg_2" })
			expect(attempts).toBe(2)

			const dropped = new PostboiError({ provider: "t", message: "socket", outcome_unknown: true })
			expect(retryable(dropped)).toBe(false)
			expect(retryable(dropped, true)).toBe(true)
			const limited = new PostboiError({
				provider: "t",
				message: "",
				status: 429,
				outcome_unknown: true,
			})
			expect(retryable(limited)).toBe(true)
			const partial = new PostboiError({
				provider: "t",
				message: "",
				status: 207,
				outcome_unknown: true,
			})
			expect(retryable(partial, true)).toBe(false)
		})
	)

	it.effect("waits out a 429's Retry-After instead of the backoff, up to a minute", () =>
		Effect.gen(function* () {
			const text = new MockSms({
				default: { from: "ACME" },
				fail: [{ status: 429, reason: "rate_limited", retry_after: 3 }, null],
			})
			const fiber = yield* Effect.forkChild(
				with_retry(tried(() => text.send({ to: "+447700900123", message: "Hi" })))
			)
			yield* TestClock.adjust("2 seconds")
			expect(text.sent).toHaveLength(0)
			yield* TestClock.adjust("1 second")
			yield* Fiber.join(fiber)
			expect(text.sent).toHaveLength(1)

			let attempts = 0
			const for_an_hour = Effect.suspend(() => {
				attempts += 1
				return attempts === 1
					? Effect.fail(
							new PostboiError({ provider: "t", message: "", status: 429, retry_after: 3600 })
						)
					: Effect.succeed("sent")
			})
			const capped = yield* Effect.forkChild(with_retry(for_an_hour))
			yield* TestClock.adjust("59 seconds")
			expect(attempts).toBe(1)
			yield* TestClock.adjust("1 second")
			expect(yield* Fiber.join(capped)).toBe("sent")
		})
	)

	it.effect("backs off when a Retry-After asks for no wait, as the transport does", () =>
		Effect.gen(function* () {
			let attempts = 0
			const now = Effect.suspend(() => {
				attempts += 1
				return attempts === 1
					? Effect.fail(
							new PostboiError({ provider: "t", message: "", status: 429, retry_after: 0 })
						)
					: Effect.succeed("sent")
			})
			const fiber = yield* Effect.forkChild(with_retry(now))
			yield* TestClock.adjust("499 millis")
			expect(attempts).toBe(1)
			yield* TestClock.adjust("1 millis")
			expect(yield* Fiber.join(fiber)).toBe("sent")
		})
	)

	it.effect("does not retry a skip, a spam verdict or an error with no status", () =>
		Effect.gen(function* () {
			let attempts = 0
			const skipped = Effect.suspend(() => {
				attempts += 1
				return Effect.fail(new SkipSend({ message: "skipped", code: "skipped" }))
			})
			yield* Effect.flip(with_retry(skipped))
			expect(attempts).toBe(1)
			expect(retryable(new Spam({ message: "spam" }))).toBe(false)
			expect(retryable(new PostboiError({ provider: "x", message: "no provider" }))).toBe(false)
			expect(retryable(new PostboiError({ provider: "x", message: "", status: 429 }))).toBe(true)
		})
	)
})

describe("the root's channel helpers", () => {
	it("read the tagged PostboiError as they read the root's", () => {
		const tagged = (fields: Partial<ConstructorParameters<typeof PostboiError>[0]>) =>
			new PostboiError({ provider: "meta", message: "refused", outcome_unknown: false, ...fields })
		expect(whatsapp.closed(tagged({ code: "outside_window" }))).toBe(true)
		expect(whatsapp.closed(tagged({ code: "rate_limited" }))).toBe(false)
		expect(push.expired(tagged({ provider: "webpush", status: 410 }))).toBe(true)
		expect(push.expired(tagged({ provider: "postboi", status: 404 }))).toBe(false)
		expect(fails_over(tagged({ reason: "auth" }))).toBe(true)
		expect(fails_over(tagged({ reason: "auth", outcome_unknown: true }))).toBe(false)
		expect(whatsapp.closed({ code: "outside_window" })).toBe(false)
	})
})
