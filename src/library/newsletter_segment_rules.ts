// Kept aligned with the newsletter API segment rules for local rehearsals.
export interface SegmentRule {
	include_tag_ids: Array<string>
	exclude_tag_ids: Array<string>
	field?: { key: string; value: string }
}

export function parse_segment_rule(value: unknown): SegmentRule | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
	const input = value as Record<string, unknown>
	const include = input.include_tag_ids ?? []
	const exclude = input.exclude_tag_ids ?? []
	if (!Array.isArray(include) || !Array.isArray(exclude) || include.length + exclude.length > 40)
		return undefined
	if (
		![...include, ...exclude].every(
			(id) => typeof id === "string" && /^ntag_[a-zA-Z0-9_-]+$/.test(id)
		)
	)
		return undefined
	let field: SegmentRule["field"]
	if (input.field !== undefined) {
		if (!input.field || typeof input.field !== "object") return undefined
		const candidate = input.field as Record<string, unknown>
		if (
			typeof candidate.key !== "string" ||
			!/^\w{1,100}$/.test(candidate.key) ||
			typeof candidate.value !== "string" ||
			candidate.value.length > 500
		)
			return undefined
		field = { key: candidate.key, value: candidate.value }
	}
	return {
		include_tag_ids: [...new Set(include)] as Array<string>,
		exclude_tag_ids: [...new Set(exclude)] as Array<string>,
		...(field ? { field } : {}),
	}
}

export function valid_newsletter_slug(value: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
}
