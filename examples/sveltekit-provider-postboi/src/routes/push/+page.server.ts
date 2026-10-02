/** The demo's stand-in for a signed-in user: a random id, kept in a cookie. */
export function load({ cookies }) {
	if (!cookies.get("demo_user")) {
		cookies.set("demo_user", crypto.randomUUID(), { path: "/", httpOnly: true, sameSite: "lax" })
	}
}
