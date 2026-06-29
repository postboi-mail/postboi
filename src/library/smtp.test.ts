import { describe, it, expect, afterEach } from "vitest"
import net from "node:net"
import SMTP from "$library/smtp.js"
import { PostboiError } from "$library/index.js"

/**
 * A throwaway plaintext SMTP server that walks the lock-step conversation and captures the
 * DATA payload. No STARTTLS/AUTH advertised, so the unauthenticated path is exercised.
 */
function fake_server(): Promise<{ port: number; data: () => string; close: () => void }> {
	let captured = ""
	const server = net.createServer((socket) => {
		let in_data = false
		socket.setEncoding("utf8")
		socket.on("error", () => {}) // client destroys the socket on QUIT; ignore the reset
		socket.write("220 test ready\r\n")
		let buffer = ""
		socket.on("data", (chunk: string) => {
			buffer += chunk
			let nl: number
			while ((nl = buffer.indexOf("\r\n")) !== -1) {
				const line = buffer.slice(0, nl)
				buffer = buffer.slice(nl + 2)
				if (in_data) {
					if (line === ".") {
						in_data = false
						socket.write("250 OK: queued as ABC123\r\n")
					} else {
						captured += line + "\n"
					}
					continue
				}
				if (line.startsWith("EHLO")) socket.write("250 test\r\n")
				else if (line.startsWith("MAIL FROM")) socket.write("250 ok\r\n")
				else if (line.startsWith("RCPT TO")) socket.write("250 ok\r\n")
				else if (line === "DATA") {
					in_data = true
					socket.write("354 go ahead\r\n")
				} else if (line === "QUIT") socket.write("221 bye\r\n")
				else socket.write("250 ok\r\n")
			}
		})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as net.AddressInfo).port
			resolve({ port, data: () => captured, close: () => server.close() })
		})
	})
}

let srv: Awaited<ReturnType<typeof fake_server>> | undefined
afterEach(() => srv?.close())

describe("SMTP", () => {
	it("delivers a multipart message over the SMTP conversation", async () => {
		srv = await fake_server()
		const mail = new SMTP({ host: "127.0.0.1", port: srv.port, default: { from: "from@test.com" } })

		const result = await mail.send({
			to: "to@test.com",
			cc: "cc@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
		})

		expect(result).toEqual({ response: "OK: queued as ABC123" })
		const data = srv.data()
		expect(data).toContain("From: from@test.com")
		expect(data).toContain("To: to@test.com")
		expect(data).toContain("Cc: cc@test.com")
		expect(data).toContain("Subject: Hi")
		expect(data).toContain("multipart/alternative")
		expect(data).toContain("text/plain; charset=utf-8")
		expect(data).toContain("text/html; charset=utf-8")
		// bodies are base64 (CTE base64) — "x" and "<p>x</p>"
		expect(data).toContain(Buffer.from("x").toString("base64"))
		expect(data).toContain(Buffer.from("<p>x</p>").toString("base64"))
	})

	it("RFC 2047-encodes a non-ASCII subject and strips header injection", async () => {
		srv = await fake_server()
		const mail = new SMTP({ host: "127.0.0.1", port: srv.port, default: { from: "from@test.com" } })
		await mail.send({ to: "to@test.com", subject: "Héllo\r\nBcc: evil@test.com", body: "x" })
		const data = srv.data()
		// each of CR and LF is replaced with a space, so the injected newline becomes two spaces
		expect(data).toContain(
			`=?UTF-8?B?${Buffer.from("Héllo  Bcc: evil@test.com").toString("base64")}?=`
		)
		// the injected CRLF must not have produced a real Bcc header line
		expect(data).not.toMatch(/^Bcc: evil@test\.com$/m)
	})

	it("refuses to send credentials over an unencrypted connection", async () => {
		srv = await fake_server()
		const mail = new SMTP({
			host: "127.0.0.1",
			port: srv.port,
			user: "u",
			pass: "p",
			default: { from: "from@test.com" },
		})
		const error = await mail.send({ to: "to@test.com", body: "x" }).catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.code).toBe("insecure_auth")
	})

	it("wraps a connection failure in a PostboiError", async () => {
		const mail = new SMTP({
			host: "127.0.0.1",
			port: 1,
			timeout: 500,
			default: { from: "from@test.com" },
		})
		const error = await mail.send({ to: "to@test.com", body: "x" }).catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.provider).toBe("smtp")
		expect(error.message).toContain("connection failed")
	})
})
