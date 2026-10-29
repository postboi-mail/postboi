import { read_env } from "./env.js"
import { PostboiError } from "./errors.js"

type EnvReader = (name: string) => string | undefined
export interface WorkloadToken {
	access_token: string
	expires_at: number
	workload_id: string
	account_id: string
	mailbox?: { id: string; address: string }
}

/** A public workload ID, as the team's API keys page shows it. */
export const WORKLOAD_ID = /^wl_[a-zA-Z0-9]+$/

const cache = new Map<string, { until: number; value: Promise<WorkloadToken> }>()
const GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
const ID_TOKEN = "urn:ietf:params:oauth:token-type:id_token"

export function workload_configured(get: EnvReader = read_env): boolean {
	return Boolean(get("POSTBOI_WORKLOAD_ID"))
}

function refused(message: string, code = "workload_auth_failed", status?: number): PostboiError {
	return new PostboiError({ provider: "postboi", code, message, status })
}

/** GitHub's runner assertion and the exchanged credential stay in memory, never in .env. */
export async function workload_token(
	base: string,
	fetcher: typeof fetch = globalThis.fetch,
	get: EnvReader = read_env
): Promise<WorkloadToken | undefined> {
	const id = get("POSTBOI_WORKLOAD_ID")
	if (!id) return undefined
	if (!WORKLOAD_ID.test(id))
		throw refused("POSTBOI_WORKLOAD_ID must be a workload ID from your team's API keys page.")
	if (get("GITHUB_ACTIONS") !== "true")
		throw refused(
			"GitHub workload sign-in is only available inside GitHub Actions. Use postboi init for local sign-in."
		)
	const runner_url = get("ACTIONS_ID_TOKEN_REQUEST_URL"),
		runner_token = get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	if (!runner_url || !runner_token)
		throw refused(
			"GitHub did not provide OIDC access. Add permissions: id-token: write to this job."
		)
	let endpoint: URL
	try {
		endpoint = new URL(runner_url)
	} catch {
		throw refused("GitHub's OIDC runner URL is invalid.")
	}
	if (
		endpoint.protocol !== "https:" ||
		!endpoint.hostname.endsWith(".actions.githubusercontent.com") ||
		endpoint.username ||
		endpoint.password ||
		endpoint.hash ||
		(endpoint.port && endpoint.port !== "443")
	)
		throw refused("GitHub's OIDC runner URL is not on the supported GitHub Actions host.")
	const api = (get("POSTBOI_AUTH_URL") ?? base).replace(/\/+$/, "")
	// The trust ID includes the account/grant; runner context prevents cross-job reuse.
	const context = [
		api,
		id,
		runner_url,
		runner_token,
		...[
			"GITHUB_REPOSITORY_ID",
			"GITHUB_REPOSITORY_OWNER_ID",
			"GITHUB_REF",
			"GITHUB_RUN_ID",
			"GITHUB_RUN_ATTEMPT",
			"GITHUB_JOB",
		].map((name) => get(name) ?? ""),
	].join("\n")
	const hit = cache.get(context)
	if (hit && hit.until > Date.now()) return hit.value
	if (cache.size >= 32) cache.delete(cache.keys().next().value!)
	const entry = { until: Infinity, value: Promise.resolve(undefined as unknown as WorkloadToken) }
	cache.set(context, entry)
	entry.value = (async () => {
		try {
			const audience = `https://postboi.app/workloads/${id}`
			endpoint.searchParams.set("audience", audience)
			const runner = await fetcher(endpoint, {
				headers: { authorization: `Bearer ${runner_token}` },
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			})
			if (!runner.ok)
				throw refused(
					"GitHub refused OIDC sign-in. Check this job's id-token: write permission.",
					"workload_auth_failed",
					runner.status
				)
			const assertion = (await runner.json()) as { value?: unknown }
			if (
				typeof assertion.value !== "string" ||
				!assertion.value ||
				assertion.value.length > 16_384
			)
				throw refused("GitHub did not return an identity token.")
			const response = await fetcher(`${api}/v1/auth/token`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({
					grant_type: GRANT,
					subject_token_type: ID_TOKEN,
					subject_token: assertion.value,
					workload_id: id,
					audience,
				}),
			})
			if (!response.ok) {
				// The exchange answers OAuth's `{ error, error_description }`; a rate limit or an
				// outage is not a trust rule to go and check.
				const said = (await response.json().catch(() => undefined)) as
					| { error_description?: unknown }
					| undefined
				const description =
					typeof said?.error_description === "string" ? ` ${said.error_description}` : ""
				throw refused(
					response.status === 429 || response.status >= 500
						? `Postboi could not exchange this workload's identity right now.${description}`
						: `Postboi refused this workload. Check its repository, branch, stable IDs and active trust rule.${description}`,
					"workload_auth_failed",
					response.status
				)
			}
			const body = (await response.json()) as Record<string, unknown>
			const mailbox = body.mailbox as WorkloadToken["mailbox"]
			if (
				body.workload_id !== id ||
				body.token_type !== "Bearer" ||
				typeof body.access_token !== "string" ||
				typeof body.expires_in !== "number" ||
				!Number.isSafeInteger(body.expires_in) ||
				body.expires_in < 1 ||
				body.expires_in > 3600 ||
				typeof body.account_id !== "string" ||
				(mailbox
					? !/^mb_/.test(body.access_token) ||
						typeof mailbox.id !== "string" ||
						typeof mailbox.address !== "string"
					: !/^pb_/.test(body.access_token))
			)
				throw refused("Postboi returned an invalid workload credential.")
			const expires_at = Date.now() + body.expires_in * 1000
			// Refreshed with more left than a mailbox's 90s long poll needs, but never before
			// half its life: a short-lived grant would otherwise re-exchange on every request.
			entry.until = expires_at - Math.min(120_000, (body.expires_in * 1000) / 2)
			return {
				access_token: body.access_token,
				expires_at,
				workload_id: id,
				account_id: body.account_id,
				...(mailbox ? { mailbox } : {}),
			}
		} catch (error) {
			if (cache.get(context) === entry) cache.delete(context)
			if (error instanceof PostboiError) throw error
			throw refused("Workload authentication could not reach GitHub or Postboi. Try again shortly.")
		}
	})()
	return entry.value
}
