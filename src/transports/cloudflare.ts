import { type Address, EmailSendError, type EmailTransport } from "../transport.ts";

/** Named address as the binding takes it (`name` required; use a plain string otherwise). */
type CfAddress = string | { email: string; name: string };

/**
 * The part of Cloudflare's `send_email` binding this transport uses
 * (`SendEmail` in @cloudflare/workers-types). Declared structurally so the
 * package doesn't depend on Workers types; pass `env.EMAIL` directly.
 */
export interface CloudflareSendEmailBinding {
	send(message: {
		from: CfAddress;
		to: CfAddress | CfAddress[];
		subject: string;
		replyTo?: CfAddress;
		headers?: Record<string, string>;
		html?: string;
		text?: string;
	}): Promise<{ messageId: string }>;
}

/** Failures where trying again later can succeed. Everything else needs a fix first. */
const RETRYABLE = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR"]);

/**
 * Sends through Cloudflare Email Service via a Worker `send_email` binding.
 * No API key: the binding is the credential. The `from` address must be on a
 * domain onboarded to Email Sending in the same account.
 *
 * ```jsonc
 * // wrangler.jsonc
 * "send_email": [{ "name": "EMAIL" }]
 * ```
 */
export function cloudflareEmailTransport(binding: CloudflareSendEmailBinding): EmailTransport {
	if (!binding || typeof binding.send !== "function") {
		throw new Error("cloudflareEmailTransport: missing send_email binding (add it to wrangler.jsonc)");
	}
	return {
		name: "cloudflare-email",
		async send(message) {
			const to = (Array.isArray(message.to) ? message.to : [message.to]).map(cfAddress);
			try {
				const res = await binding.send({
					from: cfAddress(message.from),
					to: to.length === 1 ? to[0] : to,
					subject: message.subject,
					html: message.html,
					text: message.text,
					...(message.replyTo && { replyTo: cfAddress(message.replyTo) }),
					...(message.headers && Object.keys(message.headers).length > 0 && { headers: message.headers }),
				});
				return { messageId: res?.messageId };
			} catch (err) {
				const code = (err as { code?: unknown })?.code;
				const c = typeof code === "string" ? code : "E_UNKNOWN";
				throw new EmailSendError("cloudflare-email", c, `Cloudflare Email Service: ${(err as Error)?.message ?? c}`, {
					retryable: RETRYABLE.has(c),
					cause: err,
				});
			}
		},
	};
}

function cfAddress(a: Address): CfAddress {
	if (typeof a === "string") return a;
	return a.name ? { email: a.email, name: a.name } : a.email;
}
