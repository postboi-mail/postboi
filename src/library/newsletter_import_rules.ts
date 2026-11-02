import { parse_csv, CsvLimitError } from "./newsletter_csv.js"
import {
	profile_aliases,
	PROFILE_STATES,
	valid_import_profile,
	type ImportProfile,
} from "./newsletter_import_profiles.js"

export type ImportStatus = "subscribed" | "pending" | "unsubscribed" | "bounced" | "complained"
export interface NewsletterImportRow {
	email: string
	name: string | null
	status: ImportStatus
	data: Record<string, string>
	tags: Array<string>
	consent_at: string | null
	provenance: {
		source_profile?: ImportProfile
		consent_raw: string | null
		source_fields: Record<string, string>
	}
}
export interface ImportMapping {
	email?: string
	name?: string
	status?: string
	tags?: string
	consent_at?: string
	topic_opt_out?: string
	fields?: Record<string, string>
}
export interface ParsedNewsletterImport {
	rows: Array<NewsletterImportRow>
	source_profile: ImportProfile
	warnings: Array<string>
	headers: Array<string>
	invalid: number
	duplicates: number
	unknown_status: number
	invalid_consent_dates: number
	opt_out_columns: Array<string>
	mapped_fields: Array<{ column: string; field: string }>
	conflicts: number
	counts: Record<ImportStatus, number>
}
const ALIASES = {
	email: ["email", "email address", "email_address", "e-mail address"],
	name: ["name", "full name"],
	status: ["status", "email marketing status", "subscription status", "member status"],
	tags: ["tags", "tag"],
	consent_at: ["confirm_time", "optin_time", "consent_at", "signup date", "timestamp signup"],
	topic_opt_out: [] as Array<string>,
}
const STATUS: Record<string, ImportStatus> = {
	subscribed: "subscribed",
	active: "subscribed",
	pending: "pending",
	unconfirmed: "pending",
	unsubscribed: "unsubscribed",
	unsub: "unsubscribed",
	archived: "unsubscribed",
	cleaned: "bounced",
	bounced: "bounced",
	complained: "complained",
	complaint: "complained",
	spam: "complained",
}
const RANK: Record<ImportStatus, number> = {
	subscribed: 0,
	pending: 1,
	unsubscribed: 2,
	bounced: 3,
	complained: 4,
}

export function suggest_import_mapping(
	headers: Array<string>,
	source_profile: ImportProfile = "generic"
): ImportMapping {
	const aliases = source_profile === "generic" ? ALIASES : profile_aliases(source_profile)
	const result: ImportMapping = { fields: {} }
	for (const key of ["email", "name", "status", "tags", "consent_at"] as const)
		result[key] =
			aliases[key]
				.map((alias) => headers.find((heading) => heading.trim().toLowerCase() === alias))
				.find(Boolean) ?? "__skip__"
	for (const heading of headers)
		result.fields![heading] = heading.toLowerCase().replace(/\W+/g, "_").replace(/^_|_$/g, "")
	return result
}

