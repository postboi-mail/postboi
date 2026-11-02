import { writeFileSync } from "node:fs"
import { api, ApiCommandError, local_api, respond, say, take_flags } from "./api.js"
import type { MigrationSourcePage } from "../library/read_resources.js"
function hosted() {
	if (local_api())
		throw new ApiCommandError(
			"Provider migrations and Postmaster reports require hosted, authorized provider evidence. This command does not contact a hosted fallback from the local inbox.",
			"local_operation_unavailable"
		)
}
function options(args: Array<string>) {
	const parsed = take_flags(args, ["offset", "after", "out"], [])
	if (parsed.rest.some((word) => word.startsWith("--")))
		throw new ApiCommandError("Unknown option.", "invalid_args")
	return parsed
}
function offset(value?: string) {
	if (value === undefined) return ""
	const n = Number(value)
	if (!/^\d{1,8}$/.test(value) || !Number.isSafeInteger(n) || n > 10000000)
		throw new ApiCommandError("Use a nonnegative --offset up to 10000000.", "invalid_args")
	return `?offset=${n}`
}
function id(value?: string) {
	if (!value) throw new ApiCommandError("Provide the resource ID.", "invalid_args")
	return encodeURIComponent(value)
}
function output(value: unknown) {
	respond(value)
	say(JSON.stringify(value, null, 2))
}
export async function migrations_command(args: Array<string>) {
	hosted()
	const { flags, rest } = options(args),
		[action = "list", resource_id] = rest
	if (rest.length > (action === "list" ? 1 : 2))
		throw new ApiCommandError("Unexpected argument.", "invalid_args")
	if (action !== "export" && (flags.after !== undefined || flags.out !== undefined))
		throw new ApiCommandError("Use --after and --out only with migrations export.", "invalid_args")
	if (action !== "list" && flags.offset !== undefined)
		throw new ApiCommandError("Use --offset only with migrations list.", "invalid_args")
	if (action === "list") return output(await api(`/v1/migrations${offset(flags.offset)}`))
	if (action === "review" || action === "status")
		return output(await api(`/v1/migrations/${id(resource_id)}`))
	if (action === "export") {
		if (
			flags.after !== undefined &&
			(!/^\d{1,16}$/.test(flags.after) || !Number.isSafeInteger(Number(flags.after)))
		)
			throw new ApiCommandError(
				"Use the --after cursor returned by the previous export page.",
				"invalid_args"
			)
		const data = await api<MigrationSourcePage>(
			`/v1/migrations/${id(resource_id)}/export${flags.after === undefined ? "" : `?after=${encodeURIComponent(flags.after)}`}`
		)
		if (flags.out) {
			writeFileSync(flags.out, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" })
			say(`Source page saved to ${flags.out}. Continue with the next cursor.`)
			respond(data)
			return
		}
		return output(data)
	}
	throw new ApiCommandError("Use migrations list, review, status or export.", "invalid_args")
}
export async function postmaster_command(args: Array<string>) {
	hosted()
	const { flags, rest } = options(args),
		[action = "list", domain_id] = rest
	if (
		rest.length > (action === "report" ? 2 : 1) ||
		flags.after !== undefined ||
		flags.out !== undefined
	)
		throw new ApiCommandError("Unexpected argument or option.", "invalid_args")
	if (action === "list") return output(await api(`/v1/postmaster${offset(flags.offset)}`))
	if (action === "feedback")
		return output(await api(`/v1/postmaster/feedback${offset(flags.offset)}`))
	if (action === "report") {
		if (flags.offset !== undefined)
			throw new ApiCommandError("Use --offset only with list or feedback.", "invalid_args")
		return output(await api(`/v1/postmaster/${id(domain_id)}`))
	}
	throw new ApiCommandError("Use postmaster list, report or feedback.", "invalid_args")
}
