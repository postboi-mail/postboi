import { readFileSync, writeFileSync } from "node:fs"
import { api, ApiCommandError, say, respond, take_flags, local_api } from "./api.js"
import type { PublicationReview } from "../library/publications.js"
function required(value: string | undefined, message: string): string {
	if (!value) throw new ApiCommandError(message, "invalid_args")
	return value
}
function integer(value: string | undefined, label: string, minimum: number) {
	const number = Number(value)
	if (value === undefined || !Number.isSafeInteger(number) || number < minimum)
		throw new ApiCommandError(
			`Provide --${label} as an integer of at least ${minimum}.`,
			"invalid_args"
		)
	return number
}
function file_json(path: string | undefined) {
	try {
		const value: unknown = JSON.parse(
			readFileSync(
				required(path, "Provide --file publication.json (or - for stdin).") === "-" ? 0 : path!,
				"utf8"
			)
		)
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw Error("Expected an object")
		return value as Record<string, unknown>
	} catch (reason) {
		throw new ApiCommandError(
			`Cannot read settings JSON: ${reason instanceof Error ? reason.message : String(reason)}`,
			"invalid_args"
		)
	}
}
function result(value: unknown) {
	respond(value)
	say(JSON.stringify(value, null, 2))
}
export async function publications_command(args: Array<string>) {
	if (local_api())
		throw new ApiCommandError(
			"Publications require the hosted service. Local previews never become public.",
			"local_publications_unavailable"
		)
	const { flags, rest, on } = take_flags(
		args,
		["file", "revision", "slug", "summary", "visibility", "offset", "out"],
		["confirm"]
	)
	if (rest.some((arg) => arg.startsWith("--")))
		throw new ApiCommandError("Unknown publication option.", "invalid_args")
	const [action = "list", list_id, campaign_id] = rest
	if (action === "list") return result(await api("/v1/publications"))
	const path = `/v1/publications/${encodeURIComponent(required(list_id, `Usage: postboi publications ${action} <list-id>`))}`
	if (action === "get") return result(await api(path))
	if (action === "configure") {
		const body = file_json(flags.file)
		if (body.enabled === true && !on.has("confirm"))
			throw new ApiCommandError(
				"Enabling public pages requires --confirm after reviewing publication and author settings.",
				"invalid_args"
			)
		return result(
			await api(path, {
				method: "PUT",
				body: { ...body, ...(on.has("confirm") ? { confirm: true } : {}) },
			})
		)
	}
	if (action === "issues")
		return result(
			await api(
				`${path}/issues${flags.offset === undefined ? "" : `?offset=${integer(flags.offset, "offset", 0)}`}`
			)
		)
	const issue = `${path}/issues/${encodeURIComponent(required(campaign_id, `Usage: postboi publications ${action} <list-id> <campaign-id>`))}`
	if (action === "issue") return result(await api(issue))
	if (action === "review") {
		const review = await api<PublicationReview>(
			`${issue}/review?revision=${integer(flags.revision, "revision", 1)}`
		)
		if (flags.out) {
			writeFileSync(flags.out, review.html)
			say(`Saved inert public preview to ${flags.out}`)
		}
		return result(review)
	}
	if (action === "unpublish") return result(await api(issue, { method: "DELETE" }))
	if (action === "publish") {
		if (!on.has("confirm"))
			throw new ApiCommandError(
				"Publishing requires --confirm after reviewing the exact public copy. Listed and unlisted copies are public.",
				"invalid_args"
			)
		if (flags.visibility !== "listed" && flags.visibility !== "unlisted")
			throw new ApiCommandError("Provide --visibility listed or unlisted.", "invalid_args")
		return result(
			await api(issue, {
				method: "POST",
				body: {
					revision: integer(flags.revision, "revision", 1),
					slug: required(flags.slug, "Provide --slug for the issue."),
					summary: required(flags.summary, "Provide --summary for the public issue."),
					visibility: flags.visibility,
					confirm: true,
				},
			})
		)
	}
	throw new ApiCommandError(`Unknown publication action: ${action}`, "invalid_args")
}
