import { type LoginTemplateInput, type RenderedEmail, renderLoginEmail } from "./templates/login.ts";
import type { Address, EmailAddress, EmailTransport } from "./transport.ts";

export interface LoginEmail {
	to: string;
	/** Absolute URL of the confirm page, token included */
	url: string;
	expiresInMinutes: number;
}

/**
 * Delivers sign-in links. Use `transportLoginSender` with any `EmailTransport`
 * (e.g. `cloudflareEmailTransport(env.EMAIL)`), or `devLinkSender` locally.
 */
export interface LoginEmailSender {
	send(email: LoginEmail): Promise<void>;
}

export interface TransportLoginSenderConfig {
	transport: EmailTransport;
	/** Sender. The address must be on a domain the transport is allowed to send from. */
	from: EmailAddress;
	/** Shown in the subject, heading and footer. */
	siteName: string;
	/** Public site URL for the footer. Defaults to the sign-in link's origin. */
	siteUrl?: string;
	replyTo?: Address;
	accentColor?: string;
	/** Replace the built-in template. */
	render?: (input: LoginTemplateInput) => RenderedEmail;
}

/** Sends the sign-in email (HTML + text) through an `EmailTransport`. */
export function transportLoginSender(config: TransportLoginSenderConfig): LoginEmailSender {
	const render = config.render ?? renderLoginEmail;
	return {
		async send(email) {
			const { subject, html, text } = render({
				url: email.url,
				expiresInMinutes: email.expiresInMinutes,
				siteName: config.siteName,
				siteUrl: config.siteUrl,
				accentColor: config.accentColor,
			});
			await config.transport.send({
				from: config.from,
				to: email.to,
				subject,
				html,
				text,
				replyTo: config.replyTo,
				category: "login-link",
			});
		},
	};
}

/**
 * Development only: logs the link instead of emailing it, and remembers it so
 * the "check your inbox" page can show it. Never use in production.
 */
export function devLinkSender(onLink?: (email: LoginEmail) => void): LoginEmailSender {
	return {
		async send(email) {
			console.info(`[memberships] sign-in link for ${email.to}: ${email.url}`);
			onLink?.(email);
		},
	};
}
