import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { api_command } from "./api.js"
import { configure, reset_config } from "../library/config.js"
import { strip_ansi } from "./prompts.js"
import {
	add_web_hide,
	containing_element,
	detect_variables,
	feed_setup,
	find_link_target,
	find_system_variables,
	infer_enums,
	reader_paths,
	set_href,
	view_link,
	views_io,
	VIEW_PROVIDERS,
} from "./views.js"

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

/** The shape of pregmail's week-keyed OneSignal email. */
const PREGNANCY = `<html><body>
{%- assign week = user.tags.pregnancy_week -%}
{%- assign body = dynamic_content.pregnancy_body[week] -%}
<table><tr><td>
<p class="small"><a href="#" class="small text-smokey">View   in
 browser</a></p>
<h1>Week {{ week }}: {{ body.hero_metrics_size }}</h1>
{% if body.tip_text %}<p>{{ body.tip_text }}</p>{% endif %}
<p>Hi {{ user.tags.first_name | default: "there" | capitalize }}</p>
<p class="footer">Don't want these? <a href="https://unsubscribe.pregnancy.plus/{{ subscription.language }}?notification_id={{ message.id }}&token={{ subscription.unsubscribe_token }}">unsubscribe here</a></p>
</td></tr></table>
</body></html>`

const CONTEXT = {
	dynamic_content: {
		pregnancy_body: { "4": { tip_text: "a" }, "5": { tip_text: "b" }, "": {} },
	},
}

describe("detecting variables", () => {
	it("reads outputs, tags and filter arguments, but not filter names or keywords", () => {
		const found = detect_variables(
			`{{ user.first_name | default: user.nickname | upcase }}
			{% if account.plan == "pro" and not account.trial %}{% elsif account.legacy %}{% endif %}
			{% unless order.paid %}{% endunless %}
			{% case order.status %}{% when "shipped", other.status %}{% endcase %}
			{% for item in order.items limit: order.limit %}{{ item.name }} {{ forloop.index }}{% endfor %}
			{% capture greeting %}Hi{% endcapture %}{{ greeting }}
			{% raw %}{{ not.this }}{% endraw %}{% comment %}{{ nor.this }}{% endcomment %}
			{%- liquid
				assign total = order.total | plus: shipping.cost
				echo total
			-%}`
		)
		expect(reader_paths(found, undefined)).toEqual([
			"user.first_name",
			"user.nickname",
			"account.plan",
			"account.trial",
			"account.legacy",
			"order.paid",
			"order.status",
			"other.status",
			"order.items",
			"order.limit",
			"order.total",
			"shipping.cost",
		])
	})

	it("follows assigns into index access, and leaves context and system variables out", () => {
		const found = detect_variables(PREGNANCY)
		expect(found.aliases.get("week")).toBe("user.tags.pregnancy_week")
		expect(found.indexes).toEqual([{ collection: "dynamic_content.pregnancy_body", by: "week" }])
		expect(reader_paths(found, CONTEXT)).toEqual([
			"user.tags.pregnancy_week",
			"user.tags.first_name",
		])
	})

	it("infers an enum from the context's keys, named after the assign", () => {
		expect(infer_enums(detect_variables(PREGNANCY), CONTEXT)).toEqual([
			{ path: "user.tags.pregnancy_week", name: "week", values: ["4", "5"] },
		])
		// A direct index names the param after the path's last segment.
		expect(
			infer_enums(detect_variables("{{ days[user.day].title }}"), { days: { mon: 1, tue: 2 } })
		).toEqual([{ path: "user.day", name: "day", values: ["mon", "tue"] }])
		// No context, nothing to infer.
		expect(infer_enums(detect_variables(PREGNANCY), undefined)).toEqual([])
	})

	it("reads Braze's ${…} attributes and what connected_content saves", () => {
		const found = detect_variables(
			`{% connected_content https://x.test?id={{\${user_id}}} :save offer %}{{custom_attribute.\${week}}} {{\${first_name}}} {{ offer.title }}`
		)
		expect(reader_paths(found, undefined)).toEqual([
			"user_id",
			"custom_attribute.week",
			"first_name",
		])
	})
})

