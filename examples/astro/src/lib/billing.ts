/**
 * Optional: Stripe. Offers point at Stripe Price lookup keys.
 * Secrets: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (`wrangler secret put …`).
 */
import { env } from "cloudflare:workers";
import { createBilling } from "emdash-memberships/stripe";
import Stripe from "stripe";
import { members } from "./members";

const OFFERS = {
	pro_monthly: { lookupKey: "pro_monthly", mode: "subscription" },
	pro_annual: { lookupKey: "pro_annual", mode: "subscription" },
} as const;

let stripe: Stripe | undefined;

export const billing = members.billingRoutes({
	enabled: () => !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET,
	billing: () => {
		stripe ??= new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
		return createBilling({ db: env.DB, stripe, webhookSecret: env.STRIPE_WEBHOOK_SECRET, offers: OFFERS });
	},
});