export function parse_newsletter_csv(
	text: string,
	options: {
		default_status: ImportStatus
		consent_confirmed: boolean
		mapping?: ImportMapping
		source_profile?: ImportProfile
	}
): ParsedNewsletterImport | { error: string } {
	const source_profile = options.source_profile ?? "generic"
	if (!valid_import_profile(source_profile))
		return { error: "Choose a supported CSV source profile." }
	const aliases = source_profile === "generic" ? ALIASES : profile_aliases(source_profile)
	if (text.length > 8_000_000)
		return { error: "The CSV is too large. Split it into files under 8 MB." }
	if (text.includes("\0")) return { error: "Upload a UTF-8 CSV file." }
	let quoted = false
	for (let i = 0; i < text.length; i++)
		if (text[i] === '"') {
			if (quoted && text[i + 1] === '"') i++
			else quoted = !quoted
		}
	if (quoted) return { error: "The CSV has an unfinished quoted field." }
	let parsed: Array<Array<string>>
	try {
		parsed = parse_csv(text.replace(/^\uFEFF/, ""), { rows: 10001, columns: 100, cell: 20000 })
	} catch (cause) {
		if (cause instanceof CsvLimitError) return { error: cause.message }
		throw cause
	}
	if (parsed.length < 2) return { error: "Include a header row and at least one contact." }
	if (parsed.length > 10001)
		return {
			error: "Import at most 10,000 contacts per file. Split larger exports into separate imports.",
		}
	const headers = parsed[0].map((value) => value.trim())
	const lower = headers.map((value) => value.toLowerCase())
	if (
		new Set(lower).size !== headers.length ||
		headers.length > 100 ||
		headers.some((heading) => heading.length > 200)
	)
		return {
			error: "Column headings must be unique and under 200 characters, with at most 100 columns.",
		}
	function column(key: keyof typeof ALIASES): number {
		const explicit = options.mapping?.[key]
		return explicit === "__skip__"
			? -1
			: explicit
				? headers.indexOf(explicit)
				: (aliases[key].map((alias) => lower.indexOf(alias)).find((index) => index >= 0) ?? -1)
	}
	const email_col = column("email"),
		name_col = column("name"),
		status_col = column("status"),
		tags_col = column("tags"),
		consent_col = column("consent_at"),
		topic_col = column("topic_opt_out")
	if (email_col < 0)
		return {
			error: "Choose the column containing email addresses, or use an Email Address heading.",
		}
	for (const [key, value] of Object.entries(options.mapping ?? {}))
		if (
			key !== "fields" &&
			typeof value === "string" &&
			value &&
			value !== "__skip__" &&
			!headers.includes(value)
		)
			return { error: `The mapped column ${value} is missing.` }
	const metadata = new Set([email_col, name_col, status_col, tags_col, consent_col])
	const opt_out_columns = headers.filter(
		(heading, index) => !metadata.has(index) && /unsub|opt[ _-]?out/i.test(heading)
	)
	if (opt_out_columns.length && !Object.hasOwn(options.mapping ?? {}, "topic_opt_out"))
		return {
			error: `Check the opt-out fields (${opt_out_columns.join(", ")}). Choose the field that opts readers out of this newsletter, or explicitly use only the subscription status.`,
		}

	const first = lower.findIndex((heading) =>
			["first name", "first_name", "firstname"].includes(heading)
		),
		last = lower.findIndex((heading) => ["last name", "last_name", "lastname"].includes(heading))
	if (first >= 0) metadata.add(first)
	if (last >= 0) metadata.add(last)
	const fields: Array<{ index: number; key: string }> = []
	for (let index = 0; index < headers.length; index++) {
		if (metadata.has(index)) continue
		const mapped = options.mapping?.fields?.[headers[index]]
		if (mapped === "") continue
		const key = mapped ?? headers[index].toLowerCase().replace(/\W+/g, "_").replace(/^_|_$/g, "")
		if (
			!/^\w{1,100}$/.test(key) ||
			["email", "name", "unsubscribe_url", "preferences_url"].includes(key)
		)
			return { error: `Choose a valid custom field name for ${headers[index]}.` }
		if (fields.some((field) => field.key === key))
			return { error: `Two columns map to ${key}. Give each field its own name.` }
		fields.push({ index, key })
	}
	const result: ParsedNewsletterImport = {
		rows: [],
		source_profile,
		warnings: [],
		headers,
		invalid: 0,
		duplicates: 0,
		unknown_status: 0,
		invalid_consent_dates: 0,
		opt_out_columns,
		mapped_fields: fields.map((field) => ({ column: headers[field.index], field: field.key })),
		conflicts: 0,
		counts: { subscribed: 0, pending: 0, unsubscribed: 0, bounced: 0, complained: 0 },
	}
	if (status_col < 0)
		result.warnings.push(
			"No subscription status column was matched. Check the selected state against this specific export before importing."
		)
	if (headers.some((heading) => /created|signup|subscription.*date/i.test(heading)))
		result.warnings.push(
			"Signup, creation and payment dates are retained as source evidence. They do not establish newsletter consent."
		)
	const boolean_col =
		source_profile === "substack"
			? lower.indexOf("email disabled") >= 0
				? lower.indexOf("email disabled")
				: lower.indexOf("email_disabled")
			: source_profile === "ghost"
				? lower.indexOf("subscribed_to_emails")
				: -1
	const global_col = source_profile === "listmonk" ? lower.indexOf("status") : -1
	if (
		source_profile === "listmonk" &&
		!lower.some((heading) => ["subscription_status", "subscription status"].includes(heading))
	)
		result.warnings.push(
			"Global enabled status does not prove this list's permission. Those rows remain pending until list subscription status is supplied."
		)
	if (source_profile === "ghost" || source_profile === "substack")
		result.warnings.push(
			"Review newsletter-specific email preferences separately. Paid or free membership does not confirm permission for this newsletter."
		)
	const by_email = new Map<string, NewsletterImportRow>()
	for (const cells of parsed.slice(1)) {
		const email = (cells[email_col] ?? "").trim().toLowerCase()
		if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			result.invalid++
			continue
		}
		if (
			cells.length > headers.length ||
			cells.some((cell) => cell.length > 20000) ||
			cells.reduce((sum, cell) => sum + cell.length, 0) > 150000
		)
			return {
				error: `The row for ${email} has extra columns or oversized metadata. Reduce its fields and export again. No valid address can be skipped with its subscription restrictions.`,
			}
		const raw_status =
			status_col < 0 ? options.default_status : (cells[status_col] ?? "").trim().toLowerCase()
		const states = PROFILE_STATES[source_profile] ?? {}
		let status =
			status_col < 0
				? options.default_status
				: Object.hasOwn(states, raw_status)
					? states[raw_status]
					: Object.hasOwn(STATUS, raw_status)
						? STATUS[raw_status]
						: undefined
		if (!status) {
			status = "pending"
			result.unknown_status++
		}
		if (boolean_col >= 0) {
			const value = (cells[boolean_col] ?? "").trim().toLowerCase()
			if (
				(source_profile === "substack" && ["true", "1", "yes"].includes(value)) ||
				(source_profile === "ghost" && ["false", "0", "no"].includes(value))
			) {
				if (RANK[status] < RANK.unsubscribed) status = "unsubscribed"
			} else if (!["true", "false", "1", "0", "yes", "no"].includes(value)) {
				if (status === "subscribed") status = "pending"
				result.unknown_status++
			}
		}
		if (
			global_col >= 0 &&
			["disabled", "blocklisted"].includes((cells[global_col] ?? "").trim().toLowerCase()) &&
			RANK[status] < RANK.unsubscribed
		)
			status = "unsubscribed"
		if (
			topic_col >= 0 &&
			topic_opt_out_value(cells[topic_col] ?? "") &&
			RANK[status] < RANK.unsubscribed
		)
			status = "unsubscribed"
		if (topic_col >= 0) {
			const value = (cells[topic_col] ?? "").trim().toLowerCase()
			if (value && !topic_opt_out_value(value) && !["0", "false", "no", "n"].includes(value)) {
				if (status === "subscribed") status = "pending"
				result.unknown_status++
				const warning =
					"Unrecognized values in the selected opt-out column stay pending. Their original evidence is preserved."
				if (!result.warnings.includes(warning)) result.warnings.push(warning)
			}
		}
		if (status === "subscribed" && !options.consent_confirmed)
			return {
				error:
					"Confirm that subscribed rows have recorded permission to receive this newsletter. An address alone is not consent.",
			}
		const date = consent_col >= 0 ? cells[consent_col]?.trim() : ""
		// Keep the original evidence even when a date cannot be interpreted without guessing.
		const known_date = Boolean(
			date &&
			/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/.test(
				date
			)
		)
		const consent_at =
			known_date && valid_calendar_date(date!) && Number.isFinite(Date.parse(date!))
				? new Date(date!).toISOString()
				: null
		if (date && !consent_at) result.invalid_consent_dates++

		const data = Object.fromEntries(fields.map((field) => [field.key, cells[field.index] ?? ""]))
		const row: NewsletterImportRow = {
			email,
			status,
			data,
			name:
				(name_col >= 0
					? cells[name_col]?.trim()
					: [cells[first], cells[last]].filter(Boolean).join(" ").trim()) || null,
			tags:
				tags_col < 0
					? []
					: [
							...new Set(
								(cells[tags_col] ?? "")
									.split(/[,;]+/)
									.map((tag) => tag.trim())
									.filter(Boolean)
							),
						],
			consent_at,
			provenance: {
				source_profile,
				consent_raw: date || null,
				source_fields: Object.fromEntries(
					headers.map((heading, index) => [heading, cells[index] ?? ""])
				),
			},
		}
		if (row.tags.length > 50)
			return {
				error: `The row for ${email} has more than 50 tags. Reduce the tag set before importing so exclusion segments cannot silently change.`,
			}
		if (row.tags.some((tag) => tag.length > 100))
			return {
				error: `The row for ${email} has a tag over 100 characters. Shorten the tag and export again so this reader's subscription restrictions are preserved.`,
			}
		if (new TextEncoder().encode(JSON.stringify(row)).byteLength > 500000)
			return {
				error: `The row for ${email} is too large to preserve safely. Remove large content columns and export it again; each contact with its original evidence must fit within 500 KB.`,
			}

		const existing = by_email.get(email)
		if (existing) {
			result.duplicates++
			if (JSON.stringify(existing.data) !== JSON.stringify(data) || existing.name !== row.name)
				result.conflicts++
			// The restrictive status wins regardless of export order; preserve first field values.
			if (RANK[row.status] > RANK[existing.status]) existing.status = row.status
			existing.tags = [...new Set([...existing.tags, ...row.tags])]
			if (existing.tags.length > 50)
				return {
					error: `Duplicate rows for ${email} combine to more than 50 tags. Reduce the tag set before importing so exclusion segments cannot silently change.`,
				}
		} else by_email.set(email, row)
	}
	result.rows = [...by_email.values()]
	for (const row of result.rows) result.counts[row.status]++
	if (!result.rows.length) return { error: "No valid email addresses were found." }
	return result
}

/** The same explicit opt-out vocabulary applies to CSV and provider migration. */
export function topic_opt_out_value(value: string): boolean {
	return ["1", "true", "yes", "y", "unsubscribed", "unsub", "opted out"].includes(
		value.trim().toLowerCase()
	)
}

function valid_calendar_date(value: string): boolean {
	const [year, month, day] = value.slice(0, 10).split("-").map(Number)
	return (
		month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
	)
}
