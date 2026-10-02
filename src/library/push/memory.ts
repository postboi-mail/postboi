/**
 * The endpoint this browser last filed, kept where the service worker can read it.
 *
 * Some browsers fire `pushsubscriptionchange` without the old subscription, and by then
 * `getSubscription()` already answers with the new one — so the endpoint being replaced,
 * which is the only proof of ownership a rotation carries, is gone. The page and its worker
 * share IndexedDB on one origin, so the page writes the endpoint when it files one and the
 * worker reads it back when the browser rotates it.
 *
 * Best effort throughout: a private window, a blocked store or no IndexedDB at all reads as
 * nothing remembered, and the rotation is filed the way it was before this existed.
 */

const DB = "postboi-push"
const STORE = "filed"
const KEY = "endpoint"

/** What was filed: the endpoint, and the public list it follows when it was one. */
export interface Filed {
	endpoint: string
	list?: string
}

function open(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") return Promise.resolve(null)
	return new Promise((resolve) => {
		try {
			const request = indexedDB.open(DB, 1)
			request.onupgradeneeded = () => request.result.createObjectStore(STORE)
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => resolve(null)
		} catch {
			resolve(null)
		}
	})
}

async function transact<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | undefined> {
	const db = await open()
	if (!db) return undefined
	return new Promise((resolve) => {
		try {
			const request = run(db.transaction(STORE, mode).objectStore(STORE))
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => resolve(undefined)
		} catch {
			resolve(undefined)
		} finally {
			db.close()
		}
	})
}

/** Note the subscription just filed. */
export async function remember(filed: Filed): Promise<void> {
	await transact("readwrite", (store) => store.put(filed, KEY))
}

/** The subscription last filed from this origin, if one was. */
export async function recall(): Promise<Filed | undefined> {
	const value = await transact<unknown>("readonly", (store) => store.get(KEY))
	return typeof value === "object" && value !== null && "endpoint" in value
		? (value as Filed)
		: undefined
}

/** Forget it — the browser unsubscribed. */
export async function forget(): Promise<void> {
	await transact("readwrite", (store) => store.delete(KEY))
}
