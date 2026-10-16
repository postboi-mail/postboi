/**
 * The framework-agnostic webhook handler — `receive()` wrapped in the response contract
 * providers expect, taking the request in whichever shape a framework hands it over.
 *
 * Next.js route handlers, Cloudflare Workers and plain fetch handlers pass a web
 * `Request`; SvelteKit, Astro and Remix pass a context object carrying `.request`. One
 * handler accepts both, so the same line works in all of them:
 *
 *     export const POST = webhook((event) => { … })
 *
 * Frameworks that wrap the request deeper (Hono keeps it at `c.req.raw`) unwrap in
 * place: `app.post("/webhooks", (c) => webhook(handler)(c.req.raw))`.
 */
import { receive, handshake, resolve_adapter, WebhookVerificationError } from "./index.js"
import type { ReceiveOptions, WebhookAdapter, WebhookEvent } from "./index.js"
import { is_error } from "../errors.js"

/** A web `Request`, or any framework context that carries one — both shapes accepted. */
export type RequestCarrier = Request | { request: Request }

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})
}

/** What `receive()` and `handshake()` throwing means to the provider: 401 or 400. */
function failure(error: unknown): Response {
	if (error instanceof WebhookVerificationError) return json({ error: error.message }, 401)
	return json({ error: is_error(error) ? error.message : String(error) }, 400)
}

/**
 * Build a request handler that receives provider delivery-event webhooks: verifies the
 * signature, normalizes the payload, and calls your handler once per event.
 *
 * Responses are what providers expect: `200 {received}` on success, `401` on a failed
 * signature, `400` on an unparseable payload, and `500` when your handler throws — so
 * the provider retries. SNS subscription handshakes (SES, Scaleway) confirm themselves,
 * and a provider that checks the endpoint with a GET before subscribing (Meta) gets its
 * challenge echoed — route `GET` to the same handler for those.
 *
 * @example
 * ```ts
 * // Next.js app/webhooks/route.ts — and the identical line is an Astro APIRoute, a
 * // Remix action, a SvelteKit +server.ts export or a Worker fetch branch.
 * import { webhook } from "postboi/webhooks"
 *
 * export const POST = webhook(async (event) => {
 * 	if (event.type === "bounced") console.log(`${event.email} bounced`)
 * })
 * ```
 */
function build(
	handler: (event: WebhookEvent) => void | Promise<void>,
	options?: ReceiveOptions
): (carrier: RequestCarrier) => Promise<Response> {
	return async (carrier) => {
		const request = carrier instanceof Request ? carrier : carrier.request

		let adapter: WebhookAdapter
		let body: string
		let events: Array<WebhookEvent>
		try {
			// A provider's unsigned endpoint handshake (Meta's GET) is answered before
			// anything is read as an event. Any other GET goes on to receive() exactly as it
			// always did — a custom adapter may be answering its own provider's ping there,
			// and every stock adapter turns it away with the same 401.
			const challenge = await handshake(request, options)
			if (challenge !== undefined) {
				return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } })
			}
			// The adapter is resolved and the body read here, once, so both are still to
			// hand for a signed handshake reply after `receive` has done its work.
			adapter = await resolve_adapter(options?.provider)
			body = await request.text()
			const bodiless = request.method === "GET" || request.method === "HEAD"
			events = await receive(
				new Request(request.url, {
					method: request.method,
					headers: request.headers,
					// A web Request refuses a body on GET/HEAD, even an empty one.
					body: bodiless ? undefined : body,
				}),
				{ ...options, provider: adapter }
			)
		} catch (error) {
			return failure(error)
		}

		// A verified request that is a handshake rather than an event (SocketLabs echoes a
		// validation key, Event Grid a validation code) is answered the way the provider
		// expects.
		if (events.length === 0 && adapter.respond) {
			const reply = adapter.respond(body, { headers: request.headers, url: new URL(request.url) })
			if (reply) return reply
		}

		try {
			for (const event of events) await handler(event)
		} catch (error) {
			// A throwing handler returns 500 so the provider redelivers the event.
			const message = error instanceof Error ? error.message : String(error)
			return json({ error: message }, 500)
		}

		return adapter.accepted?.(events) ?? json({ received: events.length }, 200)
	}
}

/**
 * Node's request shape, structurally — an `IncomingMessage` matches, but nothing here
 * imports node:http, so the module stays loadable on every runtime.
 */
export interface NodeRequest extends AsyncIterable<Uint8Array> {
	method?: string
	url?: string
	headers: Record<string, string | Array<string> | undefined>
}

/** The slice of node's ServerResponse the adapter writes to. */
export interface NodeResponse {
	statusCode: number
	setHeader(name: string, value: string): void
	end(chunk: string): void
}

/**
 * The same handler as `(req, res)` middleware for Express and plain node:http — reached
 * as `webhook.node(handler)`.
 *
 * It exists because of one footgun: signatures verify over the request's **exact raw
 * bytes**, and Express body parsers rewrite them — mount `express.json()` in front of a
 * webhook route and verification fails forever, silently. This adapter reads the raw
 * stream itself, so there's no parser to misconfigure:
 *
 * ```js
 * app.post("/webhooks", webhook.node(async (event) => { … }))
 * ```
 *
 * A JSON body slips past `express.urlencoded()` untouched (wrong content-type), so the
 * common global parser is fine. Just never mount a *JSON* parser ahead of this route —
 * a parser that has already drained the stream leaves no bytes to verify.
 */
function node(
	handler: (event: WebhookEvent) => void | Promise<void>,
	options?: ReceiveOptions
): (req: NodeRequest, res: NodeResponse) => Promise<void> {
	return async (req, res) => {
		const chunks: Array<Uint8Array> = []
		for await (const chunk of req) chunks.push(chunk)
		const body = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
		let offset = 0
		for (const chunk of chunks) {
			body.set(chunk, offset)
			offset += chunk.length
		}

		const headers = new Headers()
		for (const [name, value] of Object.entries(req.headers)) {
			if (value === undefined) continue
			headers.set(name, Array.isArray(value) ? value.join(", ") : value)
		}

		// The URL only matters to adapters that sign over it — the host is a stand-in.
		const method = req.method ?? "POST"
		const request = new Request(new URL(req.url ?? "/", "http://localhost"), {
			method,
			headers,
			// A web Request refuses a body on GET/HEAD; node happily delivers one (a probe,
			// a proxy). Nothing signs over a GET body, so dropping it loses nothing.
			body: body.length && method !== "GET" && method !== "HEAD" ? body : undefined,
		})

		const response = await build(handler, options)(request)
		res.statusCode = response.status
		response.headers.forEach((value, name) => res.setHeader(name, value))
		res.end(await response.text())
	}
}

export const webhook = Object.assign(build, { node })
