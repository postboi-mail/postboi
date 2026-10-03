import { describe, it, expect, vi, afterEach } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import Mock from "./mock.js"
import { PostboiError as PostboiErrorClass, SkipSendError, SpamError } from "./errors.js"
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
	tried,
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
			vi.unstubAllEnvs()
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
			})
			// What was handed in isn't what goes out: a caller may keep mutating their own.
			expect(options.tags).not.toBe(request.tags)
		})
	)

	it.effect("a text-only request sends its text as the body", () =>
		Effect.gen(function* () {
			const request = yield* decode_send_request({ to: "ada@example.com", text: "Hi" })
			expect(send_options(request)).toEqual({ body: "Hi", text: "Hi", to: "ada@example.com" })
		})
	)

	it.effect("refuses a request with neither html nor text", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(decode_send_request({ to: "ada@example.com" }))
			expect(error.message).toContain("a send needs html or text")
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
