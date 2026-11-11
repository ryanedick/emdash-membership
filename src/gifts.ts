/**
 * Gifts: someone buys time on a plan for someone else.
 *
 * A gift price is a one-time price with `giftDays` set. Checkout creates a
 * pending gift with a code; when Stripe confirms payment the gift is marked
 * paid, the buyer gets the code, and the recipient (if given) gets it on the
 * chosen delivery date. Redeeming gives the recipient that many days of the
 * plan as comp time, stacking after any they already have. A full refund
 * cancels an unredeemed gift and revokes a redeemed one.
 */
import { type Db, ensureSchema } from "./db.ts";
import { emitEvent } from "./events.ts";
import { grantProTime, revokeGrant } from "./grants.ts";
import { enqueueEmail } from "./lifecycle.ts";
import type { Member } from "./memberships.ts";
import { getPlan, getPrice } from "./plans.ts";

export type GiftStatus = "pending" | "paid" | "redeemed" | "refunded" | "canceled";

export interface Gift {
	id: string;
	code: string;
	priceLookupKey: string;
	planId: string;
	days: number;
	buyerMemberId: string | null;
	buyerEmail: string;
	recipientEmail: string | null;
	recipientName: string | null;
	message: string | null;
	deliverAt: number | null;
	status: GiftStatus;
	deliveredAt: number | null;
	redeemedAt: number | null;
	redeemedMemberId: string | null;
	createdAt: number;
}

interface GiftRow {
	id: string;
	code: string;
	price_lookup_key: string;
	plan_id: string;
	days: number;
	buyer_member_id: string | null;
	buyer_email: string;
	recipient_email: string | null;
	recipient_name: string | null;
	message: string | null;
	deliver_at: number | null;
	status: string;
	delivered_at: number | null;
	redeemed_at: number | null;
	redeemed_member_id: string | null;
	created_at: number;
}

