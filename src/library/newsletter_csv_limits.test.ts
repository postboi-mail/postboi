import { expect, test } from "vitest"
import { parse_csv, CsvLimitError } from "./newsletter_csv.js"
import { parse_newsletter_csv } from "./newsletter_import_rules.js"
const limits = { columns: 100, rows: 10001, cell: 20000 }

test("bounded CSV keeps quoted delimiters, multiline cells and exact supported boundaries", () => {
	expect(parse_csv('email,name\r\nreader@example.test,"A, ""quoted""\nname"', limits)[1]).toEqual([
		"reader@example.test",
		'A, "quoted"\nname',
	])
	expect(parse_csv(Array(100).fill("x").join(","), limits)[0]).toHaveLength(100)
	expect(parse_csv("x".repeat(20000), limits)[0][0]).toHaveLength(20000)
	expect(parse_csv("email\n" + "reader@example.test\n".repeat(10000), limits)).toHaveLength(10001)
})

test("CSV allocation bounds reject excessive cells, rows and fields before building the full parsed table", () => {
	for (const csv of [
		"x,".repeat(1_000_000),
		"email\n" + "reader@example.test\n".repeat(10001),
		'email,name\nreader@example.test,"' + "x".repeat(20001) + '"',
	])
		expect(() => parse_csv(csv, limits)).toThrow(CsvLimitError)
	const options = { default_status: "pending" as const, consent_confirmed: false }
	expect(
		parse_newsletter_csv("email,name\nreader@example.test," + "x".repeat(20001), options)
	).toEqual({ error: "Keep each CSV field under 20,000 characters." })
	expect(parse_newsletter_csv("email," + ",".repeat(1_000_000), options)).toEqual({
		error: "Include at most 100 columns per row.",
	})
	// Ordinary composer callers retain their existing unlimited parser contract.
	expect(parse_csv(Array(101).fill("x").join(","))[0]).toHaveLength(101)
})
