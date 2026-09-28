import { describe, expect, test } from "bun:test"
import {
	compare_versions,
	parse_version,
	plan,
	publish_body,
	publish_outcome,
	store_version,
	upload_outcome,
} from "./store_rules.js"

const revision = (crxVersion, state = "PUBLISHED") => ({
	state,
	distributionChannels: [{ crxVersion, deployPercentage: 100 }],
})

describe("versions", () => {
	test("what the store accepts", () => {
		expect(parse_version("0.1.0")).toEqual([0, 1, 0])
		expect(parse_version("1.2.3.4")).toEqual([1, 2, 3, 4])
		expect(parse_version("1.2.3.4.5")).toBeUndefined()
		expect(parse_version("1.0-beta")).toBeUndefined()
		expect(parse_version("70000")).toBeUndefined()
	})
	test("compares numerically, missing parts as 0", () => {
		expect(compare_versions("0.10.0", "0.9.0")).toBeGreaterThan(0)
		expect(compare_versions("1.0", "1.0.0")).toBe(0)
		expect(compare_versions("1.0.1", "1.0.1.1")).toBeLessThan(0)
	})
	test("the store's version is the highest of submitted and published", () => {
		expect(
			store_version({
				publishedItemRevisionStatus: revision("0.1.0"),
				submittedItemRevisionStatus: revision("0.2.0", "PENDING_REVIEW"),
			})
		).toBe("0.2.0")
		expect(store_version({})).toBeUndefined()
	})
})

describe("plan", () => {
	test("a first package uploads", () => {
		expect(plan("0.1.0", {})).toMatchObject({ upload: true, fail: false })
	})
	test("a bumped version uploads", () => {
		expect(plan("0.1.1", { publishedItemRevisionStatus: revision("0.1.0") })).toMatchObject({
			upload: true,
			reason: "0.1.0 → 0.1.1",
		})
	})
	test("an unbumped version is a skip, not a failure", () => {
		const said = plan("0.1.0", { publishedItemRevisionStatus: revision("0.1.0") })
		expect(said).toMatchObject({ upload: false, fail: false })
		expect(said.reason).toContain("Raise")
	})
	test("a version still in review stops a newer one", () => {
		const status = {
			publishedItemRevisionStatus: revision("0.1.0"),
			submittedItemRevisionStatus: revision("0.1.1", "PENDING_REVIEW"),
		}
		expect(plan("0.1.2", status)).toMatchObject({ upload: false, fail: true })
	})
	test("a malformed version fails", () => {
		expect(plan("next", {})).toMatchObject({ upload: false, fail: true })
	})
})

test("upload states", () => {
	expect(upload_outcome("SUCCEEDED")).toBe("done")
	expect(upload_outcome("IN_PROGRESS")).toBe("waiting")
	expect(upload_outcome(undefined)).toBe("waiting")
	expect(upload_outcome("FAILED")).toBe("failed")
	expect(upload_outcome("NOT_FOUND")).toBe("failed")
})

test("publish states", () => {
	expect(publish_outcome("PENDING_REVIEW").failed).toBe(false)
	expect(publish_outcome("STAGED").failed).toBe(false)
	expect(publish_outcome("REJECTED").failed).toBe(true)
	expect(publish_outcome("SOMETHING_NEW").failed).toBe(true)
	expect(publish_body()).toEqual({ publishType: "DEFAULT_PUBLISH" })
	expect(publish_body({ staged: true })).toEqual({ publishType: "STAGED_PUBLISH" })
})
