/**
 * Membership wiring for this site: database, email delivery, cookie.
 * Everything else imports `members` from here.
 */
import { env } from "cloudflare:workers";
import { cloudflareEmailTransport, devLinkSender, transportLoginSender } from "emdash-memberships";
import { membershipsAstro } from "emdash-memberships/astro";

export const members = membershipsAstro({
	db: () => env.DB,
	// Locally the link is only logged (and shown on /login/check). In production
	// it goes out through Cloudflare Email Service via the EMAIL binding.
	sender: () =>
		import.meta.env.DEV
			? devLinkSender()
			: transportLoginSender({
					transport: cloudflareEmailTransport(env.EMAIL),
					from: { email: "signin@mail.example.com", name: "Example" },
					siteName: "Example",
				}),
	dev: import.meta.env.DEV,
});
