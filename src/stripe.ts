/**
 * Stripe billing for memberships: Checkout, the Customer Portal, and the
 * webhook handler that turns payments into entitlements.
 *
 * Rules this module follows (from Stripe's integration guidance):
 * - Access is granted only from verified webhooks, never from the success page.
 * - Events map to members through Stripe IDs we stored ourselves (Checkout
 *   Session ID, Customer ID), not through metadata.
 * - Subscription state is re-fetched from Stripe on every event, so out-of-order
 *   delivery can't leave a stale status behind.
 * - No `payment_method_types`: payment methods come from the Dashboard.
 */
import type Stripe from "stripe";
import { type Db, ensureSchema } from "./db.ts";
import { recomputePlan as recomputePlanFor } from "./launch.ts";
import type { Member } from "./memberships.ts";

export * from "./launch.ts";

export interface Offer {
	/** Stripe Price `lookup_key`; the price ID is resolved at runtime */
	lookupKey: string;
	mode: "payment" | "subscription";
	/** One-time offer that grants Pro and marks the buyer an early member */
	grantsEarlyAccess?: boolean;
	/** Dashboard label for this checkout flow (Checkout `integration_identifier`) */
	integrationIdentifier?: string;
}

export interface BillingConfig<OfferKey extends string = string> {
	db: Db;
	stripe: Stripe;
	webhookSecret: string;
	offers: Record<OfferKey, Offer>;
	/** Coupon applied automatically to subscription checkouts for early members */
	earlyMemberCouponId?: string;
	/** Subscription statuses that count as Pro. Default: active, trialing, past_due */
	proStatuses?: Stripe.Subscription.Status[];
	now?: () => number;
}

export type CheckoutResult =
	| { ok: true; url: string }
	| { ok: false; reason: "already_pro" | "already_subscribed" | "unknown_offer" | "price_missing" };

export interface BillingSummary {
	hasCustomer: boolean;
	/** Permanent badge: bought early access, whatever their plan is now */
	earlyMember: boolean;
	earlyMemberSince: number | null;
	earlyAccessActive: boolean;
	graceEndsAt: number | null;
	subscription: {
		status: string;
		lookupKey: string | null;
		currentPeriodEnd: number | null;
		cancelAtPeriodEnd: boolean;
	} | null;
}

interface BillingRow {
	member_id: string;
	stripe_customer_id: string | null;
	early_member: number;
	early_access_at: number | null;
	early_access_revoked_at: number | null;
	grace_ends_at: number | null;
}

const idOf = (v: string | { id: string } | null | undefined): string | null =>
	v == null ? null : typeof v === "string" ? v : v.id;

