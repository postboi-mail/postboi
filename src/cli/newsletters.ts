import { readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
import {
	api,
	api_file,
	ApiCommandError,
	say,
	table,
	respond,
	take_flags,
	local_api,
	json_output,
} from "./api.js"
import type { Campaign, Newsletter } from "../library/newsletters.js"

function file_json(file: string | undefined): Record<string, unknown> {
	if (!file)
		throw new ApiCommandError("Provide --file draft.json (or - for stdin).", "invalid_args")
	try {
		const value: unknown = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"))
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw Error("Expected an object")
		return value as Record<string, unknown>
	} catch (error) {
		throw new ApiCommandError(
			`Cannot read JSON: ${error instanceof Error ? error.message : String(error)}`,
			"invalid_json"
		)
	}
}
function required(value: string | undefined, message: string): string {
	if (!value) throw new ApiCommandError(message, "invalid_args")
	return value
}
function number(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined
	const n = Number(value)
	if (!Number.isSafeInteger(n) || n < 0)
		throw new ApiCommandError(`${name} must be a non-negative integer.`, "invalid_args")
	return n
}
function assert_flags(rest: Array<string>) {
	if (rest.some((word) => word.startsWith("--")))
		throw new ApiCommandError(
			`Unknown option: ${rest.find((word) => word.startsWith("--"))}`,
			"invalid_args"
		)
}
function result(value: unknown): void {
	respond(value)
	say(JSON.stringify(value, null, 2))
}

export async function campaigns_command(args: Array<string>): Promise<void> {
	const { flags, rest } = take_flags(
		args,
		[
			"file",
			"revision",
			"at",
			"timezone",
			"email",
			"sample-contact",
			"key",
			"out",
			"offset",
			"limit",
		],
		[]
	)
	assert_flags(rest)
	const [action = "list", id] = rest
	const root = "/v1/campaigns"
	if (action === "list") {
		const data = await api<{ campaigns: Array<Campaign> }>(root)
		table(
			["ID", "NAME", "STATUS", "REVISION"],
			data.campaigns.map((c) => [c.id, c.name, c.status, String(c.revision)])
		)
		return
	}
	if (action === "create")
		return result(await api(root, { method: "POST", body: file_json(flags.file) }))
	const path = `${root}/${encodeURIComponent(required(id, `Usage: postboi campaigns ${action} <id>`))}`
	if (action === "get") return result(await api(path))
	if (action === "update") {
		const body = file_json(flags.file),
			revision = number(flags.revision, "revision") ?? body.revision
		if (!Number.isSafeInteger(revision) || Number(revision) < 1)
			throw new ApiCommandError("Provide --revision from the saved draft.", "invalid_args")
		return result(await api(path, { method: "PUT", body: { ...body, revision } }))
	}
	if (["review", "report", "recipients"].includes(action)) {
		const params = new URLSearchParams()
		for (const key of ["offset", "limit"])
			if (flags[key]) params.set(key, String(number(flags[key], key)))
		return result(await api(`${path}/${action}${params.size ? `?${params}` : ""}`))
	}
	if (action === "preview" || action === "export") {
		const query = new URLSearchParams()
		if (action === "preview" && flags["sample-contact"])
			query.set("sample_contact_id", flags["sample-contact"])
		if (action === "export")
			for (const key of ["offset", "limit"])
				if (flags[key]) query.set(key, String(number(flags[key], key)))
		const file = await api_file(`${path}/${action}${query.size ? `?${query}` : ""}`)
		const text = new TextDecoder().decode(file.bytes)
		if (json_output() && !flags.out) {
			respond(action === "preview" ? { html: text } : { csv: text })
			return
		}
		if (flags.out && flags.out !== "-") {
			writeFileSync(flags.out, file.bytes)
			respond({ path: flags.out })
			say(`Saved ${flags.out}`)
		} else {
			process.stdout.write(text)
			respond(undefined)
		}
		return
	}
	if (action === "launch") {
		const revision = number(flags.revision, "revision")
		if (!revision || !flags.timezone)
			throw new ApiCommandError(
				"Launch needs --revision and --timezone (for example Europe/London).",
				"invalid_args"
			)
		if (
			flags.at &&
			(!/(?:Z|[+-]\d\d:\d\d)$/.test(flags.at) || !Number.isFinite(Date.parse(flags.at)))
		)
			throw new ApiCommandError(
				"--at needs an absolute ISO time with Z or an offset.",
				"invalid_args"
			)
		return result(
			await api(`${path}/launch`, {
				method: "POST",
				body: { revision, timezone: flags.timezone, scheduled_at: flags.at },
			})
		)
	}
	if (action === "test")
		return result(
			await api(`${path}/test`, {
				method: "POST",
				body: {
					email: required(flags.email, "Test needs --email. It only sends to that address."),
					sample_contact_id: flags["sample-contact"],
				},
			})
		)
	if (action === "resend")
		return result(
			await api(`${path}/resend`, {
				method: "POST",
				body: {
					idempotency_key: required(
						flags.key,
						"Resend creates a draft. Provide --key to deduplicate it."
					),
				},
			})
		)
	if (["pause", "resume", "cancel", "duplicate"].includes(action))
		return result(await api(`${path}/${action}`, { method: "POST", body: {} }))
	if (action === "run" && local_api())
		return result(await api(`${path}/run`, { method: "POST", body: {} }))
	throw new ApiCommandError(`Unknown campaign action: ${action}`, "invalid_args")
}

export async function newsletters_command(args: Array<string>): Promise<void> {
	const { flags, rest, on } = take_flags(
		args,
		[
			"file",
			"email",
			"name",
			"search",
			"offset",
			"limit",
			"status",
			"mapping",
			"source",
			"profile",
			"contact",
			"event",
			"tag",
			"revision",
			"sample-contact",
			"after",
			"review-hash",
			"out",
		],
		["consent", "confirm"]
	)
	assert_flags(rest)
	const [action = "list", id, operation, ref] = rest
	const root = "/v1/newsletters"
	if (action === "list") {
		const data = await api<{ newsletters: Array<Newsletter> }>(root)
		table(
			["LIST", "SLUG", "NAME", "SUBSCRIBED", "PENDING"],
			data.newsletters.map((n) => [
				n.list_id,
				n.slug,
				n.name ?? "",
				String(n.subscribed ?? 0),
				String(n.pending ?? 0),
			])
		)
		return
	}
	if (action === "configure")
		return result(await api(root, { method: "POST", body: file_json(flags.file) }))
	const path = `${root}/${encodeURIComponent(required(id, `Usage: postboi newsletters ${action} <list-id>`))}`
	if (action === "get") return result(await api(path))
	if (action === "audience") {
		const query = new URLSearchParams()
		for (const key of ["search", "offset", "limit"]) if (flags[key]) query.set(key, flags[key])
		return result(await api(`${path}/audience?${query}`))
	}
	if (action === "signup") {
		if (!on.has("consent"))
			throw new ApiCommandError(
				"Signup needs --consent. It requests confirmation, never direct subscription.",
				"consent_required"
			)
		return result(
			await api(`${path}/signups`, {
				method: "POST",
				body: {
					email: required(flags.email, "Signup needs --email."),
					name: flags.name,
					consent: true,
				},
			})
		)
	}
	if (action === "tags") {
		if (!operation || operation === "list") return result(await api(`${path}/tags`))
		if (operation === "add")
			return result(
				await api(`${path}/tags`, {
					method: "POST",
					body: {
						name: required(flags.name, "Tag creation needs --name."),
						contact_ids: flags.contact?.split(","),
						event_id: flags.event,
					},
				})
			)
		if (operation === "remove")
			return result(
				await api(`${path}/tags`, {
					method: "DELETE",
					body: {
						tag_id: required(flags.tag, "Provide --tag."),
						contact_id: required(flags.contact, "Provide --contact."),
					},
				})
			)
	}
	if (action === "segments") {
		if (!operation || operation === "list") return result(await api(`${path}/segments`))
		if (operation === "add")
			return result(await api(`${path}/segments`, { method: "POST", body: file_json(flags.file) }))
	}
	if (action === "reconfirmation") {
		if (local_api())
			throw new ApiCommandError(
				"Automatic reconfirmation needs hosted retained activity and verified delivery. It is unavailable in the local capture inbox.",
				"local_operation_unavailable"
			)
		const policy_path = `${path}/reconfirmation`
		if (!operation || operation === "get") return result(await api(policy_path))
		if (operation === "save") {
			const body = file_json(flags.file),
				revision = number(flags.revision, "revision") ?? body.revision
			return result(
				await api(policy_path, {
					method: "PUT",
					body: { ...body, ...(revision === undefined ? {} : { revision }) },
				})
			)
		}
		if (operation === "review") return result(await api(`${policy_path}/review`))
		if (["enable", "pause"].includes(operation)) {
			const revision = number(flags.revision, "revision")
			if (!revision)
				throw new ApiCommandError(
					"Provide --revision from the saved policy review.",
					"invalid_args"
				)
			if (operation === "enable" && !on.has("confirm"))
				throw new ApiCommandError(
					"Enable needs --confirm to approve the exact reviewed reminder and future holds.",
					"confirmation_required"
				)
			const review_hash =
				operation === "enable"
					? required(flags["review-hash"], "Provide --review-hash from the current policy review.")
					: undefined
			return result(
				await api(`${policy_path}/${operation}`, {
					method: "POST",
					body: { revision, ...(operation === "enable" ? { review_hash, confirm: true } : {}) },
				})
			)
		}
		throw new ApiCommandError(
			"Reconfirmation supports get, save, review, enable and pause.",
			"invalid_args"
		)
	}
	if (action === "quality") {
		if (local_api())
			throw new ApiCommandError(
				"Audience quality uses hosted delivery evidence and DNS checks. It is unavailable in the local capture inbox.",
				"local_operation_unavailable"
			)
		if (!operation || operation === "get")
			return result(
				await api(
					`${path}/quality${flags.offset ? `?offset=${number(flags.offset, "offset")}` : ""}`
				)
			)
		if (["scan", "domains"].includes(operation))
			return result(
				await api(`${path}/quality`, { method: "POST", body: { operation, after: flags.after } })
			)
		if (["exclude", "allow"].includes(operation))
			return result(
				await api(`${path}/quality`, {
					method: "POST",
					body: {
						operation: "decision",
						email: required(flags.email, "Provide --email for this eligibility decision."),
						decision: operation,
					},
				})
			)
		throw new ApiCommandError(
			"Quality supports get, scan, domains, exclude and allow.",
			"invalid_args"
		)
	}
	if (action === "rules") {
		const rule_path = `${path}/rules`
		if (!operation || operation === "list") return result(await api(rule_path))
		if (operation === "create")
			return result(await api(rule_path, { method: "POST", body: file_json(flags.file) }))
		const resource = `${rule_path}/${encodeURIComponent(required(ref, "Provide the rule id."))}`
		if (operation === "get" || operation === "review")
			return result(await api(resource + (operation === "review" ? "/review" : "")))
		if (operation === "preview") {
			const value = await api<{ subject: string; html: string }>(`${resource}/preview`, {
				method: "POST",
				body: { sample_contact_id: flags["sample-contact"] },
			})
			if (flags.out) {
				writeFileSync(flags.out, value.html)
				return result({ out: flags.out, subject: value.subject })
			}
			return result(value)
		}
		if (operation === "run" && local_api())
			return result(await api(`${resource}/run`, { method: "POST", body: {} }))
		if (["update", "enable", "pause"].includes(operation)) {
			const revision = number(flags.revision, "revision")
			if (!revision)
				throw new ApiCommandError("Provide --revision from the saved rule review.", "invalid_args")
			if (operation === "enable" && !on.has("confirm"))
				throw new ApiCommandError(
					"Enable needs --confirm to approve this exact revision for future triggers.",
					"confirmation_required"
				)
			return result(
				await api(resource + (operation === "update" ? "" : `/${operation}`), {
					method: operation === "update" ? "PATCH" : "POST",
					body: {
						...(operation === "update" ? file_json(flags.file) : {}),
						revision,
						...(operation === "enable" ? { confirm: true } : {}),
					},
				})
			)
		}
		throw new ApiCommandError(`Unknown newsletter rule action: ${operation}`, "invalid_args")
	}
	if (action === "imports") {
		if (!operation || operation === "list") return result(await api(`${path}/imports`))
		if (operation === "preview") {
			const file = required(flags.file, "Import preview needs --file audience.csv."),
				status = flags.status ?? "pending"
			return result(
				await api(`${path}/imports`, {
					method: "POST",
					body: {
						csv: readFileSync(file === "-" ? 0 : file, "utf8"),
						filename: file === "-" ? "stdin.csv" : basename(file),
						default_status: status,
						consent_confirmed: on.has("consent"),
						mapping: flags.mapping ? file_json(flags.mapping) : undefined,
						source_audience_id: flags.source,
						source_profile: flags.profile,
					},
				})
			)
		}
		if (operation === "apply")
			return result(
				await api(
					`${path}/imports/${encodeURIComponent(required(ref, "Provide the import id from preview."))}`,
					{ method: "POST", body: {} }
				)
			)
	}
	throw new ApiCommandError(`Unknown newsletter action: ${action}`, "invalid_args")
}
