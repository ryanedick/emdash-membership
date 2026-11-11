/**
 * Stripe billing for memberships: Checkout, the Customer Portal, plan
 * changes, and the webhook handler that turns payments into entitlements,
 * revenue figures and lifecycle emails.
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
import { hasActiveCoupons } from "./catalog.ts";
import { type Db, ensureSchema } from "./db.ts";
import { emitEvent } from "./events.ts";
import { attachGiftCheckout, createPendingGift, getGift, markGiftPaid, refundGift } from "./gifts.ts";
import { activateTeam, attachTeamCheckout, createPendingTeam, getTeam, refreshTeamAccess, seatsInUse, setTeamSeats } from "./teams.ts";
import { recomputePlan as recomputePlanFor } from "./launch.ts";
import { type EmailData, type EmailKind, enqueueEmail, getLifecycleSettings } from "./lifecycle.ts";
import type { Member } from "./memberships.ts";
import { getPlan, getPrice, type PlanPrice } from "./plans.ts";
import { mrrMovement, mrrOf } from "./revenue.ts";
import { getMembershipSecrets, type SecretsOptions } from "./settings.ts";

export * from "./catalog.ts";
export * from "./launch.ts";

const DAY = 24 * 60 * 60 * 1000;

export interface Offer {
	/** Stripe Price `lookup_key`; the price ID is resolved at runtime */
	lookupKey: string;
	mode: "payment" | "subscription";
	/** One-time offer that grants Pro and marks the buyer an early member */
	grantsEarlyAccess?: boolean;
	/** Dashboard label for this checkout flow (Checkout `integration_identifier`) */
	integrationIdentifier?: string;
	/** Free trial for first-time subscribers, in days */
	trialDays?: number;
}

export interface BillingConfig<OfferKey extends string = string> {
	db: Db;
	stripe: Stripe;
	webhookSecret: string;
	/**
	 * Offers fixed in code. Optional: any active price created in the admin
	 * (see ./catalog) can be bought by its lookup key as well.
	 */
	offers?: Record<OfferKey, Offer>;
	/** Coupon applied automatically to subscription checkouts for early members */
	earlyMemberCouponId?: string;
	/** Show the promotion code field at checkout. Default: when an active coupon exists (see ./catalog). */
	allowPromotionCodes?: boolean;
	/** Subscription statuses that count as Pro. Default: active, trialing, past_due */
	proStatuses?: Stripe.Subscription.Status[];
	/** Queue lifecycle emails (see ./lifecycle). Default true; they're only sent once settings are complete. */
	lifecycleEmails?: boolean;
	now?: () => number;
}

export type CheckoutResult =
	| { ok: true; url: string }
	| {
			ok: false;
			reason: "already_pro" | "already_subscribed" | "unknown_offer" | "price_missing" | "sold_out" | "unavailable" | "invalid_recipient" | "invalid_delivery_date" | "invalid_seats";
	  };

export type ChangePlanResult =
	| { ok: true; status: string }
	| { ok: false; reason: "no_subscription" | "unknown_price" | "not_recurring" | "same_price" | "stripe_error"; error?: string };

