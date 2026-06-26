import { title } from "./utils.js"

/**
 * A concrete email address used by providers.
 */
export type MailAddress = { address: string; name?: string }

/**
 * An email attachment payload all providers can consume.
 * content must be base64 encoded.
 */
export type MailAttachment = { name: string; content: string; mime_type: string }

/**
 * A flexible email value accepted by the public API.
 * You can pass either a plain string address or an object with an optional display name.
 * Also supports display-name format: "Full Name <email@domain>" or 'Full Name <email@domain>'.
 */
export type Email = MailAddress | string

/**
 * Options accepted by Postboi.send(...).
 *
 * Notes:
 * - Any of to/cc/bcc/reply_to can be provided as a single value or an array.
 * - For convenience, comma-separated strings are supported for `to`.
 * - If body is FormData, special keys are handled and grouped into a tidy HTML table.
 *   Special keys (excluded from the rendered body): _to, _from, _reply_to, _cc, _bcc, _subject
 *   Values for these keys may be base64 encoded; they will be decoded automatically.
 */
export interface SendOptions {
	to?: Array<Email> | Email
	from?: Email
	reply_to?: Array<Email> | Email
	cc?: Array<Email> | Email
	bcc?: Array<Email> | Email
	/** The subject of the email. */
	subject?: string
	/**
	 * The body of the email. If FormData is provided, it will be parsed:
	 * - Special email fields are extracted (see notes above)
	 * - Remaining fields are rendered into a compact HTML table with group headers
	 */
	body: string | FormData
	/**
	 * Optional plain-text alternative body. When provided alongside `body`, providers
	 * that support multipart emails will send both the HTML and plain-text versions.
	 */
	text?: string
	formatter?:
		| {
				/** Optional formatter for group (fieldset) labels when rendering FormData. Set to null/false to disable. */
				fieldset?: ((label: string) => string) | null | false
				/** Optional formatter for field labels when rendering FormData. Set to null/false to disable. */
				name?: ((label: string) => string) | null | false
		  }
		/** If null/false, disables all formatting. If undefined, defaults to the built-in `title` helper. */
		| null
		| false
	/** Attachments to include. Accepts a single File or an array of File objects. */
	attachments?: File | Array<File>
}

type SendOptionsWithEmails = Omit<SendOptions, "to" | "from"> & {
	to: NonNullable<SendOptions["to"]>
	from: NonNullable<SendOptions["from"]>
}

/** Common options shared by all provider constructors. */
export type CommonProviderOptions = {
	/** Optional default sender address used when `from` is omitted */
	default_from?: string
	/** Optional default recipient address used when `to` is omitted */
	default_to?: string
}

/** Options shared by providers that authenticate with a single API key/token. */
export type ApiKeyOptions = CommonProviderOptions & {
	/** The provider API key / token used to authenticate requests. */
	api_key: string
}

/**
 * Base class for all providers. Implements shared helpers and defines the contract.
 */
export abstract class ProviderBase<TResponse = unknown> {
	abstract send(
		options: SendOptions,
		defaults: { default_from?: string; default_to?: string }
	): Promise<TResponse>

	/** Convert a File into a base64 string. */
	protected async file_to_base64(file: File): Promise<string> {
		const array_buffer = await file.arrayBuffer()
		return Buffer.from(array_buffer).toString("base64")
	}

	/** Convert a File into a provider-agnostic attachment. */
	protected async parse_attachment(file: File): Promise<MailAttachment> {
		return {
			name: file.name,
			content: await this.file_to_base64(file),
			mime_type: file.type,
		}
	}

	/** Convert one or many Files into provider-agnostic attachments. */
	protected async parse_attachments(files: File | Array<File>): Promise<Array<MailAttachment>> {
		return Array.isArray(files)
			? await Promise.all(files.map((f) => this.parse_attachment(f)))
			: [await this.parse_attachment(files)]
	}

	/** Normalize a flexible Email value into a concrete MailAddress. */
	protected parse_email_address(email: Email): MailAddress {
		if (typeof email === "string") {
			const str = email.trim()
			// Support display-name: Name <email@domain>
			const match = str.match(/^\s*"?(.+?)"?\s*<\s*([^>]+)\s*>\s*$/)
			if (match) {
				const name = match[1].trim()
				const address = match[2].trim()
				return name ? { address, name } : { address }
			}
			return { address: str }
		}
		return { address: email.address, name: email.name }
	}

	/** Normalize a single/array/comma-separated list into an array of MailAddress. */
	protected parse_addresses(addresses: Array<Email> | Email): Array<MailAddress> {
		if (Array.isArray(addresses)) return addresses.map((a) => this.parse_email_address(a))
		if (typeof addresses === "string" && addresses.includes(","))
			return addresses
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
				.map((a) => this.parse_email_address(a))
		return [this.parse_email_address(addresses)]
	}

	/** Format a normalized address as an RFC 5322 string: `Name <address>` or `address`. */
	protected stringify_address(address: MailAddress): string {
		return address.name ? `${address.name} <${address.address}>` : address.address
	}

	/** Format a flexible Email value (single/array/comma-separated) into a comma-separated string. */
	protected stringify_addresses(addresses: Array<Email> | Email): string {
		return this.parse_addresses(addresses)
			.map((a) => this.stringify_address(a))
			.join(", ")
	}

	/** Convert a normalized address into the `{ email, name? }` shape most JSON APIs expect. */
	protected email_name(address: MailAddress): { email: string; name?: string } {
		return address.name
			? { email: address.address, name: address.name }
			: { email: address.address }
	}