export function createBilling<OfferKey extends string>(config: BillingConfig<OfferKey>) {
	const { db, stripe } = config;
	const now = config.now ?? Date.now;
	const proStatuses = new Set<string>(config.proStatuses ?? ["active", "trialing", "past_due"]);
	const priceCache = new Map<string, string>();

	async function priceId(lookupKey: string): Promise<string | null> {
		const cached = priceCache.get(lookupKey);
		if (cached) return cached;
		const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
		const id = data[0]?.id ?? null;
		if (id) priceCache.set(lookupKey, id);
		return id;
	}

	async function billingRow(memberId: string): Promise<BillingRow | null> {
		return db.prepare(`SELECT * FROM mbr_billing WHERE member_id = ?`).bind(memberId).first<BillingRow>();
	}

	async function memberIdForCustomer(customerId: string | null): Promise<string | null> {
		if (!customerId) return null;
		const row = await db
			.prepare(`SELECT member_id FROM mbr_billing WHERE stripe_customer_id = ?`)
			.bind(customerId)
			.first<{ member_id: string }>();
		return row?.member_id ?? null;
	}

	async function customerFor(member: Member): Promise<string> {
		const existing = await billingRow(member.id);
		if (existing?.stripe_customer_id) return existing.stripe_customer_id;
		// The idempotency key stops a double-click from creating two Customers.
		const customer = await stripe.customers.create(
			{ email: member.email, metadata: { member_id: member.id } },
			{ idempotencyKey: `mbr-customer-${member.id}` },
		);
		await db
			.prepare(
				`INSERT INTO mbr_billing (member_id, stripe_customer_id, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT (member_id) DO UPDATE SET
				   stripe_customer_id = COALESCE(mbr_billing.stripe_customer_id, excluded.stripe_customer_id),
				   updated_at = excluded.updated_at`,
			)
			.bind(member.id, customer.id, now())
			.run();
		return (await billingRow(member.id))?.stripe_customer_id ?? customer.id;
	}

	function earlyAccessActive(b: BillingRow | null, t = now()): boolean {
		return !!b?.early_access_at && !b.early_access_revoked_at && (b.grace_ends_at == null || b.grace_ends_at > t);
	}

	async function activeSubscription(memberId: string) {
		const { results } = await db
			.prepare(`SELECT * FROM mbr_subscriptions WHERE member_id = ? ORDER BY updated_at DESC`)
			.bind(memberId)
			.all<{ id: string; status: string; lookup_key: string | null; current_period_end: number | null; cancel_at_period_end: number }>();
		return results.find((s) => proStatuses.has(s.status)) ?? results[0] ?? null;
	}

	/** Writes the member's plan from billing state (shared rule in ./launch). */
	function recomputePlan(memberId: string): Promise<"free" | "pro"> {
		return recomputePlanFor(db, memberId, { proStatuses: [...proStatuses], now: now() });
	}

	async function syncSubscription(subscriptionId: string): Promise<string | null> {
		const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
		const memberId = await memberIdForCustomer(idOf(sub.customer));
		if (!memberId) {
			console.warn(`[memberships] subscription ${sub.id} belongs to an unknown customer; ignored`);
			return null;
		}
		const item = sub.items.data[0];
		await db
			.prepare(
				`INSERT INTO mbr_subscriptions (id, member_id, status, price_id, lookup_key, current_period_end, cancel_at_period_end, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET status = excluded.status, price_id = excluded.price_id,
				   lookup_key = excluded.lookup_key, current_period_end = excluded.current_period_end,
				   cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
			)
			.bind(
				sub.id,
				memberId,
				sub.status,
				item?.price.id ?? null,
				item?.price.lookup_key ?? null,
				item?.current_period_end ? item.current_period_end * 1000 : null,
				sub.cancel_at_period_end ? 1 : 0,
				now(),
			)
			.run();
		return memberId;
	}

	/** Finds the member and our checkout record for a Checkout Session or PaymentIntent. */
	async function checkoutBy(column: "session_id" | "payment_intent_id", id: string | null) {
		if (!id) return null;
		return db
			.prepare(`SELECT session_id, member_id, kind, status FROM mbr_checkouts WHERE ${column} = ?`)
			.bind(id)
			.first<{ session_id: string; member_id: string; kind: string; status: string }>();
	}

	async function fulfillCheckout(session: Stripe.Checkout.Session): Promise<string | null> {
		// Delayed payment methods complete the session while still unpaid;
		// checkout.session.async_payment_succeeded fulfills those later.
		if (session.payment_status === "unpaid") return null;
		const record = await checkoutBy("session_id", session.id);
		const memberId = record?.member_id ?? (await memberIdForCustomer(idOf(session.customer)));
		if (!memberId) {
			console.warn(`[memberships] checkout ${session.id} has no matching member; ignored`);
			return null;
		}
		const t = now();
		await db
			.prepare(`UPDATE mbr_checkouts SET status = 'complete', completed_at = ?, payment_intent_id = ? WHERE session_id = ?`)
			.bind(t, idOf(session.payment_intent), session.id)
			.run();

		const offer = record ? config.offers[record.kind as OfferKey] : undefined;
		if (session.mode === "payment" && offer?.grantsEarlyAccess) {
			await db
				.prepare(
					`INSERT INTO mbr_billing (member_id, early_member, early_access_at, updated_at) VALUES (?, 1, ?, ?)
					 ON CONFLICT (member_id) DO UPDATE SET early_member = 1,
					   early_access_at = COALESCE(mbr_billing.early_access_at, excluded.early_access_at),
					   early_access_revoked_at = NULL, updated_at = excluded.updated_at`,
				)
				.bind(memberId, t, t)
				.run();
		}
		const subId = idOf(session.subscription);
		if (subId) await syncSubscription(subId);
		return memberId;
	}

	async function revokeEarlyAccessForPayment(paymentIntentId: string | null, reason: string): Promise<string | null> {
		const record = await checkoutBy("payment_intent_id", paymentIntentId);
		if (!record) return null;
		const offer = config.offers[record.kind as OfferKey];
		const t = now();
		if (offer?.grantsEarlyAccess) {
			await db
				.prepare(`UPDATE mbr_billing SET early_access_revoked_at = ?, updated_at = ? WHERE member_id = ?`)
				.bind(t, t, record.member_id)
				.run();
		}
		console.warn(`[memberships] ${reason} on ${paymentIntentId} (member ${record.member_id})`);
		return record.member_id;
	}

	async function flag(memberId: string | null, flagName: string) {
		if (!memberId) return;
		await db
			.prepare(
				`INSERT INTO mbr_billing (member_id, risk_flag, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT (member_id) DO UPDATE SET risk_flag = excluded.risk_flag, updated_at = excluded.updated_at`,
			)
			.bind(memberId, flagName, now())
			.run();
	}

	async function memberForPayment(paymentIntentId: string | null, chargeCustomer: string | null) {
		return (await checkoutBy("payment_intent_id", paymentIntentId))?.member_id ?? (await memberIdForCustomer(chargeCustomer));
	}

	/** Routes one verified event. Returns the member whose plan may have changed. */
	async function dispatch(event: Stripe.Event): Promise<string | null> {
		switch (event.type) {
			case "checkout.session.completed":
			case "checkout.session.async_payment_succeeded":
				return fulfillCheckout(event.data.object);
			case "checkout.session.async_payment_failed": {
				await db
					.prepare(`UPDATE mbr_checkouts SET status = 'failed' WHERE session_id = ?`)
					.bind(event.data.object.id)
					.run();
				return null;
			}
			case "customer.subscription.created":
			case "customer.subscription.updated":
			case "customer.subscription.deleted":
				return syncSubscription(event.data.object.id);
			case "invoice.paid":
			case "invoice.payment_failed": {
				const subId = idOf(event.data.object.parent?.subscription_details?.subscription);
				return subId ? syncSubscription(subId) : null;
			}
			case "charge.refunded": {
				const charge = event.data.object;
				if (charge.amount_refunded < charge.amount) return null; // partial refund: keep access
				return revokeEarlyAccessForPayment(idOf(charge.payment_intent), "full refund");
			}
			case "charge.dispute.created": {
				const dispute = event.data.object;
				const memberId =
					(await revokeEarlyAccessForPayment(idOf(dispute.payment_intent), "dispute opened")) ??
					(await memberForPayment(idOf(dispute.payment_intent), null));
				await flag(memberId, "dispute");
				return memberId;
			}
			case "radar.early_fraud_warning.created": {
				const efw = event.data.object;
				const memberId = await memberForPayment(idOf(efw.payment_intent), null);
				await flag(memberId, "early_fraud_warning");
				console.warn(`[memberships] early fraud warning on ${idOf(efw.payment_intent)}; consider refunding`);
				return memberId;
			}
			default:
				return null;
		}
	}

	return {
		/** Starts Stripe Checkout for an offer and returns the hosted page URL. */
		async startCheckout(input: {
			member: Member;
			offer: OfferKey;
			successUrl: string;
			cancelUrl: string;
		}): Promise<CheckoutResult> {
			await ensureSchema(db);
			const offer = config.offers[input.offer];
			if (!offer) return { ok: false, reason: "unknown_offer" };

			const b = await billingRow(input.member.id);
			if (offer.mode === "payment" && offer.grantsEarlyAccess && earlyAccessActive(b)) {
				return { ok: false, reason: "already_pro" };
			}
			const sub = await activeSubscription(input.member.id);
			if (sub && proStatuses.has(sub.status)) return { ok: false, reason: "already_subscribed" };

			const price = await priceId(offer.lookupKey);
			if (!price) return { ok: false, reason: "price_missing" };
			const customer = await customerFor(input.member);

			const success = new URL(input.successUrl);
			const params: Stripe.Checkout.SessionCreateParams = {
				mode: offer.mode,
				customer,
				client_reference_id: input.member.id,
				line_items: [{ price, quantity: 1 }],
				// Stripe fills in {CHECKOUT_SESSION_ID}; keep the braces unencoded.
				success_url: `${success.origin}${success.pathname}?session_id={CHECKOUT_SESSION_ID}`,
				cancel_url: input.cancelUrl,
				...(offer.integrationIdentifier && { integration_identifier: offer.integrationIdentifier }),
			};
			if (offer.mode === "payment") params.invoice_creation = { enabled: true };
			// The early-member discount is for their first subscription, started before
			// their grace period ends. Cancel and come back later, and regular prices apply.
			const inGrace = b?.grace_ends_at == null || now() < b.grace_ends_at;
			if (offer.mode === "subscription" && config.earlyMemberCouponId && b?.early_member && !sub && inGrace) {
				params.discounts = [{ coupon: config.earlyMemberCouponId }];
			}

			const session = await stripe.checkout.sessions.create(params);
			await db
				.prepare(`INSERT INTO mbr_checkouts (session_id, member_id, kind, created_at) VALUES (?, ?, ?, ?)`)
				.bind(session.id, input.member.id, input.offer, now())
				.run();
			if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");
			return { ok: true, url: session.url };
		},

		/** Customer Portal: plan changes, cancellation, cards, invoices. */
		async portalUrl(member: Member, returnUrl: string): Promise<string | null> {
			await ensureSchema(db);
			const customer = (await billingRow(member.id))?.stripe_customer_id;
			if (!customer) return null;
			const session = await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
			return session.url;
		},

		async summary(memberId: string): Promise<BillingSummary> {
			await ensureSchema(db);
			const [b, sub] = await Promise.all([billingRow(memberId), activeSubscription(memberId)]);
			return {
				hasCustomer: !!b?.stripe_customer_id,
				earlyMember: !!b?.early_member,
				earlyMemberSince: b?.early_member ? (b.early_access_at ?? null) : null,
				earlyAccessActive: earlyAccessActive(b),
				graceEndsAt: b?.grace_ends_at ?? null,
				subscription: sub
					? {
							status: sub.status,
							lookupKey: sub.lookup_key,
							currentPeriodEnd: sub.current_period_end,
							cancelAtPeriodEnd: !!sub.cancel_at_period_end,
						}
					: null,
			};
		},

		/**
		 * Verifies and processes a webhook. Pass the raw request body; parsing it
		 * first breaks the signature. Throws (so Stripe retries) on processing errors.
		 */
		async handleWebhook(rawBody: string, signature: string | null): Promise<{ status: number; body: string }> {
			if (!signature) return { status: 400, body: "missing signature" };
			let event: Stripe.Event;
			try {
				event = await stripe.webhooks.constructEventAsync(
					rawBody,
					signature,
					config.webhookSecret,
					undefined,
					// Web Crypto: works on Workers, unlike the default Node crypto provider
					(stripe.constructor as typeof Stripe).createSubtleCryptoProvider(),
				);
			} catch {
				return { status: 400, body: "bad signature" };
			}
			await ensureSchema(db);

			const seen = await db.prepare(`SELECT 1 AS x FROM mbr_stripe_events WHERE id = ?`).bind(event.id).first();
			if (seen) return { status: 200, body: "duplicate" };

			const memberId = await dispatch(event);
			if (memberId) await recomputePlan(memberId);
			// Recorded after processing, so a failure above lets Stripe's retry run it again.
			await db
				.prepare(`INSERT INTO mbr_stripe_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING`)
				.bind(event.id, event.type, now())
				.run();
			return { status: 200, body: "ok" };
		},

		recomputePlan,
	};
}

export type Billing = ReturnType<typeof createBilling>;

/** The webhook events `handleWebhook` acts on. Subscribe the endpoint to exactly these. */
export const BILLING_WEBHOOK_EVENTS = [
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"checkout.session.async_payment_failed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"invoice.paid",
	"invoice.payment_failed",
	"charge.refunded",
	"charge.dispute.created",
	"radar.early_fraud_warning.created",
] as const;
