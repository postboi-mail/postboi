/**
 * A tiny, dependency-free user-agent reader for open/click events. Providers hand us the
 * raw user-agent string; this derives "opened in Apple Mail on an iPhone" locally — a pure
 * function, no lookup service, no network.
 */

/** The email client (or proxy/browser) behind an open or click event. */
export interface EmailClient {
	/** Client name, e.g. "Apple Mail", "Gmail", "Outlook". Undefined when unrecognisable. */
	name?: string
	/** Operating system, e.g. "iOS", "macOS", "Windows". Proxied opens rarely reveal one. */
	os?: string
	/** Device class. Proxied opens (Gmail, Yahoo) hide the device — "unknown". */
	device: "desktop" | "mobile" | "tablet" | "unknown"
	/** The raw user-agent string, for anything the parser doesn't surface. */
	user_agent: string
}

// Image proxies fetch the tracking pixel on the recipient's behalf — the real device
// is invisible, but the proxy itself identifies the mailbox provider.
const PROXIES: Array<[RegExp, string]> = [
	[/GoogleImageProxy/i, "Gmail"],
	[/YahooMailProxy|YahooCacheSystem/i, "Yahoo Mail"],
	[/FrontApp/i, "Front"],
	[/HeyImageProxy/i, "HEY"],
]

const CLIENTS: Array<[RegExp, string]> = [
	[/Outlook-iOS/i, "Outlook"],
	[/Outlook-Android/i, "Outlook"],
	[/Microsoft Outlook|MSOffice \d|Microsoft Office/i, "Outlook"],
	[/Thunderbird/i, "Thunderbird"],
	[/Evolution\//i, "Evolution"],
	[/Airmail/i, "Airmail"],
	[/Sparrow/i, "Sparrow"],
	[/Superhuman/i, "Superhuman"],
	// Browsers (a click landing in a real browser, or webmail).
	[/Edg(e|A|iOS)?\//i, "Edge"],
	[/OPR\/|Opera/i, "Opera"],
	[/SamsungBrowser/i, "Samsung Internet"],
	[/CriOS\//i, "Chrome"],
	[/Chrome\//i, "Chrome"],
	[/FxiOS\//i, "Firefox"],
	[/Firefox\//i, "Firefox"],
]

function client_name(ua: string): string | undefined {
	for (const [pattern, name] of PROXIES) if (pattern.test(ua)) return name
	for (const [pattern, name] of CLIENTS) if (pattern.test(ua)) return name
	// Apple Mail: WebKit on an Apple platform with no browser token. Mobile opens
	// often report "Mozilla/5.0 (iPhone ...) AppleWebKit/... (KHTML, like Gecko)".
	if (
		/AppleWebKit/i.test(ua) &&
		/iPhone|iPad|Macintosh|Mac OS X/i.test(ua) &&
		!/Chrome|CriOS|Safari\//i.test(ua)
	) {
		return "Apple Mail"
	}
	if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return "Safari"
	return undefined
}

function os_name(ua: string): string | undefined {
	if (/iPhone|iPod|\biOS\b/i.test(ua)) return "iOS"
	if (/iPad/i.test(ua)) return "iPadOS"
	if (/Android/i.test(ua)) return "Android"
	if (/Windows/i.test(ua)) return "Windows"
	if (/Macintosh|Mac OS X/i.test(ua)) return "macOS"
	if (/CrOS/i.test(ua)) return "ChromeOS"
	if (/Linux|X11/i.test(ua)) return "Linux"
	return undefined
}

function device_class(ua: string): EmailClient["device"] {
	if (/iPad|Tablet/i.test(ua)) return "tablet"
	if (/iPhone|iPod|Mobile|Android|\biOS\b/i.test(ua)) return "mobile"
	if (/Macintosh|Windows|CrOS|X11|Linux/i.test(ua)) return "desktop"
	return "unknown"
}

/**
 * Derive the email client, OS and device class from a user-agent string. Returns
 * undefined for an absent/empty user-agent. Proxied opens (Gmail, Yahoo) identify the
 * mailbox provider but hide the device — expect `device: "unknown"` there.
 */
export function parse_user_agent(user_agent: string | undefined | null): EmailClient | undefined {
	if (!user_agent) return undefined
	const proxied = PROXIES.some(([pattern]) => pattern.test(user_agent))
	return {
		name: client_name(user_agent),
		os: proxied ? undefined : os_name(user_agent),
		device: proxied ? "unknown" : device_class(user_agent),
		user_agent,
	}
}
