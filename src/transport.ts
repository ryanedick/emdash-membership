/**
 * Provider-neutral email transport. Anything that can deliver one message —
 * Cloudflare Email Service, Bird, SES, a test double — implements
 * `EmailTransport`. Senders such as `transportLoginSender` build messages and
 * hand them to a transport; they never talk to a provider directly.
 *
 * The shape is deliberately the common subset of transactional email APIs:
 * one message per call, HTML + text bodies, a few optional headers. Bulk
 * sending (newsletters) belongs to a provider with campaign support, but it can
 * still implement this interface for one-off sends.
 */

export interface EmailAddress {
	email: string;
	name?: string;
}

export type Address = string | EmailAddress;

export interface OutboundEmail {
	from: Address;
	to: Address | Address[];
	subject: string;
	/** Always send both bodies: some clients only show text, and spam filters like it. */
	html: string;
	text: string;
	replyTo?: Address;
	/** Extra headers. Providers may reject some (e.g. ones that have their own field). */
	headers?: Record<string, string>;
	/**
	 * Short label for analytics/log grouping, e.g. "login-link". Transports may
	 * map it to a provider feature (tags, categories) or ignore it.
	 */
	category?: string;
}

export interface SendResult {
	/** Provider message ID, when the provider returns one. */
	messageId?: string;
}

export interface EmailTransport {
	/** Provider name, for logs. */
	readonly name: string;
	/** Delivers one message. Throws `EmailSendError` (or any Error) on failure. */
	send(message: OutboundEmail): Promise<SendResult>;
}

/**
 * Normalised send failure. `code` is the provider's error code when it gave
 * one. `retryable` means trying again later may succeed (rate limits, outages);
 * otherwise the message, sender or recipient needs fixing first.
 */
export class EmailSendError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly provider: string;

	constructor(provider: string, code: string, message: string, options: { retryable: boolean; cause?: unknown }) {
		super(message, { cause: options.cause });
		this.name = "EmailSendError";
		this.provider = provider;
		this.code = code;
		this.retryable = options.retryable;
	}
}

export function formatAddress(a: Address): string {
	if (typeof a === "string") return a;
	if (!a.name) return a.email;
	return `"${a.name.replace(/["\\]/g, "")}" <${a.email}>`;
}
