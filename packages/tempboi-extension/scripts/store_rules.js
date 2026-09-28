/**
 * The pure half of publishing to the Chrome Web Store: what version the store already
 * has, whether the manifest's is newer, and what an answer from the API means. No
 * `fetch` and no files, so store_rules.test.js tests it directly.
 */

/** Where the v2 API lives. Uploads go to the `/upload` prefix of the same host. */
export const API = "https://chromewebstore.googleapis.com"

/** The OAuth scope every call needs. */
export const SCOPE = "https://www.googleapis.com/auth/chromewebstore"

/**
 * A Chrome extension version is one to four dot-separated integers, each 0 to 65535. The
 * store refuses anything else, and it refuses a version that isn't higher than the last.
 */
export function parse_version(value) {
	if (typeof value !== "string" || !/^\d+(\.\d+){0,3}$/.test(value)) return undefined
	const parts = value.split(".").map(Number)
	return parts.every((part) => part <= 65535) ? parts : undefined
}

/** Positive when `a` is newer than `b`, negative when older, 0 when the same. */
export function compare_versions(a, b) {
	const left = parse_version(a)
	const right = parse_version(b)
	if (!left || !right) throw new TypeError(`Not an extension version: ${!left ? a : b}`)
	for (let n = 0; n < 4; n++) {
		const diff = (left[n] ?? 0) - (right[n] ?? 0)
		if (diff) return diff
	}
	return 0
}

/**
 * The highest version the store holds for the item, submitted or published, from a
 * `:fetchStatus` answer. Undefined for an item that has never had a package.
 */
export function store_version(status) {
	const versions = [status?.submittedItemRevisionStatus, status?.publishedItemRevisionStatus]
		.flatMap((revision) => revision?.distributionChannels ?? [])
		.map((channel) => channel?.crxVersion)
		.filter((version) => parse_version(version))
	return versions.sort(compare_versions).at(-1)
}

/**
 * What to do with the manifest's version against the store's: upload it, or say why not.
 * Pushing a manifest change that didn't move the version is the ordinary case of the
 * latter (a description edit), so it is a skip rather than a failure.
 */
export function plan(manifest_version, status) {
	if (!parse_version(manifest_version))
		return {
			upload: false,
			fail: true,
			reason: `manifest.json's version "${manifest_version}" isn't one the store accepts.`,
		}
	const current = store_version(status)
	if (current && compare_versions(manifest_version, current) <= 0)
		return {
			upload: false,
			fail: false,
			reason: `The store already has ${current}. Raise "version" in manifest.json above it to publish.`,
		}
	const pending = status?.submittedItemRevisionStatus?.state === "PENDING_REVIEW"
	if (pending)
		return {
			upload: false,
			fail: true,
			reason: `${store_version(status)} is still in review. Cancel that submission in the Developer Dashboard, or wait for it, before sending ${manifest_version}.`,
		}
	return {
		upload: true,
		fail: false,
		reason: current ? `${current} → ${manifest_version}` : `First package: ${manifest_version}`,
	}
}

/** Whether an upload is done, and whether it worked, from `uploadState`. */
export function upload_outcome(state) {
	if (state === "SUCCEEDED") return "done"
	if (state === "IN_PROGRESS" || state === "UPLOAD_STATE_UNSPECIFIED" || !state) return "waiting"
	return "failed"
}

/** A publish answer's state, said the way a person reads it, and whether it is a failure. */
export function publish_outcome(state) {
	const said = {
		PENDING_REVIEW: "Submitted. It's in review, and goes live when Google approves it.",
		STAGED: "Approved and staged. Publish it from the Developer Dashboard when you're ready.",
		PUBLISHED: "Published.",
		PUBLISHED_TO_TESTERS: "Published to trusted testers.",
		REJECTED: "Rejected. The Developer Dashboard says why.",
		CANCELLED: "The submission was cancelled.",
	}[state]
	return {
		said: said ?? `The store answered ${state ?? "nothing"}.`,
		failed: state === "REJECTED" || !said,
	}
}

/** The publish request's body. `staged` holds an approved version back until it's released by hand. */
export function publish_body({ staged = false } = {}) {
	return { publishType: staged ? "STAGED_PUBLISH" : "DEFAULT_PUBLISH" }
}
