/**
 * The pieces a long-polling client needs, shared by `postboi/inbox` (tempboi.email) and
 * `postboi/mailbox` (agentboi.email), which wait on the server the same way. Internal:
 * nothing here is exported from the package.
 */

/** Text to match: a case-insensitive substring, or a RegExp tested here in the client. */
export type Match = string | RegExp

export function matches(value: string | null, match: Match | undefined): boolean {
	if (match === undefined) return true
	if (typeof match === "string") return (value ?? "").toLowerCase().includes(match.toLowerCase())
	match.lastIndex = 0
	return match.test(value ?? "")
}

export function aborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted ?? false
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms)
		signal?.addEventListener("abort", done, { once: true })
		function done() {
			clearTimeout(timer)
			signal?.removeEventListener("abort", done)
			resolve()
		}
	})
}

/** The caller's signal, plus a ceiling so a long-poll a proxy swallowed can't hang forever. */
export function with_deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms)
	return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Slack on top of a long-poll's own hold before the request is called lost. */
export const GRACE_MS = 15_000
/** How long one list long-poll holds, in seconds. The server's own ceiling is 25. */
export const POLL_SECONDS = 25
/** The server's ceiling on one `/wait`, in seconds. */
export const WAIT_SECONDS = 90

/** `"15m"` → 900000. Numbers are already milliseconds. */
export function duration_ms(value: number | string): number {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0) throw new TypeError(`Invalid duration: ${value}`)
		return value
	}
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(value)
	if (!match) throw new TypeError(`Invalid duration: "${value}" (try "90s", "15m", "2h" or "1d")`)
	const unit = (match[2] ?? "s").toLowerCase()
	const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000
	return Math.round(Number(match[1]) * scale)
}
