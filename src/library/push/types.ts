/**
 * The push channel's public types.
 *
 * Free of runtime imports so the package root can widen `Hooks` to include
 * {@link PreparedPush} without pulling a push provider into the email module graph.
 */
import type { TransportOptions } from "../transport.js"

/**
 * A Web Push subscription, exactly as `PushManager.subscribe()` hands it back. Store it
 * verbatim — the keys are what the payload is encrypted against.
 */
export interface WebPushSubscription {
	/** Push service URL. Per-subscription, so there is no fixed provider host. */
	endpoint: string
	keys: {
		/** The client's P-256 public key, base64url. */
		p256dh: string
		/** The client's auth secret, base64url. */
		auth: string
	}
	/** Milliseconds since epoch, where the browser provided one. */
	expirationTime?: number | null
}

/**
 * Where a push notification goes. A Web Push subscription object, or a device token string
 * for FCM/APNs.
 *
 * Note this is a **stored credential, not an address**: unlike an email or a phone number,
 * you cannot know it in advance — the device has to register first and hand it to you.
 */
export type PushTarget = WebPushSubscription | string

/** Default values applied to every push when the option is omitted. */
export type PushDefaults = {
	to?: PushTarget
	/** Icon URL shown alongside the notification, where the platform supports one. */
	icon?: string
	/** Time-to-live in seconds — how long the push service should keep retrying. */
	ttl?: number
}

/** Options accepted by `push(...)` and every push provider's `send`. */
export interface PushOptions {
	/** The subscription or device token to deliver to. */
	to?: PushTarget
	/** Notification title. */
	title?: string
	/** Notification body. */
	message: string
	/** Icon URL, where the platform supports one. */
	icon?: string
	/** URL to open when the notification is clicked. Delivered in the payload for the service worker to act on. */
	url?: string
	/** Arbitrary data delivered alongside the notification. */
	data?: Record<string, unknown>
	/** Time-to-live in seconds. */
	ttl?: number
	/**
	 * Urgency hint for the push service. `high` asks it not to delay delivery to save
	 * battery, which is what you want for a call or a code.
	 */
	urgency?: "very-low" | "low" | "normal" | "high"
}

/** A fully-resolved push handed to a provider's `build_request`. */
export interface PreparedPush {
	to: PushTarget
	title?: string
	message: string
	icon?: string
	url?: string
	data?: Record<string, unknown>
	ttl: number
	urgency: "very-low" | "low" | "normal" | "high"
}

/** Constructor options shared by every push provider. */
export type PushProviderOptions = TransportOptions<PreparedPush> & {
	default?: PushDefaults
}

/**
 * Options for the Web Push provider. The VAPID key pair identifies **you** to the push
 * service; the public half is also what the browser subscribes with, so the two must match
 * or every send is rejected.
 */
export type WebPushOptions = PushProviderOptions & {
	/** VAPID public key, base64url — the same one the client subscribes with. */
	public_key: string
	/** VAPID private key, base64url. */
	private_key: string
	/**
	 * Contact for the push service, as `mailto:you@example.com` or an https URL. Required by
	 * RFC 8292 so an operator can reach you about misbehaving traffic.
	 */
	subject: string
}
