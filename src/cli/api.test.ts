import { describe, it, expect, vi, afterEach } from "vitest"
import { table, api_command } from "./api.js"

afterEach(() => vi.restoreAllMocks())

describe("table", () => {
	it("aligns columns ignoring ANSI colour codes", () => {
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		table(
			["NAME", "STATUS"],
			[
				["a", "\x1b[32mverified\x1b[0m"],
				["longer-name", "pending"],
			]
		)
		// Strip colours: every row's STATUS column starts at the same offset.
		// eslint-disable-next-line no-control-regex
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
		expect(plain[1].indexOf("verified")).toBe(plain[2].indexOf("pending"))
		expect(plain[0].indexOf("STATUS")).toBe(plain[2].indexOf("pending"))
	})
})

describe("api_command", () => {
	it("returns false for commands it doesn't own", async () => {
		expect(await api_command("init", [])).toBe(false)
		expect(await api_command("definitely-not-a-command", [])).toBe(false)
	})
})