const toGift = (r: GiftRow): Gift => ({
	id: r.id,
	code: r.code,
	priceLookupKey: r.price_lookup_key,
	planId: r.plan_id,
	days: r.days,
	buyerMemberId: r.buyer_member_id,
	buyerEmail: r.buyer_email,
	recipientEmail: r.recipient_email,
	recipientName: r.recipient_name,
	message: r.message,
	deliverAt: r.deliver_at,
	status: r.status as GiftStatus,
	deliveredAt: r.delivered_at,
	redeemedAt: r.redeemed_at,
	redeemedMemberId: r.redeemed_member_id,
	createdAt: r.created_at,
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Readable codes without look-alike characters: XXXX-XXXX-XXXX */
function giftCode(): string {
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
	return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

export type CreateGiftResult =
	| { ok: true; gift: Gift; lookupKey: string }
	| { ok: false; reason: "not_a_gift_price" | "invalid_recipient" | "invalid_delivery_date" };

/** Creates a pending gift (step one of a gift checkout; see `billing.startGiftCheckout`). */
export async function createPendingGift(
	db: Db,
	input: { buyer: Pick<Member, "id" | "email">; lookupKey: string; recipientEmail?: string | null; recipientName?: string | null; message?: string | null; deliverAt?: number | null; now?: number },
): Promise<CreateGiftResult> {
	await ensureSchema(db);
	const t = input.now ?? Date.now();
	const price = await getPrice(db, { lookupKey: input.lookupKey });
	if (!price?.active || price.kind !== "one_time" || price.giftDays <= 0) return { ok: false, reason: "not_a_gift_price" };
	const recipient = input.recipientEmail?.trim().toLowerCase() || null;
	if (recipient && !EMAIL.test(recipient)) return { ok: false, reason: "invalid_recipient" };
	if (input.deliverAt && (input.deliverAt < t - 86_400_000 || input.deliverAt > t + 366 * 86_400_000)) return { ok: false, reason: "invalid_delivery_date" };
	const id = `gift_${crypto.randomUUID()}`;
	await db
		.prepare(
			`INSERT INTO mbr_gifts (id, code, price_lookup_key, plan_id, days, buyer_member_id, buyer_email, recipient_email, recipient_name, message, deliver_at, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
		)
		.bind(
			id,
			giftCode(),
			price.lookupKey,
			price.planId,
			price.giftDays,
			input.buyer.id,
			input.buyer.email,
			recipient,
			input.recipientName?.trim().slice(0, 80) || null,
			input.message?.trim().slice(0, 1000) || null,
			input.deliverAt ?? null,
			t,
		)
		.run();
	return { ok: true, gift: (await getGift(db, { id }))!, lookupKey: price.lookupKey };
}

export async function getGift(db: Db, by: { id?: string; code?: string; sessionId?: string }): Promise<Gift | null> {
	await ensureSchema(db);
	const [col, val] = by.id ? ["id", by.id] : by.code ? ["code", by.code.trim().toUpperCase()] : ["checkout_session_id", by.sessionId];
	if (!val) return null;
	const r = await db.prepare(`SELECT * FROM mbr_gifts WHERE ${col} = ?`).bind(val).first<GiftRow>();
	return r ? toGift(r) : null;
}

export async function listGifts(db: Db, opts: { buyerMemberId?: string; limit?: number } = {}): Promise<Gift[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM mbr_gifts ${opts.buyerMemberId ? "WHERE buyer_member_id = ?" : "WHERE status <> 'pending'"} ORDER BY created_at DESC LIMIT ?`)
		.bind(...(opts.buyerMemberId ? [opts.buyerMemberId] : []), opts.limit ?? 100)
		.all<GiftRow>();
	return results.map(toGift);
}

export async function attachGiftCheckout(db: Db, giftId: string, sessionId: string): Promise<void> {
	await db.prepare(`UPDATE mbr_gifts SET checkout_session_id = ? WHERE id = ?`).bind(sessionId, giftId).run();
}

/** Payment confirmed: mark paid, email the buyer the code, schedule the recipient's email. Idempotent. */
export async function markGiftPaid(db: Db, giftId: string, paymentIntentId: string | null, now = Date.now()): Promise<Gift | null> {
	const rows = (
		await db
			.prepare(`UPDATE mbr_gifts SET status = 'paid', payment_intent_id = ? WHERE id = ? AND status = 'pending' RETURNING id`)
			.bind(paymentIntentId, giftId)
			.all()
	).results;
	const gift = await getGift(db, { id: giftId });
	if (!gift || !rows.length) return gift;
	const plan = await getPlan(db, gift.planId);
	const data = { planName: plan?.name ?? "Pro", code: gift.code, days: gift.days, message: gift.message, giverName: null, recipientName: gift.recipientName, path: `?code=${encodeURIComponent(gift.code)}` };
	await enqueueEmail(db, { kind: "gift_purchased", to: gift.buyerEmail, memberId: gift.buyerMemberId, dedupeKey: `gift-buyer:${gift.id}`, data: { ...data, recipientEmail: gift.recipientEmail } }, now);
	if (gift.recipientEmail) {
		await enqueueEmail(
			db,
			{ kind: "gift_received", to: gift.recipientEmail, dedupeKey: `gift-recipient:${gift.id}`, data: { ...data, giverEmail: gift.buyerEmail }, sendAfter: Math.max(now, gift.deliverAt ?? now) },
			now,
		);
	}
	await emitEvent(db, "gift.purchased", gift.buyerMemberId, { giftId: gift.id, plan: gift.planId, days: gift.days, recipient: gift.recipientEmail }, now);
	return getGift(db, { id: giftId });
}

export type RedeemResult = { ok: true; gift: Gift; endsAt: number } | { ok: false; reason: "not_found" | "not_paid" | "already_redeemed" | "refunded" };

/** Gives the member the gift's time on its plan. One redemption per code. */
export async function redeemGift(db: Db, code: string, member: Pick<Member, "id" | "email">, opts: { proStatuses?: readonly string[]; now?: number } = {}): Promise<RedeemResult> {
	const t = opts.now ?? Date.now();
	const gift = await getGift(db, { code });
	if (!gift) return { ok: false, reason: "not_found" };
	if (gift.status === "redeemed") return { ok: false, reason: "already_redeemed" };
	if (gift.status === "refunded" || gift.status === "canceled") return { ok: false, reason: "refunded" };
	if (gift.status !== "paid") return { ok: false, reason: "not_paid" };
	const claimed = (
		await db
			.prepare(`UPDATE mbr_gifts SET status = 'redeemed', redeemed_at = ?, redeemed_member_id = ? WHERE id = ? AND status = 'paid' RETURNING id`)
			.bind(t, member.id, gift.id)
			.all()
	).results;
	if (!claimed.length) return { ok: false, reason: "already_redeemed" };
	const g = await grantProTime(db, { email: member.email, days: gift.days, plan: gift.planId, key: `gift:${gift.id}`, reason: `Gift from ${gift.buyerEmail}`, proStatuses: opts.proStatuses, now: t });
	if (!g.ok) throw new Error(`gift grant failed: ${g.reason}`);
	const plan = await getPlan(db, gift.planId);
	// A reminder before the gifted time runs out (skipped if they've subscribed by then).
	await enqueueEmail(
		db,
		{ kind: "gift_ending", to: member.email, memberId: member.id, dedupeKey: `gift-ending:${gift.id}`, data: { planName: plan?.name ?? "Pro", date: g.grant.endsAt }, sendAfter: Math.max(t, g.grant.endsAt - 5 * 86_400_000) },
		t,
	);
	await emitEvent(db, "gift.redeemed", member.id, { giftId: gift.id, plan: gift.planId, days: gift.days, endsAt: g.grant.endsAt }, t);
	return { ok: true, gift: (await getGift(db, { id: gift.id }))!, endsAt: g.grant.endsAt };
}

/** Full refund of a gift purchase: cancels it, or revokes the time if it was redeemed. */
export async function refundGift(db: Db, giftId: string, opts: { proStatuses?: readonly string[]; now?: number } = {}): Promise<void> {
	const gift = await getGift(db, { id: giftId });
	if (!gift || gift.status === "refunded") return;
	await db.prepare(`UPDATE mbr_gifts SET status = 'refunded' WHERE id = ?`).bind(giftId).run();
	await db.prepare(`UPDATE mbr_outbox SET sent_at = ?, last_error = 'skipped' WHERE dedupe_key IN (?, ?, ?) AND sent_at IS NULL`).bind(opts.now ?? Date.now(), `gift-recipient:${giftId}`, `gift-ending:${giftId}`, `gift-buyer:${giftId}`).run();
	if (gift.status === "redeemed") await revokeGrant(db, `gift:${giftId}`, opts);
}

/** Staff-made gift (no payment): a code for a giveaway or a partner. */
export async function createCompGift(db: Db, input: { planId: string; days: number; recipientEmail?: string | null; note?: string; now?: number }): Promise<Gift | null> {
	await ensureSchema(db);
	const plan = await getPlan(db, input.planId);
	if (!plan?.paid || !(input.days > 0)) return null;
	const t = input.now ?? Date.now();
	const id = `gift_${crypto.randomUUID()}`;
	await db
		.prepare(
			`INSERT INTO mbr_gifts (id, code, price_lookup_key, plan_id, days, buyer_email, recipient_email, message, status, created_at)
			 VALUES (?, ?, 'comp', ?, ?, 'staff', ?, ?, 'paid', ?)`,
		)
		.bind(id, giftCode(), plan.id, Math.floor(input.days), input.recipientEmail?.trim().toLowerCase() || null, input.note?.trim() || null, t)
		.run();
	return getGift(db, { id });
}

