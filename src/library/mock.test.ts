import { describe, it, expect, beforeEach } from "vitest"
import Mock from "$library/mock.js"

describe("Mock provider", () => {
	let mail: Mock

	beforeEach(() => {
		mail = new Mock({ default: { from: "default@test.com", to: "default-to@test.com" } })
	})

	it("records a sent message", async () => {
		const result = await mail.send({
			to: "recipient@test.com",
			from: "sender@test.com",
			subject: "Hi",
			body: "<p>Hello</p>",
		})

		expect(mail.sent).toHaveLength(1)
		expect(result.id).toBe("mock-1")
		expect(mail.last?.to).toEqual([{ address: "recipient@test.com" }])
		expect(mail.last?.from).toEqual({ address: "sender@test.com" })
		expect(mail.last?.subject).toBe("Hi")
		expect(mail.last?.html).toBe("<p>Hello</p>")
	})

	it("applies defaults and increments ids", async () => {
		await mail.send({ body: "one" })
		await mail.send({ body: "two" })

		expect(mail.sent).toHaveLength(2)
		expect(mail.last?.to).toEqual([{ address: "default-to@test.com" }])
		expect(mail.last?.from).toEqual({ address: "default@test.com" })
		expect(mail.sent.map((m) => m.html)).toEqual(["one", "two"])
	})

	it("normalizes display-name addresses and multiple recipients", async () => {
		await mail.send({
			to: ["a@test.com", "Bee <b@test.com>"],
			from: "Sender <sender@test.com>",
			cc: "c@test.com",
			reply_to: "reply@test.com",
			body: "hi",
		})

		expect(mail.last?.to).toEqual([
			{ address: "a@test.com" },
			{ address: "b@test.com", name: "Bee" },
		])
		expect(mail.last?.from).toEqual({ address: "sender@test.com", name: "Sender" })
		expect(mail.last?.cc).toEqual([{ address: "c@test.com" }])
		expect(mail.last?.reply_to).toEqual([{ address: "reply@test.com" }])
	})

	it("applies cc/bcc/reply_to from the default object", async () => {
		const withDefaults = new Mock({
			default: {
				from: "from@test.com",
				to: "to@test.com",
				cc: "cc@test.com",
				bcc: ["b1@test.com", "b2@test.com"],
				reply_to: "reply@test.com",
			},
		})
		await withDefaults.send({ body: "hi" })

		expect(withDefaults.last?.from).toEqual({ address: "from@test.com" })
		expect(withDefaults.last?.cc).toEqual([{ address: "cc@test.com" }])
		expect(withDefaults.last?.bcc).toEqual([{ address: "b1@test.com" }, { address: "b2@test.com" }])
		expect(withDefaults.last?.reply_to).toEqual([{ address: "reply@test.com" }])
	})

	it("lets an explicit field override its default", async () => {
		const withDefaults = new Mock({ default: { from: "from@test.com", to: "default@test.com" } })
		await withDefaults.send({ to: "override@test.com", body: "hi" })

		expect(withDefaults.last?.to).toEqual([{ address: "override@test.com" }])
	})

	it("renders FormData into the recorded html body", async () => {
		const form = new FormData()
		form.append("_to", "form@test.com")
		form.append("name", "Darby")
		await mail.send({ body: form })

		expect(mail.last?.to).toEqual([{ address: "form@test.com" }])
		expect(mail.last?.html).toContain("Darby")
	})

	it("captures attachments as base64", async () => {
		await mail.send({
			to: "a@test.com",
			from: "b@test.com",
			body: "hi",
			attachments: new File(["content"], "note.txt", { type: "text/plain" }),
		})

		expect(mail.last?.attachments).toHaveLength(1)
		expect(mail.last?.attachments[0]).toEqual({
			name: "note.txt",
			content: Buffer.from("content").toString("base64"),
			mime_type: "text/plain",
		})
	})

	it("clear() forgets captured messages", async () => {
		await mail.send({ to: "a@test.com", from: "b@test.com", body: "hi" })
		mail.clear()
		expect(mail.sent).toHaveLength(0)
		expect(mail.last).toBeUndefined()
	})

	it("still validates missing recipient/sender", async () => {
		const bare = new Mock()
		await expect(bare.send({ from: "a@test.com", body: "hi" })).rejects.toThrow(/recipient/)
		await expect(bare.send({ to: "a@test.com", body: "hi" })).rejects.toThrow(/sender/)
	})

	it("simulates failures when constructed with fail: true", async () => {
		const failing = new Mock({ fail: true })
		const error = await failing
			.send({ to: "a@test.com", from: "b@test.com", body: "hi" })
			.catch((e) => e)
		expect(failing.is_error(error)).toBe(true)
		expect(failing.sent).toHaveLength(0)
	})
})