describe("system variables", () => {
	const cases: Array<[string, string]> = [
		["onesignal", '<a href="https://x.test/u?t={{ subscription.unsubscribe_token }}">u</a>'],
		["braze", '<a href="{{${set_user_to_unsubscribed_url}}}">u</a>'],
		["customerio", '<a href="{% unsubscribe_url %}">u</a>'],
		["klaviyo", '<a href="{% unsubscribe_link %}">u</a>'],
		["mailchimp", '<a href="*|UNSUB|*">u</a>'],
		["iterable", '<a href="{{unsubscribeUrl}}">u</a>'],
		["sendgrid", '<a href="<%asm_group_unsubscribe_raw_url%>">u</a>'],
	]
	for (const [provider, html] of cases) {
		it(`finds ${provider}'s, in the anchor that holds it`, () => {
			const found = find_system_variables(`<p>Bye ${html}</p>`)
			expect(found.map((s) => s.provider)).toContain(provider)
			expect(found[0].element?.name).toBe("a")
		})
	}

	it("names the element by line, and data-web-hide goes on it once", () => {
		const found = find_system_variables(PREGNANCY)
		expect(found.map((s) => s.match)).toEqual([
			"{{ subscription.language }}",
			"{{ message.id }}",
			"{{ subscription.unsubscribe_token }}",
		])
		const element = found[0].element!
		expect(element.line).toBe(10)
		expect(element.tag).toMatch(/^<a href="https:\/\/unsubscribe\.pregnancy\.plus/)
		const hidden = add_web_hide(
			PREGNANCY,
			found.map((s) => s.element!)
		)
		expect(hidden).toContain('<a data-web-hide href="https://unsubscribe.pregnancy.plus/')
		expect(hidden.match(/data-web-hide/g)).toHaveLength(1)
		// Everything else is byte for byte what it was.
		expect(hidden.replace(" data-web-hide", "")).toBe(PREGNANCY)
		// Already hidden by an ancestor: nothing to add.
		expect(find_system_variables(hidden)[0].element?.hidden).toBe(true)
	})

	it("finds text inside nested, sloppily closed markup", () => {
		const html = "<div><table><tr><td><p>Hi {{ message.id }}</td></tr></table></div>"
		expect(containing_element(html, html.indexOf("{{"))?.name).toBe("p")
	})
})

describe("links", () => {
	const params = {
		week: { path: "pregnancy_week", type: "enum" as const, values: ["4"] },
	}
	const url = "https://view.postboi.app/acct/postpartum"

	it("writes the link in each sender's merge syntax, encoded", () => {
		const links = Object.fromEntries(
			VIEW_PROVIDERS.map((p) => [p, view_link(p, url, params, false)])
		)
		expect(links).toMatchInlineSnapshot(`
			{
			  "braze": "https://view.postboi.app/acct/postpartum?week={{\${pregnancy_week} | url_param_escape}}",
			  "customerio": "https://view.postboi.app/acct/postpartum?week={{ customer.pregnancy_week | url_encode }}",
			  "iterable": "https://view.postboi.app/acct/postpartum?week={{#urlEncode}}{{pregnancy_week}}{{/urlEncode}}",
			  "klaviyo": "https://view.postboi.app/acct/postpartum?week={{ person|lookup:'pregnancy_week'|urlencode }}",
			  "mailchimp": "https://view.postboi.app/acct/postpartum?week=*|URL:PREGNANCY_WEEK|*",
			  "none": "https://view.postboi.app/acct/postpartum",
			  "onesignal": "https://view.postboi.app/acct/postpartum?week={{ user.tags.pregnancy_week | url_encode }}",
			  "sendgrid": "https://view.postboi.app/acct/postpartum?week={{pregnancy_week}}",
			}
		`)
		expect(
			view_link("braze", url, { week: { path: "custom_attribute.week", type: "date" } }, false)
		).toMatchInlineSnapshot(
			`"https://view.postboi.app/acct/postpartum?week={{custom_attribute.\${week} | url_param_escape}}"`
		)
		expect(
			view_link("braze", url, { week: { path: "event_properties.week", type: "date" } }, false)
		).toMatchInlineSnapshot(
			`"https://view.postboi.app/acct/postpartum?week={{event_properties.\${week} | url_param_escape}}"`
		)
	})

	it("starts from the feed's answer where the sender can fetch one", () => {
		const links = Object.fromEntries(
			VIEW_PROVIDERS.map((p) => [p, view_link(p, url, params, true)])
		)
		expect(links).toMatchInlineSnapshot(`
			{
			  "braze": "{{ postboi_view.url }}&week={{\${pregnancy_week} | url_param_escape}}",
			  "customerio": "https://view.postboi.app/acct/postpartum?week={{ customer.pregnancy_week | url_encode }}",
			  "iterable": "[[url]]&week={{#urlEncode}}{{pregnancy_week}}{{/urlEncode}}",
			  "klaviyo": "https://view.postboi.app/acct/postpartum?week={{ person|lookup:'pregnancy_week'|urlencode }}",
			  "mailchimp": "https://view.postboi.app/acct/postpartum?week=*|URL:PREGNANCY_WEEK|*",
			  "none": "https://view.postboi.app/acct/postpartum",
			  "onesignal": "{{ data_feed.postboi_view.url }}&week={{ user.tags.pregnancy_week | url_encode }}",
			  "sendgrid": "https://view.postboi.app/acct/postpartum?week={{pregnancy_week}}",
			}
		`)
	})

	it("adds the reader's id as u in each sender's syntax, after the params", () => {
		const links = Object.fromEntries(
			VIEW_PROVIDERS.map((p) => [p, view_link(p, url, params, false, "external_id")])
		)
		expect(links).toMatchInlineSnapshot(`
			{
			  "braze": "https://view.postboi.app/acct/postpartum?week={{\${pregnancy_week} | url_param_escape}}&u={{\${external_id} | url_param_escape}}",
			  "customerio": "https://view.postboi.app/acct/postpartum?week={{ customer.pregnancy_week | url_encode }}&u={{ customer.external_id | url_encode }}",
			  "iterable": "https://view.postboi.app/acct/postpartum?week={{#urlEncode}}{{pregnancy_week}}{{/urlEncode}}&u={{#urlEncode}}{{external_id}}{{/urlEncode}}",
			  "klaviyo": "https://view.postboi.app/acct/postpartum?week={{ person|lookup:'pregnancy_week'|urlencode }}&u={{ person|lookup:'external_id'|urlencode }}",
			  "mailchimp": "https://view.postboi.app/acct/postpartum?week=*|URL:PREGNANCY_WEEK|*&u=*|URL:EXTERNAL_ID|*",
			  "none": "https://view.postboi.app/acct/postpartum",
			  "onesignal": "https://view.postboi.app/acct/postpartum?week={{ user.tags.pregnancy_week | url_encode }}&u={{ user.tags.external_id | url_encode }}",
			  "sendgrid": "https://view.postboi.app/acct/postpartum?week={{pregnancy_week}}&u={{external_id}}",
			}
		`)
		// With a feed it rides after the feed's ?r=, and with no params it starts the query.
		expect(view_link("onesignal", url, params, true, "external_id")).toMatchInlineSnapshot(
			`"{{ data_feed.postboi_view.url }}&week={{ user.tags.pregnancy_week | url_encode }}&u={{ user.tags.external_id | url_encode }}"`
		)
		expect(view_link("braze", url, {}, false, "custom_attribute.user_id")).toMatchInlineSnapshot(
			`"https://view.postboi.app/acct/postpartum?u={{custom_attribute.\${user_id} | url_param_escape}}"`
		)
	})

	it("prints each feed setup with the key in its header", () => {
		const setups = Object.fromEntries(
			VIEW_PROVIDERS.map((p) => [
				p,
				feed_setup(p, "https://postboi.app", "postpartum", { first_name: "first_name" }, "pbf_x"),
			])
		)
		expect(setups).toMatchInlineSnapshot(`
			{
			  "braze": [
			    "Braze: put this at the top of the email's body (Connected Content):",
			    "  {% connected_content https://postboi.app/v1/views/postpartum/link :method post :headers {"Authorization": "Bearer pbf_x"} :body first_name={{\${first_name}}} :content_type application/json :save postboi_view %}",
			    "The link reads it as postboi_view.url.",
			  ],
			  "customerio": undefined,
			  "iterable": [
			    "Iterable: Content → Data Feeds → New Data Feed",
			    "  Name     postboi_view",
			    "  URL      https://postboi.app/v1/views/postpartum/link?first_name={{#urlEncode}}{{first_name}}{{/urlEncode}}",
			    "  Format   JSON",
			    "  Header   Authorization: Bearer pbf_x",
			    "Then turn it on in the template's settings (Data feeds). The link reads it as [[url]].",
			  ],
			  "klaviyo": undefined,
			  "mailchimp": undefined,
			  "none": undefined,
			  "onesignal": [
			    "OneSignal: Messages → Data Feeds → New Data Feed",
			    "  Name     Postboi view link",
			    "  Alias    postboi_view",
			    "  Method   GET",
			    "  URL      https://postboi.app/v1/views/postpartum/link?first_name={{ user.tags.first_name | url_encode }}",
			    "  Header   Authorization: Bearer pbf_x",
			    "Then pick it as the template's data feed. The link reads it as data_feed.postboi_view.url.",
			    "OneSignal skips a recipient whose feed call fails, so this feed now sits on the send path.",
			  ],
			  "sendgrid": undefined,
			}
		`)
	})
})

describe("placing the link", () => {
	const LINK = "https://view.test/x?week={{ user.tags.week | url_encode }}"

	it("prefers the element marked data-postboi-view-link, then the anchor inside it", () => {
		const html = `<a href="#">View in browser</a><td data-postboi-view-link><b>Web</b> <a class="w">version</a></td>`
		const target = find_link_target(html)!
		expect(target.rule).toBe("marker")
		expect(set_href(html, target.element, LINK)).toBe(
			`<a href="#">View in browser</a><td data-postboi-view-link><b>Web</b> <a href="${LINK}" class="w">version</a></td>`
		)
		const marked = `<a data-postboi-view-link href='old'>Open</a>`
		expect(set_href(marked, find_link_target(marked)!.element, LINK)).toBe(
			`<a data-postboi-view-link href="${LINK}">Open</a>`
		)
	})

	it("falls back to the anchor reading View in browser, whatever its case and spacing", () => {
		const target = find_link_target(PREGNANCY)!
		expect(target.rule).toBe("text")
		const next = set_href(PREGNANCY, target.element, LINK)
		expect(next).toContain(`<a href="${LINK}" class="small text-smokey">View   in\n browser</a>`)
		expect(next.replace(`href="${LINK}"`, 'href="#"')).toBe(PREGNANCY)
	})

	it("finds nothing when there is no place for it", () => {
		expect(find_link_target("<p>View in browser</p><a href='#'>View online</a>")).toBeUndefined()
	})
})

describe("postboi views", () => {
	type Route = (body: unknown) => unknown
	function serve(routes: Record<string, unknown>) {
		const calls: Array<{ key: string; body?: unknown; auth?: string }> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubEnv("POSTBOI_API_URL", "https://api.test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const url = new URL(input)
				const key = `${init?.method ?? "GET"} ${url.pathname}`
				const body = init?.body ? JSON.parse(String(init.body)) : undefined
				calls.push({ key, body })
				const route = routes[key]
				// A bare 404, like a server with no such route.
				if (route === undefined) return new Response("Not found", { status: 404 })
				const answer = typeof route === "function" ? (route as Route)(body) : route
				return answer instanceof Response ? answer : new Response(JSON.stringify(answer))
			})
		)
		vi.spyOn(views_io, "interactive").mockReturnValue(false)
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		return { calls, lines, text: () => lines.join("\n") }
	}

	const view = (body: { slug: string; params: unknown; feed?: unknown }) => ({
		slug: body.slug,
		url: `https://view.postboi.app/acct/${body.slug}`,
		version: 2,
		variables: [],
		params: body.params,
		feed: body.feed,
		syntax: "liquid",
		created_at: "2026-10-08T00:00:00Z",
		updated_at: "2026-10-08T00:00:00Z",
	})

	function workspace(html = PREGNANCY) {
		const dir = mkdtempSync(join(tmpdir(), "postboi-views-"))
		const file = join(dir, "postpartum_uk.html")
		writeFileSync(file, html)
		const context = join(dir, "context.json")
		writeFileSync(context, JSON.stringify(CONTEXT))
		return { file, context }
	}

	it("publishes with an inferred enum, hides the unsubscribe link and writes the view link", async () => {
		const { file, context } = workspace()
		const { calls, text } = serve({
			"POST /v1/views": (body: never) => view(body),
		})
		await api_command("views", [
			"publish",
			file,
			"--context",
			context,
			"--provider",
			"onesignal",
			"--public",
			"first_name:enum",
			"--write",
			"--yes",
		]).catch((error) => expect(error.code).toBe("enum_values_needed"))

		// first_name can't be an enum without context to read values from; publish again without it.
		await api_command("views", ["publish", file, "--context", context, "--write", "--yes"])
		const post = calls.find((c) => c.key === "POST /v1/views")!.body as Record<string, never>
		expect(post.slug).toBe("postpartum-uk")
		expect(post.params).toEqual({
			week: { path: "user.tags.pregnancy_week", type: "enum", values: ["4", "5"] },
		})
		expect(post.feed).toEqual({ fields: { first_name: "user.tags.first_name" } })
		expect(post.context).toEqual(CONTEXT)
		expect(post.html).toContain("<a data-web-hide href=")

		const written = readFileSync(file, "utf8")
		expect(written).toContain(
			'<a href="{{ data_feed.postboi_view.url }}&week={{ user.tags.pregnancy_week | url_encode }}" class="small text-smokey">'
		)
		expect(written).toContain("<a data-web-hide href=")
		// The feed key route isn't on this server: the setup still prints, with a placeholder.
		expect(text()).toContain("Alias    postboi_view")
		expect(text()).toContain("Authorization: Bearer <your feed key, pbf_…>")
		expect(text()).toContain("Feed keys aren't on this Postboi server yet")
	})

	it("warns when a OneSignal email already reads another data feed", async () => {
		const { file } = workspace("<p>{{ user.tags.first_name }} {{ data_feed.ad.headline }}</p>")
		const { text } = serve({
			"POST /v1/views": (body: never) => view(body),
			"GET /v1/views/keys": { data: [{ id: "fk_1", kind: "feed" }] },
		})
		await api_command("views", ["publish", file])
		expect(text()).toContain("<your feed key, pbf_…>")
		expect(text()).toContain("already reads data_feed.ad")
	})

	it("mints a feed key on first use and reuses the last version's choices", async () => {
		const { file } = workspace("<p>{{ user.tags.plan }} {{ user.tags.first_name }}</p>")
		const { calls, text } = serve({
			"GET /v1/views/postpartum-uk": {
				...view({ slug: "postpartum-uk", params: {} }),
				params: { tier: { path: "user.tags.plan", type: "enum", values: ["free", "pro"] } },
				feed: { fields: { name: "user.tags.first_name" } },
			},
			"POST /v1/views": (body: never) => view(body),
			"GET /v1/views/keys": { data: [] },
			"POST /v1/views/keys": { id: "fk_1", kind: "feed", key: "pbf_secret" },
		})
		await api_command("views", ["publish", file, "--provider", "braze"])
		const post = calls.find((c) => c.key === "POST /v1/views")!.body as Record<string, never>
		expect(post.params).toEqual({
			tier: { path: "user.tags.plan", type: "enum", values: ["free", "pro"] },
		})
		expect(post.feed).toEqual({ fields: { name: "user.tags.first_name" } })
		expect(calls.find((c) => c.key === "POST /v1/views/keys")?.body).toEqual({ kind: "feed" })
		expect(text()).toContain('"Authorization": "Bearer pbf_secret"')
		expect(text()).toContain("{{ postboi_view.url }}")
	})

	it("refuses free text as a public param, and asks for a type it can't infer", async () => {
		const { file } = workspace("<p>{{ user.tags.first_name }}</p>")
		serve({})
		await expect(
			api_command("views", ["publish", file, "--public", "first_name:text"])
		).rejects.toMatchObject({ code: "free_text_param", message: expect.stringContaining("feed") })
		await expect(
			api_command("views", ["publish", file, "--public", "first_name"])
		).rejects.toMatchObject({ code: "param_type_needed" })
		await expect(
			api_command("views", ["publish", file, "--public", "nope:integer"])
		).rejects.toMatchObject({ code: "unknown_variable" })
	})

	it("types a public param and prints where the link would go without --write", async () => {
		const { file } = workspace(
			"<p>Day {{ user.tags.day }}</p><a href='{{ subscription.unsubscribe_token }}'>bye</a>"
		)
		const { calls, text } = serve({ "POST /v1/views": (body: never) => view(body) })
		await api_command("views", ["publish", file, "--public", "day:integer", "--json"])
		const post = calls.find((c) => c.key === "POST /v1/views")!.body as Record<string, never>
		expect(post.params).toEqual({ day: { path: "user.tags.day", type: "integer" } })
		const out = JSON.parse(text())
		expect(out.provider).toBe("onesignal")
		expect(out.link).toBe(
			"https://view.postboi.app/acct/postpartum-uk?day={{ user.tags.day | url_encode }}"
		)
		expect(out.system[0]).toMatchObject({ line: 1, hidden: false })
		expect(readFileSync(file, "utf8")).not.toContain("data-web-hide")
	})

	it("says plainly when the server has no views yet", async () => {
		const { file } = workspace()
		serve({})
		await expect(api_command("views", ["publish", file])).rejects.toMatchObject({
			code: "views_unavailable",
			message: expect.stringContaining("POST /v1/views yet"),
		})
		await expect(api_command("views", [])).rejects.toMatchObject({ code: "views_unavailable" })
		await expect(api_command("views", ["keys"])).rejects.toMatchObject({
			code: "views_unavailable",
		})
	})

	it("lists, deletes, and mints keys", async () => {
		const { calls, text } = serve({
			"GET /v1/views": { data: [view({ slug: "welcome", params: {} })], has_more: false },
			"DELETE /v1/views/welcome": new Response(null, { status: 204 }),
			"POST /v1/views/keys": { id: "fk_2", kind: "feed", key: "pbf_new" },
			"POST /v1/views/keys/rotate": { id: "vk_2", kind: "view", key: "pbv_vk2_x" },
		})
		await api_command("views", ["list"])
		await api_command("views", ["delete", "welcome"])
		await api_command("views", ["feed-key"])
		await api_command("views", ["keys", "rotate"])
		expect(calls.map((c) => c.key)).toEqual([
			"GET /v1/views",
			"DELETE /v1/views/welcome",
			"POST /v1/views/keys",
			"POST /v1/views/keys/rotate",
		])
		expect(text()).toContain("https://view.postboi.app/acct/welcome")
		expect(text()).toContain("pbf_new")
		expect(text()).toContain("postboi sync")
	})

	it("puts the reader param on the link and the publish, from the flag or the config", async () => {
		const { file } = workspace("<p>Day {{ user.tags.day }}</p><a href='#'>View in browser</a>")
		const { calls, text, lines } = serve({
			"POST /v1/views": (body: never) => ({
				...view(body),
				reader: (body as { reader?: boolean }).reader ?? false,
			}),
		})
		await api_command("views", [
			"publish",
			file,
			"--public",
			"day:integer",
			"--reader",
			"external_id",
			"--write",
		])
		const post = () =>
			calls.filter((c) => c.key === "POST /v1/views").at(-1)!.body as Record<string, never>
		expect(post().reader).toBe(true)
		expect(readFileSync(file, "utf8")).toContain(
			'href="https://view.postboi.app/acct/postpartum-uk?day={{ user.tags.day | url_encode }}&u={{ user.tags.external_id | url_encode }}"'
		)
		expect(text()).toContain("a claim, not proof")
		expect(text()).not.toContain("doesn't read u yet")

		// Published again, the `u=` the link now carries isn't a variable the page reads.
		await api_command("views", [
			"publish",
			file,
			"--public",
			"day:integer",
			"--reader",
			"external_id",
		])
		expect(post().feed).toBeUndefined()

		// Saved in postboi.config.ts, it needs no flag; `off` there turns it off again.
		configure({ views: { "postpartum-uk": { reader: "user.external_id" } } })
		try {
			lines.length = 0
			await api_command("views", ["publish", file, "--public", "day:integer", "--json"])
			expect(post().reader).toBe(true)
			expect(JSON.parse(text()).link).toContain("&u={{ user.external_id | url_encode }}")
		} finally {
			reset_config()
		}
		await api_command("views", ["publish", file, "--public", "day:integer", "--reader", "off"])
		expect(post().reader).toBeUndefined()
		await expect(
			api_command("views", ["publish", file, "--reader", "not a path"])
		).rejects.toMatchObject({ code: "invalid_reader" })

		// u is the reader's: a public param can't take the name, as the server refuses too.
		const clash = workspace("<p>{{ user.tags.u }}</p>").file
		const posts = calls.length
		await expect(
			api_command("views", ["publish", clash, "--public", "u:integer", "--reader", "external_id"])
		).rejects.toMatchObject({ code: "reader_param_clash" })
		expect(calls.slice(posts).map((c) => c.key)).not.toContain("POST /v1/views")
	})

	it("keeps the reader param on from the last version, and says when the server ignores it", async () => {
		const { file } = workspace("<p>{{ user.tags.day }}</p>")
		const { calls, text } = serve({
			"GET /v1/views/postpartum-uk": {
				...view({ slug: "postpartum-uk", params: {} }),
				params: { day: { path: "user.tags.day", type: "integer" } },
				reader: true,
			},
			// A server from before the reader param answers without it.
			"POST /v1/views": (body: never) => view(body),
		})
		await api_command("views", ["publish", file])
		expect(
			(calls.find((c) => c.key === "POST /v1/views")!.body as { reader?: boolean }).reader
		).toBe(true)
		expect(text()).toContain("no path: pass --reader <path>")
		expect(text()).toContain("doesn't read u yet")

		// --write without the path would drop the `u=` the link carries, so it stops first.
		writeFileSync(
			file,
			"<p>{{ user.tags.day }}</p><a href='https://x/?u={{ id }}'>View in browser</a>"
		)
		await expect(api_command("views", ["publish", file, "--write"])).rejects.toMatchObject({
			code: "reader_path_needed",
		})
		expect(calls.filter((c) => c.key === "POST /v1/views")).toHaveLength(1)
	})

	it("stops when the last version can't be read, rather than dropping its choices", async () => {
		const { file } = workspace("<p>{{ user.tags.day }}</p>")
		const { calls } = serve({
			"GET /v1/views/postpartum-uk": new Response(JSON.stringify({ code: "internal" }), {
				status: 500,
			}),
			"POST /v1/views": (body: never) => view(body),
		})
		await expect(api_command("views", ["publish", file])).rejects.toMatchObject({
			code: "internal",
		})
		expect(calls.map((c) => c.key)).toEqual(["GET /v1/views/postpartum-uk"])
	})

	it("prints a view's stats: days, params and identified", async () => {
		const stats = {
			days: [
				{ day: "2026-10-06", views: 12, visitors: 9 },
				{ day: "2026-10-07", views: 30, visitors: 21 },
			],
			params: [
				{ params: "week=20", views: 25, visitors: 18 },
				{ params: "", views: 17, visitors: 12 },
			],
			identified: 7,
		}
		const { calls, text, lines } = serve({ "GET /v1/views/welcome/stats": stats })
		await api_command("views", ["stats", "welcome", "--days", "7"])
		expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).search).toBe("?days=7")
		expect(calls.map((c) => c.key)).toEqual(["GET /v1/views/welcome/stats"])
		expect(strip_ansi(text())).toMatchInlineSnapshot(`
			"welcome  42 views in the last 7 days, 7 identified

			  DAY         VIEWS  VISITORS
			  2026-10-06  12     9
			  2026-10-07  30     21

			  PARAMS   VIEWS  VISITORS
			  week=20  25     18
			  (none)   17     12

			Visitors are counted per day, so they don't add up across days."
		`)

		lines.length = 0
		await api_command("views", ["stats", "welcome", "--json"])
		expect(JSON.parse(text())).toEqual(stats)
		expect(new URL(String(vi.mocked(fetch).mock.calls[1][0])).search).toBe("")

		await expect(api_command("views", ["stats", "welcome", "--days", "400"])).rejects.toMatchObject(
			{ code: "invalid_days" }
		)
	})

	it("says when a view has no views yet, and when the server can't count them", async () => {
		const { text } = serve({
			"GET /v1/views/quiet/stats": { days: [], params: [], identified: 0 },
		})
		await api_command("views", ["stats", "quiet"])
		expect(text()).toContain("No views of quiet in the last 30 days.")
		await expect(api_command("views", ["stats", "welcome"])).rejects.toMatchObject({
			code: "views_unavailable",
			message: expect.stringContaining("GET /v1/views/welcome/stats yet"),
		})
	})
})