export interface BillingSummary {
	hasCustomer: boolean;
	/** Permanent badge: bought early access, whatever their plan is now */
	earlyMember: boolean;
	earlyMemberSince: number | null;
	earlyAccessActive: boolean;
	graceEndsAt: number | null;
	subscription: {
		id: string;
		status: string;
		lookupKey: string | null;
		planId: string | null;
		currentPeriodEnd: number | null;
		cancelAtPeriodEnd: boolean;
		trialEnd: number | null;
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

interface SubRow {
	id: string;
	member_id: string;
	status: string;
	price_id: string | null;
	lookup_key: string | null;
	current_period_end: number | null;
	cancel_at_period_end: number;
	updated_at: number;
}

const idOf = (v: string | { id: string } | null | undefined): string | null =>
	v == null ? null : typeof v === "string" ? v : v.id;

const ENDED = new Set(["canceled", "incomplete_expired"]);

export function createBilling<OfferKey extends string>(config: BillingConfig<OfferKey>) {
	const { db, stripe } = config;
	const offers = (config.offers ?? {}) as Record<string, Offer>;
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

	/** An offer from code, or an active admin-managed price with that lookup key. */
	async function resolveOffer(key: string): Promise<(Offer & { price: PlanPrice | null }) | null> {
		const fixed = offers[key];
		const price = await getPrice(db, { lookupKey: fixed?.lookupKey ?? key });
		if (fixed) return { ...fixed, trialDays: fixed.trialDays ?? price?.trialDays ?? 0, price };
		if (!price?.active) return null;
		return {
			lookupKey: price.lookupKey,
			mode: price.kind === "recurring" ? "subscription" : "payment",
			grantsEarlyAccess: price.grantsEarlyAccess,
			trialDays: price.trialDays,
			price,
		};
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

	async function emailOf(memberId: string): Promise<string | null> {
		return (await db.prepare(`SELECT email FROM mbr_members WHERE id = ?`).bind(memberId).first<{ email: string }>())?.email ?? null;
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
			.prepare(
				`SELECT s.*, t.plan_id, t.trial_end FROM mbr_subscriptions s LEFT JOIN mbr_subscription_terms t ON t.subscription_id = s.id
				 WHERE s.member_id = ? ORDER BY s.updated_at DESC`,
			)
			.bind(memberId)
			.all<SubRow & { plan_id: string | null; trial_end: number | null }>();
		return results.find((s) => proStatuses.has(s.status)) ?? results[0] ?? null;
	}

	/** Writes the member's plan from billing state (shared rule in ./launch). */
	function recomputePlan(memberId: string): Promise<"free" | "pro"> {
		return recomputePlanFor(db, memberId, { proStatuses: [...proStatuses], now: now() });
	}

	async function planName(priceIdOrNull: string | null, lookupKey: string | null): Promise<{ id: string | null; name: string }> {
		const price = (priceIdOrNull && (await getPrice(db, { stripePriceId: priceIdOrNull }))) || (lookupKey && (await getPrice(db, { lookupKey }))) || null;
		const plan = price ? await getPlan(db, price.planId) : null;
		return { id: plan?.id ?? null, name: plan?.name ?? "Pro" };
	}

	async function queue(kind: EmailKind, memberId: string, dedupeKey: string, data: EmailData, sendAfter?: number) {
		if (config.lifecycleEmails === false) return;
		const to = await emailOf(memberId);
		if (to) await enqueueEmail(db, { kind, to, memberId, dedupeKey, data, sendAfter }, now());
	}

	/** Recurring discount on a subscription, from its expanded discounts. "once" discounts don't count toward MRR. */
	function recurringDiscount(sub: Stripe.Subscription): { pct: number | null; amount: number | null } {
		for (const d of sub.discounts ?? []) {
			if (typeof d === "string") continue;
			const legacy = (d as unknown as { coupon?: Stripe.Coupon | string | null }).coupon;
			const coupon = (typeof d.source?.coupon === "object" ? d.source.coupon : null) ?? (typeof legacy === "object" ? legacy : null);
			if (!coupon || coupon.duration === "once") continue;
			if (coupon.percent_off) return { pct: coupon.percent_off, amount: null };
			if (coupon.amount_off) return { pct: null, amount: coupon.amount_off };
		}
		return { pct: null, amount: null };
	}

	async function syncSubscription(subscriptionId: string): Promise<string | null> {
		const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price", "discounts.source.coupon"] });
		const memberId = await memberIdForCustomer(idOf(sub.customer));
		if (!memberId) {
			console.warn(`[memberships] subscription ${sub.id} belongs to an unknown customer; ignored`);
			return null;
		}
		const t = now();
		const item = sub.items.data[0];
		const price = item?.price;
		// A paused subscription (pause_collection) stays "active" in Stripe; we record it as
		// "paused": no charges, so no MRR, and no access until it resumes.
		const status = sub.pause_collection ? "paused" : sub.status;
		const before = await db
			.prepare(
				`SELECT s.status, s.cancel_at_period_end, t.mrr FROM mbr_subscriptions s
				 LEFT JOIN mbr_subscription_terms t ON t.subscription_id = s.id WHERE s.id = ?`,
			)
			.bind(sub.id)
			.first<{ status: string; cancel_at_period_end: number; mrr: number | null }>();
		const plan = await planName(price?.id ?? null, price?.lookup_key ?? null);
		const discount = recurringDiscount(sub);
		const periodEnd = item?.current_period_end ? item.current_period_end * 1000 : null;
		const terms = {
			status,
			amount: price?.unit_amount ?? null,
			interval: price?.recurring?.interval ?? null,
			intervalCount: price?.recurring?.interval_count ?? 1,
			quantity: item?.quantity ?? 1,
			discountPct: discount.pct,
			discountAmount: discount.amount,
		};
		const mrr = mrrOf(terms);
		const prevMrr = before?.mrr ?? 0;
		const everEarned =
			prevMrr > 0 ||
			!!(await db.prepare(`SELECT 1 FROM mbr_mrr_events WHERE member_id = ? AND mrr_after > 0 LIMIT 1`).bind(memberId).first());
		const movement = mrrMovement(prevMrr, mrr, everEarned);

		await db.batch([
			db
				.prepare(
					`INSERT INTO mbr_subscriptions (id, member_id, status, price_id, lookup_key, current_period_end, cancel_at_period_end, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (id) DO UPDATE SET status = excluded.status, price_id = excluded.price_id,
					   lookup_key = excluded.lookup_key, current_period_end = excluded.current_period_end,
					   cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
				)
				.bind(sub.id, memberId, status, price?.id ?? null, price?.lookup_key ?? null, periodEnd, sub.cancel_at_period_end ? 1 : 0, t),
			db
				.prepare(
					`INSERT INTO mbr_subscription_terms (subscription_id, plan_id, amount, currency, interval, interval_count, quantity,
						discount_pct, discount_amount, mrr, trial_end, started_at, canceled_at, ended_at, updated_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
					 ON CONFLICT (subscription_id) DO UPDATE SET plan_id = excluded.plan_id, amount = excluded.amount,
					   currency = excluded.currency, interval = excluded.interval, interval_count = excluded.interval_count,
					   quantity = excluded.quantity, discount_pct = excluded.discount_pct, discount_amount = excluded.discount_amount,
					   mrr = excluded.mrr, trial_end = excluded.trial_end, started_at = excluded.started_at,
					   canceled_at = excluded.canceled_at, ended_at = excluded.ended_at, updated_at = excluded.updated_at`,
				)
				.bind(
					sub.id,
					plan.id,
					terms.amount,
					price?.currency ?? null,
					terms.interval,
					terms.intervalCount,
					terms.quantity,
					terms.discountPct,
					terms.discountAmount,
					mrr,
					sub.trial_end ? sub.trial_end * 1000 : null,
					sub.start_date ? sub.start_date * 1000 : null,
					sub.canceled_at ? sub.canceled_at * 1000 : null,
					sub.ended_at ? sub.ended_at * 1000 : null,
					t,
				),
			...(movement
				? [
						db
							.prepare(
								`INSERT INTO mbr_mrr_events (member_id, subscription_id, at, currency, mrr_before, mrr_after, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`,
							)
							.bind(memberId, sub.id, t, price?.currency ?? "usd", prevMrr, mrr, movement),
					]
				: []),
		]);

		// Lifecycle emails and events on transitions only, so replays and unrelated updates send nothing.
		const wasEnded = before ? ENDED.has(before.status) : false;
		const info = { subscriptionId: sub.id, plan: plan.id, price: price?.lookup_key ?? null, status, mrr, currency: price?.currency ?? null };
		if (!before || before.status !== status || (before.mrr ?? 0) !== mrr) await emitEvent(db, "subscription.updated", memberId, { ...info, previousStatus: before?.status ?? null }, t);
		if (sub.cancel_at_period_end && !before?.cancel_at_period_end && !ENDED.has(sub.status)) {
			await queue("cancel_scheduled", memberId, `cancel:${sub.id}:${periodEnd ?? 0}`, { planName: plan.name, date: periodEnd });
			await emitEvent(db, "subscription.cancel_scheduled", memberId, { ...info, endsAt: periodEnd }, t);
		}
		if (ENDED.has(sub.status) && before && !wasEnded && before.status !== "incomplete") {
			await emitEvent(db, "subscription.ended", memberId, info, t);
			await queue("subscription_ended", memberId, `ended:${sub.id}`, { planName: plan.name });
			const s = await getLifecycleSettings(db);
			if (s.winBackDays > 0) {
				await queue("win_back", memberId, `winback:${sub.id}`, { planName: plan.name }, t + s.winBackDays * DAY);
			}
		}
		// A team's seats follow its subscription: keep the seat count and every seat holder's access in step.
		const team = await getTeam(db, { subscriptionId: sub.id });
		if (team) {
			if (item?.quantity && item.quantity !== team.seats) await setTeamSeats(db, team.id, item.quantity, t);
			if (!before || before.status !== status) await refreshTeamAccess(db, team.id, { proStatuses: [...proStatuses], now: t });
		}
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

		// Gift and team checkouts carry their own record id in the kind.
		if (record?.kind.startsWith("gift:")) {
			await markGiftPaid(db, record.kind.slice(5), idOf(session.payment_intent), t);
			return null;
		}
		if (record?.kind.startsWith("team:")) {
			const subId = idOf(session.subscription);
			if (subId) await syncSubscription(subId);
			await db.prepare(`UPDATE mbr_teams SET subscription_id = ? WHERE id = ?`).bind(subId, record.kind.slice(5)).run();
			await activateTeam(db, record.kind.slice(5), subId, { proStatuses: [...proStatuses], now: t });
			await emitEvent(db, "checkout.completed", memberId, { sessionId: session.id, mode: session.mode, offer: "team", amount: session.amount_total ?? null, currency: session.currency ?? null }, t);
			return memberId;
		}

		const offer = record ? await resolveOffer(record.kind) : null;
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
		const plan = offer ? await planName(offer.price?.stripePriceId ?? null, offer.lookupKey) : { id: null, name: "Pro" };
		await queue("welcome", memberId, `welcome:${session.id}`, { planName: plan.name });
		await emitEvent(db, "checkout.completed", memberId, { sessionId: session.id, mode: session.mode, offer: record?.kind ?? null, plan: plan.id, amount: session.amount_total ?? null, currency: session.currency ?? null }, t);
		return memberId;
	}

	async function revokeEarlyAccessForPayment(paymentIntentId: string | null, reason: string): Promise<string | null> {
		const record = await checkoutBy("payment_intent_id", paymentIntentId);
		if (!record) return null;
		if (record.kind.startsWith("gift:")) {
			await refundGift(db, record.kind.slice(5), { proStatuses: [...proStatuses], now: now() });
			const gift = await getGift(db, { id: record.kind.slice(5) });
			return gift?.redeemedMemberId ?? null;
		}
		const offer = await resolveOffer(record.kind);
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
			case "customer.subscription.trial_will_end": {
				const memberId = await syncSubscription(event.data.object.id);
				const sub = event.data.object;
				const item = sub.items?.data?.[0];
				if (memberId && sub.trial_end && !sub.cancel_at_period_end) {
					const plan = await planName(item?.price?.id ?? null, item?.price?.lookup_key ?? null);
					await queue("trial_ending", memberId, `trial:${sub.id}:${sub.trial_end}`, {
						planName: plan.name,
						date: sub.trial_end * 1000,
						amount: item?.price?.unit_amount != null ? item.price.unit_amount * (item.quantity ?? 1) : null,
						currency: item?.price?.currency ?? null,
					});
				}
				return memberId;
			}
			case "invoice.paid":
			case "invoice.payment_failed": {
				const invoice = event.data.object;
				const subId = idOf(invoice.parent?.subscription_details?.subscription);
				const memberId = subId ? await syncSubscription(subId) : await memberIdForCustomer(idOf(invoice.customer));
				if (event.type === "invoice.payment_failed" && memberId) {
					// The subscription was synced just above, so its plan is on record.
					const terms = subId
						? await db.prepare(`SELECT plan_id FROM mbr_subscription_terms WHERE subscription_id = ?`).bind(subId).first<{ plan_id: string | null }>()
						: null;
					const name = (terms?.plan_id && (await getPlan(db, terms.plan_id))?.name) || "Pro";
					await emitEvent(db, "payment.failed", memberId, { invoiceId: invoice.id, amount: invoice.amount_due, currency: invoice.currency, subscriptionId: subId }, now());
					await queue("payment_failed", memberId, `payment_failed:${invoice.id}`, {
						planName: name,
						amount: invoice.amount_due,
						currency: invoice.currency,
						nextAttempt: invoice.next_payment_attempt ? invoice.next_payment_attempt * 1000 : null,
					});
				}
				return memberId;
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

	/** The member's live subscription and its first item, fresh from Stripe. */
	async function liveSubscription(memberId: string) {
		const row = await activeSubscription(memberId);
		if (!row || !proStatuses.has(row.status)) return null;
		const sub = await stripe.subscriptions.retrieve(row.id, { expand: ["items.data.price"] });
		return { sub, item: sub.items.data[0] };
	}

	/** Capped offers: a member limit and/or an end date on a price. */
	async function availability(p: PlanPrice): Promise<{ available: boolean; remaining: number | null; endsAt: number | null; reason: "ok" | "ended" | "sold_out" }> {
		if (p.availableUntil && now() >= p.availableUntil) return { available: false, remaining: 0, endsAt: p.availableUntil, reason: "ended" };
		if (!p.maxMembers) return { available: true, remaining: null, endsAt: p.availableUntil, reason: "ok" };
		const r = await db
			.prepare(
				`SELECT COUNT(*) AS n FROM (
					SELECT member_id FROM mbr_checkouts WHERE kind = ?1 AND status = 'complete'
					UNION SELECT member_id FROM mbr_subscriptions WHERE lookup_key = ?1)`,
			)
			.bind(p.lookupKey)
			.first<{ n: number }>();
		const remaining = Math.max(0, p.maxMembers - Number(r?.n ?? 0));
		return { available: remaining > 0, remaining, endsAt: p.availableUntil, reason: remaining > 0 ? "ok" : "sold_out" };
	}

	function successUrl(url: string) {
		const s = new URL(url);
		// Stripe fills in {CHECKOUT_SESSION_ID}; keep the braces unencoded.
		return `${s.origin}${s.pathname}?session_id={CHECKOUT_SESSION_ID}`;
	}

	async function openSession(member: Member, params: Stripe.Checkout.SessionCreateParams) {
		const session = await stripe.checkout.sessions.create({ customer: await customerFor(member), client_reference_id: member.id, ...params });
		if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");
		return session;
	}

	async function recordCheckout(sessionId: string, memberId: string, kind: string) {
		await db.prepare(`INSERT INTO mbr_checkouts (session_id, member_id, kind, created_at) VALUES (?, ?, ?, ?)`).bind(sessionId, memberId, kind, now()).run();
	}

	async function afterChange(memberId: string, subId: string) {
		await syncSubscription(subId);
		await recomputePlan(memberId);
	}

	return {
		/**
		 * Starts Stripe Checkout and returns the hosted page URL. `offer` is a key
		 * of `config.offers` or the lookup key of an active price from the admin.
		 */
		async startCheckout(input: {
			member: Member;
			offer: OfferKey | (string & {});
			successUrl: string;
			cancelUrl: string;
		}): Promise<CheckoutResult> {
			await ensureSchema(db);
			const offer = await resolveOffer(input.offer);
			if (!offer) return { ok: false, reason: "unknown_offer" };
			// Gift and team prices have their own checkouts.
			if (offer.price && (offer.price.giftDays > 0 || offer.price.perSeat)) return { ok: false, reason: "unknown_offer" };
			if (offer.price) {
				const avail = await availability(offer.price);
				if (!avail.available) return { ok: false, reason: avail.reason === "ended" ? "unavailable" : "sold_out" };
			}

			const b = await billingRow(input.member.id);
			if (offer.mode === "payment" && offer.grantsEarlyAccess && earlyAccessActive(b)) {
				return { ok: false, reason: "already_pro" };
			}
			const sub = await activeSubscription(input.member.id);
			if (sub && proStatuses.has(sub.status)) return { ok: false, reason: "already_subscribed" };

			const price = offer.price?.stripePriceId ?? (await priceId(offer.lookupKey));
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
			// Trials are for first-time subscribers only.
			if (offer.mode === "subscription" && (offer.trialDays ?? 0) > 0 && !sub) {
				params.subscription_data = { trial_period_days: offer.trialDays };
			}
			// The early-member discount is for their first subscription, started before
			// their grace period ends. Cancel and come back later, and regular prices apply.
			const inGrace = b?.grace_ends_at == null || now() < b.grace_ends_at;
			if (offer.mode === "subscription" && config.earlyMemberCouponId && b?.early_member && !sub && inGrace) {
				params.discounts = [{ coupon: config.earlyMemberCouponId }];
			} else if (config.allowPromotionCodes ?? (await hasActiveCoupons(db, now()))) {
				params.allow_promotion_codes = true;
			}

			const session = await stripe.checkout.sessions.create(params);
			await db
				.prepare(`INSERT INTO mbr_checkouts (session_id, member_id, kind, created_at) VALUES (?, ?, ?, ?)`)
				.bind(session.id, input.member.id, input.offer, now())
				.run();
			if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");
			return { ok: true, url: session.url };
		},

		/** Whether a capped price can still be bought, and how many places are left. */
		async offerAvailability(lookupKey: string) {
			await ensureSchema(db);
			const p = await getPrice(db, { lookupKey });
			return p ? availability(p) : { available: false, remaining: 0, endsAt: null, reason: "ended" as const };
		},

		/**
		 * Buys a gift: a gift price (one-time, with gift days) paid by `member`,
		 * for `recipientEmail` (optional; without it the buyer gets the code to pass on).
		 */
		async startGiftCheckout(input: {
			member: Member;
			lookupKey: string;
			recipientEmail?: string | null;
			recipientName?: string | null;
			message?: string | null;
			deliverAt?: number | null;
			successUrl: string;
			cancelUrl: string;
		}): Promise<CheckoutResult> {
			await ensureSchema(db);
			const pending = await createPendingGift(db, { buyer: input.member, ...input, now: now() });
			if (!pending.ok) return { ok: false, reason: pending.reason === "not_a_gift_price" ? "unknown_offer" : pending.reason };
			const price = await getPrice(db, { lookupKey: input.lookupKey });
			const priceIdValue = price?.stripePriceId ?? (await priceId(input.lookupKey));
			if (!priceIdValue) return { ok: false, reason: "price_missing" };
			const session = await openSession(input.member, {
				mode: "payment",
				line_items: [{ price: priceIdValue, quantity: 1 }],
				invoice_creation: { enabled: true },
				success_url: successUrl(input.successUrl),
				cancel_url: input.cancelUrl,
			});
			await attachGiftCheckout(db, pending.gift.id, session.id);
			await recordCheckout(session.id, input.member.id, `gift:${pending.gift.id}`);
			return { ok: true, url: session.url! };
		},

		/** Buys a team: a per-seat recurring price for `seats` seats, owned by `member`. */
		async startTeamCheckout(input: { member: Member; lookupKey: string; seats: number; teamName: string; successUrl: string; cancelUrl: string }): Promise<CheckoutResult> {
			await ensureSchema(db);
			const price = await getPrice(db, { lookupKey: input.lookupKey });
			if (!price?.active || !price.perSeat || price.kind !== "recurring") return { ok: false, reason: "unknown_offer" };
			const seats = Math.floor(input.seats);
			if (!(seats >= 1 && seats <= 1000)) return { ok: false, reason: "invalid_seats" };
			const priceIdValue = price.stripePriceId ?? (await priceId(price.lookupKey));
			if (!priceIdValue) return { ok: false, reason: "price_missing" };
			const team = await createPendingTeam(db, { owner: input.member, planId: price.planId, seats, name: input.teamName, now: now() });
			const promo = config.allowPromotionCodes ?? (await hasActiveCoupons(db, now()));
			const session = await openSession(input.member, {
				mode: "subscription",
				line_items: [{ price: priceIdValue, quantity: seats }],
				success_url: successUrl(input.successUrl),
				cancel_url: input.cancelUrl,
				...(promo && { allow_promotion_codes: true }),
			});
			await attachTeamCheckout(db, team.id, session.id);
			await recordCheckout(session.id, input.member.id, `team:${team.id}`);
			return { ok: true, url: session.url! };
		},

		/** Changes a team's seat count in Stripe (prorated). Can't go below the seats in use. */
		async updateTeamSeats(teamId: string, seats: number): Promise<ChangePlanResult> {
			await ensureSchema(db);
			const team = await getTeam(db, { id: teamId });
			if (!team?.subscriptionId) return { ok: false, reason: "no_subscription" };
			const n = Math.floor(seats);
			if (!(n >= 1 && n <= 1000) || n < (await seatsInUse(db, teamId))) return { ok: false, reason: "stripe_error", error: "Choose at least as many seats as are in use" };
			try {
				const sub = await stripe.subscriptions.retrieve(team.subscriptionId, { expand: ["items.data.price"] });
				const item = sub.items.data[0];
				const updated = await stripe.subscriptions.update(sub.id, { items: [{ id: item.id, quantity: n }], proration_behavior: "create_prorations" });
				await setTeamSeats(db, teamId, n, now());
				await afterChange(team.ownerMemberId, sub.id);
				return { ok: true, status: updated.status };
			} catch (err) {
				return { ok: false, reason: "stripe_error", error: String((err as Error)?.message ?? err) };
			}
		},

		/**
		 * Links a Stripe customer to a member and pulls in their subscriptions, e.g.
		 * after importing members who were already paying elsewhere. Nobody is charged.
		 */
		async linkCustomer(memberId: string, customerId: string): Promise<{ ok: true; subscriptions: number } | { ok: false; error: string }> {
			await ensureSchema(db);
			const owner = await memberIdForCustomer(customerId);
			if (owner && owner !== memberId) return { ok: false, error: "That customer belongs to another member" };
			await db
				.prepare(
					`INSERT INTO mbr_billing (member_id, stripe_customer_id, updated_at) VALUES (?, ?, ?)
					 ON CONFLICT (member_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, updated_at = excluded.updated_at`,
				)
				.bind(memberId, customerId, now())
				.run();
			let n = 0;
			try {
				for await (const s of stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
					await syncSubscription(s.id);
					n++;
				}
			} catch (err) {
				return { ok: false, error: String((err as Error)?.message ?? err) };
			}
			await recomputePlan(memberId);
			return { ok: true, subscriptions: n };
		},

		/** Customer Portal: plan changes, cancellation, cards, invoices. */
		async portalUrl(member: Member, returnUrl: string): Promise<string | null> {
			await ensureSchema(db);
			const customer = (await billingRow(member.id))?.stripe_customer_id;
			if (!customer) return null;
			const session = await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
			return session.url;
		},

		/**
		 * Moves the member's subscription to another recurring price (another plan,
		 * or monthly ↔ annual). Stripe prorates by default; access updates now.
		 */
		async changePlan(memberId: string, lookupKey: string, opts: { prorate?: boolean } = {}): Promise<ChangePlanResult> {
			await ensureSchema(db);
			const target = await getPrice(db, { lookupKey });
			const targetId = target?.stripePriceId ?? (target ? await priceId(target.lookupKey) : null);
			if (!target || !target.active || !targetId) return { ok: false, reason: "unknown_price" };
			if (target.kind !== "recurring") return { ok: false, reason: "not_recurring" };
			const live = await liveSubscription(memberId);
			if (!live?.item) return { ok: false, reason: "no_subscription" };
			if (live.item.price.id === targetId) return { ok: false, reason: "same_price" };
			try {
				const updated = await stripe.subscriptions.update(live.sub.id, {
					items: [{ id: live.item.id, price: targetId }],
					proration_behavior: opts.prorate === false ? "none" : "create_prorations",
				});
				await afterChange(memberId, live.sub.id);
				return { ok: true, status: updated.status };
			} catch (err) {
				return { ok: false, reason: "stripe_error", error: String((err as Error)?.message ?? err) };
			}
		},

		/** Cancels at the end of the period (default) or right away. */
		async cancelSubscription(memberId: string, opts: { atPeriodEnd?: boolean } = {}): Promise<ChangePlanResult> {
			await ensureSchema(db);
			const live = await liveSubscription(memberId);
			if (!live) return { ok: false, reason: "no_subscription" };
			try {
				const updated =
					opts.atPeriodEnd === false
						? await stripe.subscriptions.cancel(live.sub.id)
						: await stripe.subscriptions.update(live.sub.id, { cancel_at_period_end: true });
				await afterChange(memberId, live.sub.id);
				return { ok: true, status: updated.status };
			} catch (err) {
				return { ok: false, reason: "stripe_error", error: String((err as Error)?.message ?? err) };
			}
		},

		/**
		 * Pauses billing for `months` (Stripe `pause_collection`, invoices voided).
		 * Paused members have no access until it resumes, automatically or via `unpauseSubscription`.
		 */
		async pauseSubscription(memberId: string, opts: { months: number }): Promise<ChangePlanResult> {
			await ensureSchema(db);
			const live = await liveSubscription(memberId);
			if (!live) return { ok: false, reason: "no_subscription" };
			const months = Math.min(12, Math.max(1, Math.floor(opts.months)));
			const resumes = new Date(now());
			resumes.setUTCMonth(resumes.getUTCMonth() + months);
			try {
				const updated = await stripe.subscriptions.update(live.sub.id, {
					pause_collection: { behavior: "void", resumes_at: Math.floor(resumes.getTime() / 1000) },
				});
				await afterChange(memberId, live.sub.id);
				return { ok: true, status: updated.status };
			} catch (err) {
				return { ok: false, reason: "stripe_error", error: String((err as Error)?.message ?? err) };
			}
		},

		/** Ends a pause now. */
		async unpauseSubscription(memberId: string): Promise<ChangePlanResult> {
			await ensureSchema(db);
			const row = await db
				.prepare(`SELECT id FROM mbr_subscriptions WHERE member_id = ? AND status = 'paused' ORDER BY updated_at DESC LIMIT 1`)
				.bind(memberId)
				.first<{ id: string }>();
			if (!row) return { ok: false, reason: "no_subscription" };
			try {
				const updated = await stripe.subscriptions.update(row.id, { pause_collection: "" });
				await afterChange(memberId, row.id);
				return { ok: true, status: updated.status };
			} catch (err) {
				return { ok: false, reason: "stripe_error", error: String((err as Error)?.message ?? err) };
			}
		},

		/** Applies an admin-created coupon (by code) to the member's live subscription, e.g. as a save offer. */
		async applyCoupon(memberId: string, code: string): Promise<ChangePlanResult> {
			await ensureSchema(db);
			const coupon = await db
				.prepare(`SELECT stripe_coupon_id FROM mbr_coupons WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?)`)
				.bind(code.trim().toUpperCase(), now())
				.first<{ stripe_coupon_id: string | null }>();
			if (!coupon?.stripe_coupon_id) return { ok: false, reason: "unknown_price", error: "Unknown or inactive coupon" };
			const live = await liveSubscription(memberId);
			if (!live) return { ok: false, reason: "no_subscription" };
			try {
				const updated = await stripe.subscriptions.update(live.sub.id, { discounts: [{ coupon: coupon.stripe_coupon_id }] });
				await afterChange(memberId, live.sub.id);
				return { ok: true, status: updated.status };
			} catch (err) {
				return { ok: false, reason: "stripe_error", error: String((err as Error)?.message ?? err) };
			}
		},

		/** Undoes a cancellation scheduled for the end of the period. */
		async resumeSubscription(memberId: string): Promise<ChangePlanResult> {
			await ensureSchema(db);
			const live = await liveSubscription(memberId);
			if (!live) return { ok: false, reason: "no_subscription" };
			try {
				const updated = await stripe.subscriptions.update(live.sub.id, { cancel_at_period_end: false });
				await afterChange(memberId, live.sub.id);
				return { ok: true, status: updated.status };
			} catch (err) {
				return { ok: false, reason: "stripe_error", error: String((err as Error)?.message ?? err) };
			}
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
							id: sub.id,
							status: sub.status,
							lookupKey: sub.lookup_key,
							planId: sub.plan_id,
							currentPeriodEnd: sub.current_period_end,
							cancelAtPeriodEnd: !!sub.cancel_at_period_end,
							trialEnd: sub.trial_end,
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
			// Not set up yet: 503 makes Stripe retry later instead of dropping the event.
			if (!config.webhookSecret) return { status: 503, body: "webhook signing secret not set" };
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

		/** Re-reads one subscription from Stripe (e.g. after a manual change in the Dashboard). */
		async syncSubscription(subscriptionId: string): Promise<string | null> {
			await ensureSchema(db);
			const memberId = await syncSubscription(subscriptionId);
			if (memberId) await recomputePlan(memberId);
			return memberId;
		},

		recomputePlan,
	};
}

export type Billing = ReturnType<typeof createBilling>;

let stripeClient: { key: string; client: Stripe } | null = null;

/** A Stripe client for a key, reused across requests in this isolate. Needs the `stripe` package. */
export async function stripeClientFor(key: string): Promise<Stripe> {
	if (stripeClient?.key === key) return stripeClient.client;
	const { default: StripeCtor } = (await import("stripe")) as { default: typeof Stripe };
	// No apiVersion: the SDK pins the version its types were generated for.
	const client = new StripeCtor(key, { httpClient: StripeCtor.createFetchHttpClient(), maxNetworkRetries: 2 });
	stripeClient = { key, client };
	return client;
}

/**
 * Billing with the Stripe keys saved in the Members admin (or, failing that,
 * the STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET environment variables).
 * Returns null while no secret key is set, so routes can show "not available".
 *
 *   billing: () => createBillingFromSettings({ db: env.DB, earlyMemberCouponId: "EARLY50" })
 */
export async function createBillingFromSettings<OfferKey extends string>(
	config: Omit<BillingConfig<OfferKey>, "stripe" | "webhookSecret"> & { secrets?: SecretsOptions; stripe?: Stripe },
): Promise<Billing | null> {
	const s = await getMembershipSecrets(config.secrets);
	if (!s.stripeSecretKey && !config.stripe) return null;
	const stripe = config.stripe ?? (await stripeClientFor(s.stripeSecretKey!));
	return createBilling({ ...config, stripe, webhookSecret: s.stripeWebhookSecret ?? "" });
}

/** The webhook events `handleWebhook` acts on. Subscribe the endpoint to exactly these. */
export const BILLING_WEBHOOK_EVENTS = [
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"checkout.session.async_payment_failed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"customer.subscription.trial_will_end",
	"invoice.paid",
	"invoice.payment_failed",
	"charge.refunded",
	"charge.dispute.created",
	"radar.early_fraud_warning.created",
] as const;