	/** Map a flexible Email value into an array of `{ email, name? }` objects. */
	protected email_name_list(
		addresses: Array<Email> | Email
	): Array<{ email: string; name?: string }> {
		return this.parse_addresses(addresses).map((a) => this.email_name(a))
	}

	/** Read a Response body as JSON, tolerating empty bodies (e.g. 202 responses). */
	protected async read_json(response: Response): Promise<unknown> {
		const text = await response.text()
		if (!text) return undefined
		try {
			return JSON.parse(text)
		} catch {
			return text
		}
	}

	/** Decode a base64 string if it looks like base64, otherwise return the original. */
	protected decode_value(str: string): string {
		const base64_regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
		if (!base64_regex.test(str)) return str
		const clean = str.replace(/[\r\n]+/g, "")
		return Buffer.from(clean, "base64").toString("utf8")
	}

	/**
	 * Parse FormData, extracting special header fields and rendering the remaining
	 * data into a compact HTML table, grouped by the `fieldset→field` key syntax.
	 * Returns the extracted SendOptions (to/from/etc) along with any File attachments.
	 */
	protected async parse_form_data(
		form_data: FormData,
		formatter?:
			| {
					fieldset?: ((label: string) => string) | null | false
					name?: ((label: string) => string) | null | false
			  }
			| null
			| false
	): Promise<{ options: Partial<SendOptions>; attachments: Array<File> }> {
		const options: Partial<SendOptions> = {}
		const attachments: Array<File> = []
		const grouped = new Map<string, Map<string, string | Array<string>>>()

		// choose formatter behaviour
		const identity = (s: string) => s
		let format_fieldset: (s: string) => string
		let format_name: (s: string) => string
		if (formatter === null || formatter === false) {
			format_fieldset = identity
			format_name = identity
		} else {
			const fset = formatter?.fieldset
			const fname = formatter?.name
			format_fieldset = fset === undefined ? title : fset ? fset : identity
			format_name = fname === undefined ? title : fname ? fname : identity
		}

		for (const [key, value] of form_data.entries()) {
			if (value && typeof value === "object" && "name" in value && "type" in value) {
				const file = value as File
				// ignore empty file inputs (no name or zero length)
				const size = (file as unknown as { size?: number }).size ?? 0
				if (file.name && size > 0) attachments.push(file)
			} else if (typeof value === "string") {
				switch (key) {
					case "_to":
						options.to = this.decode_value(value)
						continue
					case "_subject":
						options.subject = this.decode_value(value)
						continue
					case "_from":
						options.from = this.decode_value(value)
						continue
					case "_reply_to":
						options.reply_to = this.decode_value(value)
						continue
					case "_cc":
						options.cc = this.decode_value(value)
						continue
					case "_bcc":
						options.bcc = this.decode_value(value)
						continue
				}

				const [fieldset, field] = key.split("→")
				if (field) {
					if (!grouped.has(fieldset)) grouped.set(fieldset, new Map())
					const map = grouped.get(fieldset)!
					const existing = map.get(field)
					if (existing) {
						if (Array.isArray(existing)) existing.push(value)
						else map.set(field, [existing, value])
					} else {
						map.set(field, value)
					}
				} else {
					if (!grouped.has("general")) grouped.set("general", new Map())
					const map = grouped.get("general")!
					const existing = map.get(key)
					if (existing) {
						if (Array.isArray(existing)) existing.push(value)
						else map.set(key, [existing, value])
					} else {
						map.set(key, value)
					}
				}
			}
		}

		if (grouped.size > 0) {
			const rows: Array<string> = []
			for (const [fieldset, fields] of grouped) {
				if (fields.size > 0) {
					if (fieldset !== "general") {
						const header_label = format_fieldset(fieldset)
						rows.push(
							`<tr><td colspan="2" style="padding: 15px 0 10px 0; font-weight: bold; font-size: 16px; border-bottom: 1px solid #ccc;">${header_label}</td></tr>`
						)
					}
					const field_rows = Array.from(fields.entries()).map(([field, value]) => {
						const label = format_name(field)
						const display = Array.isArray(value)
							? `<ul style="margin: 0; padding-left: 20px;">${value.map((v) => `<li>${v}</li>`).join("")}</ul>`
							: value
						return `<tr><td style="padding: 5px 10px 5px 0; vertical-align: top;">${label}</td><td style="padding: 5px 0;">${display}</td></tr>`
					})
					rows.push(...field_rows)
					if (fieldset !== "general")
						rows.push(`<tr><td colspan="2" style="padding: 10px 0;"></td></tr>`)
				}
			}
			options.body = `<table style="border-collapse: collapse; width: auto;">${rows.join("")}</table>`
		}

		return { options, attachments }
	}

	protected async prepare_send(
		options: SendOptions,
		defaults: { from?: string; to?: string }
	): Promise<SendOptionsWithEmails> {
		// FormData → extract headers/body/attachments
		if (options.body instanceof FormData) {
			const { options: extracted, attachments } = await this.parse_form_data(options.body)
			options = { ...options, ...extracted }
			if (attachments.length > 0) options.attachments = attachments
		}

		options.to ??= defaults.to
		options.from ??= defaults.from

		if (!options.to) throw new Error("No recipient address provided (to or default_to)")
		if (!options.from) throw new Error("No sender address provided (from or default_from)")

		return options as SendOptionsWithEmails
	}
}
