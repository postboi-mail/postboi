/**
 * The two things `init --push` can do for an APNs setup that it can't do for any other
 * provider, both of them because of quirks in how Apple hands the credential over.
 *
 * There is no OAuth to reach for here, and there won't be: the App Store Connect API has
 * no endpoint that creates an APNs key, its own credential is another `.p8` you download
 * by hand, and its terms forbid using it to provide services to third parties. So this is
 * the ceiling — find the file the user already downloaded, and check what they typed.
 *
 * Internal: not part of the public surface.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { bold, dim, green, yellow, type Option } from "./prompts.js"

/** The subset of the prompter this module needs — keeps the import one-directional. */
type Asker = {
	select<T>(message: string, options: Array<Option<T>>): Promise<T>
}

/**
 * Apple names the key it hands you `AuthKey_<KEYID>.p8`, and shows the file exactly once.
 * So the filename carries the key ID, and the file is almost certainly still in Downloads
 * — which together turn two of the four APNs answers into a confirmation.
 */
const AUTH_KEY = /^AuthKey_([A-Z0-9]+)\.p8$/

/** Where a freshly downloaded key plausibly is. */
export const key_search_paths = (from: string): Array<string> => [
	from,
	join(homedir(), "Downloads"),
]

/** Every `AuthKey_*.p8` in `dirs`, newest first — the newest is the one just downloaded. */
export function find_auth_keys(dirs: Array<string>): Array<{ path: string; key_id: string }> {
	const found: Array<{ path: string; key_id: string; at: number }> = []
	for (const dir of dirs) {
		let names: Array<string>
		try {
			names = readdirSync(dir)
		} catch {
			continue // no such directory on this machine — nothing to offer, not an error
		}
		for (const name of names) {
			const match = AUTH_KEY.exec(name)
			if (!match) continue
			const path = join(dir, name)
			try {
				found.push({ path, key_id: match[1], at: statSync(path).mtimeMs })
			} catch {
				// vanished between the listing and the stat
			}
		}
	}
	return found.sort((a, b) => b.at - a.at).map(({ path, key_id }) => ({ path, key_id }))
}

/**
 * Offer the `.p8` files lying around instead of asking for a PEM to be pasted into a
 * terminal prompt. Picking one fills the key **and** its ID, since Apple put the ID in the
 * filename. Declining, or finding nothing, falls through to the ordinary prompts.
 */
export async function offer_auth_key(
	prompts: Asker,
	prefilled: Record<string, string>,
	dirs: Array<string>
): Promise<void> {
	if (prefilled.APNS_PRIVATE_KEY !== undefined) return
	const keys = find_auth_keys(dirs)
	if (keys.length === 0) return

	const picked = await prompts.select<(typeof keys)[number] | undefined>(
		bold("Found an APNs key. Use it?"),
		[
			...keys.map((key) => ({
				label: key.path.replace(homedir(), "~"),
				value: key as (typeof keys)[number] | undefined,
				hint: `key ID ${key.key_id}`,
			})),
			{ label: "Paste the key instead", value: undefined },
		]
	)
	if (!picked) return

	try {
		prefilled.APNS_PRIVATE_KEY = readFileSync(picked.path, "utf8")
	} catch (error) {
		console.log(yellow(`! couldn't read ${picked.path}: ${(error as Error).message}`))
		return
	}
	prefilled.APNS_KEY_ID = picked.key_id
	console.log(`${green("✓")} read the key, and took ${bold("APNS_KEY_ID")} from its filename\n`)
}

/**
 * Send one notification to a syntactically valid but unregistered device token, purely to
 * learn what APNs makes of the credentials. Apple checks the provider token and the topic
 * before it looks at the device, so **`BadDeviceToken` coming back is the success case**:
 * it means the key, the team and the bundle ID were all accepted, and only the token we
 * invented was wrong. Returns undefined when everything is in order, or the sentence to
 * show the user.
 *
 * Worth the one request at setup, because every failure below is otherwise invisible
 * until a real notification silently doesn't arrive.
 */
export async function verify_apns(args: Record<string, string>): Promise<string | undefined> {
	const { default: APNs } = await import("../library/push/apns.js")
	const notify = new APNs({
		key_id: args.key_id,
		team_id: args.team_id,
		private_key: args.private_key,
		topic: args.topic,
		environment: args.environment === "sandbox" ? "sandbox" : "production",
	})
	try {
		await notify.send({ to: "0".repeat(64), message: "postboi credential check" })
		return undefined
	} catch (error) {
		const { code, status, message } = error as { code?: unknown; status?: number; message: string }
		// Our own normalization of BadDeviceToken. The token is bad — that's the point.
		if (code === "expired_subscription") return undefined
		if (code === "invalid_key") {
			return "APNS_PRIVATE_KEY isn't a readable .p8. Is it the whole file, BEGIN/END lines included?"
		}
		if (code === "DeviceTokenNotForTopic" || code === "TopicDisallowed") {
			return `APNs rejected the topic. Is ${bold(args.topic)} really the app's bundle ID?`
		}
		if (code === "InvalidProviderToken" || code === "ExpiredProviderToken" || status === 403) {
			return "APNs rejected the credentials. Check the key ID and team ID belong to this .p8."
		}
		// Anything else (offline, a proxy, an Apple outage) proves nothing either way.
		return dim(`couldn't reach APNs to check: ${message}`)
	}
}
