/**
 * The sellable catalog, kept in step with Stripe: each paid plan is a Stripe
 * Product, each price a Stripe Price (found by its lookup key), each coupon a
 * Stripe Coupon with a customer-facing promotion code.
 *
 * Stripe Prices can't be edited, so changing an amount creates a new Price
 * that takes over the lookup key; the old one is archived and kept on record,
 * so members still subscribed to it keep their plan.
 *
 * The restricted API key needs write access to Products, Prices, Coupons and
 * Promotion Codes for these calls.
 */
import type Stripe from "stripe";
import { type Db, ensureSchema } from "./db.ts";
import {
	fallbackPaidPlan,
	getPlan,
	getPrice,
	listPlans,
	type PlanPrice,
	type PriceInput,
	savePriceRecord,
	type SavePriceResult,
	setPlanProduct,
	setPriceActive,
	validatePrice,
} from "./plans.ts";

export interface CatalogDeps {
	db: Db;
	stripe: Stripe;
	now?: number;
}

const errText = (err: unknown) => ((err as { message?: string })?.message ?? String(err)).slice(0, 300);

/** Creates or updates the Stripe Product for a paid plan. */
export async function syncPlanProduct(deps: CatalogDeps, planId: string): Promise<{ ok: true; productId: string } | { ok: false; error: string }> {
	const { db, stripe } = deps;
	const plan = await getPlan(db, planId);
	if (!plan) return { ok: false, error: "Unknown plan" };
	if (!plan.paid) return { ok: false, error: "The free plan isn't sold, so it has no Stripe product" };
	try {
		const fields = { name: plan.name, ...(plan.description && { description: plan.description }), metadata: { plan_id: plan.id } };
		const product = plan.stripeProductId
			? await stripe.products.update(plan.stripeProductId, { ...fields, active: !plan.archivedAt })
			: await stripe.products.create(fields, { idempotencyKey: `mbr-product-${plan.id}-${plan.archivedAt ?? 0}` });
		if (product.id !== plan.stripeProductId) await setPlanProduct(db, plan.id, product.id, deps.now);
		return { ok: true, productId: product.id };
	} catch (err) {
		return { ok: false, error: errText(err) };
	}
}

const sameTerms = (p: PlanPrice, i: PriceInput) =>
	p.amount === i.amount &&
	p.currency === i.currency.toLowerCase() &&
	p.kind === i.kind &&
	(p.kind === "one_time" || (p.interval === i.interval && p.intervalCount === Math.max(1, Math.floor(i.intervalCount ?? 1))));

export type CreatePriceResult = SavePriceResult | { ok: false; reason: "stripe_error"; error: string };

/**
 * Creates a price in Stripe and records it. Calling it again with the same
 * lookup key and terms only updates the local settings (trial days, early
 * access); different terms replace the Stripe Price as described above.
 */
export async function createPrice(deps: CatalogDeps, input: PriceInput): Promise<CreatePriceResult> {
	const { db, stripe } = deps;
	await ensureSchema(db);
	const now = deps.now ?? Date.now();
	const plan = await getPlan(db, input.planId);
	if (!plan) return { ok: false, reason: "unknown_plan" };
	if (!plan.paid) return { ok: false, reason: "free_plan" };
	const invalid = validatePrice(input);
	if (invalid) return invalid;
	const existing = await getPrice(db, { lookupKey: input.lookupKey });
	if (existing && existing.planId !== input.planId) return { ok: false, reason: "lookup_key_taken" };
	if (existing?.stripePriceId && sameTerms(existing, input)) {
		return savePriceRecord(db, { ...input, stripePriceId: existing.stripePriceId, active: true }, now);
	}

	const product = await syncPlanProduct(deps, plan.id);
	if (!product.ok) return { ok: false, reason: "stripe_error", error: product.error };
	let price: Stripe.Price;
	try {
		price = await stripe.prices.create({
			product: product.productId,
			currency: input.currency.toLowerCase(),
			unit_amount: input.amount,
			...(input.kind === "recurring" && { recurring: { interval: input.interval!, interval_count: Math.max(1, Math.floor(input.intervalCount ?? 1)) } }),
			lookup_key: input.lookupKey,
			transfer_lookup_key: true,
			metadata: { plan_id: plan.id, ...(input.grantsEarlyAccess && { grants_early_access: "true" }) },
		});
	} catch (err) {
		return { ok: false, reason: "stripe_error", error: errText(err) };
	}
	if (existing) {
		// Keep the old price on record under a retired key, so its subscribers keep mapping to the plan.
		const retired = `${existing.lookupKey}~${(existing.stripePriceId ?? existing.id).slice(-8)}`;
		await db
			.prepare(`UPDATE mbr_prices SET lookup_key = ?, active = 0, updated_at = ? WHERE id = ?`)
			.bind(retired, now, existing.id)
			.run();
		if (existing.stripePriceId) await stripe.prices.update(existing.stripePriceId, { active: false }).catch(() => {});
	}
	return savePriceRecord(db, { ...input, stripePriceId: price.id, active: true }, now);
}

/** Stops selling a price. Existing subscriptions on it continue. */
export async function archivePrice(deps: CatalogDeps, lookupKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const price = await getPrice(deps.db, { lookupKey });
	if (!price) return { ok: false, error: "Unknown price" };
	try {
		if (price.stripePriceId) await deps.stripe.prices.update(price.stripePriceId, { active: false });
	} catch (err) {
		return { ok: false, error: errText(err) };
	}
	await setPriceActive(deps.db, lookupKey, false, deps.now);
	return { ok: true };
}

export interface PriceSettings {
	trialDays?: number;
	grantsEarlyAccess?: boolean;
	maxMembers?: number | null;
	availableUntil?: number | null;
	giftDays?: number;
	perSeat?: boolean;
}

/** Local-only price settings that don't change the Stripe Price. */
export async function updatePriceSettings(db: Db, lookupKey: string, s: PriceSettings, now = Date.now()) {
	const p = await getPrice(db, { lookupKey });
	if (!p) return false;
	const once = p.kind === "one_time";
	const gift = once ? Math.max(0, Math.floor(s.giftDays ?? p.giftDays)) : 0;
	const max = s.maxMembers === undefined ? p.maxMembers : s.maxMembers && s.maxMembers > 0 ? Math.floor(s.maxMembers) : null;
	await db
		.prepare(
			`UPDATE mbr_prices SET trial_days = ?, grants_early_access = ?, max_members = ?, available_until = ?, gift_days = ?, per_seat = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(
			once ? 0 : Math.max(0, Math.floor(s.trialDays ?? p.trialDays)),
			once && !gift && (s.grantsEarlyAccess ?? p.grantsEarlyAccess) ? 1 : 0,
			max,
			s.availableUntil === undefined ? p.availableUntil : s.availableUntil,
			gift,
			!once && (s.perSeat ?? p.perSeat) ? 1 : 0,
			now,
			p.id,
		)
		.run();
	return true;
}

export interface ImportResult {
	imported: { lookupKey: string; planId: string }[];
	skipped: { lookupKey: string | null; reason: string }[];
}

/**
 * Records active Stripe Prices that have a lookup key and aren't known yet,
 * e.g. ones created by a script before this plugin managed the catalog. The
 * plan comes from the Product's `plan_id` metadata, then `opts.planFor`, then
 * the fallback paid plan ("pro").
 */
export async function importStripePrices(
	deps: CatalogDeps,
	opts: { planFor?: (price: Stripe.Price) => string | undefined; earlyAccessLookupKeys?: readonly string[] } = {},
): Promise<ImportResult> {
	const { db, stripe } = deps;
	await ensureSchema(db);
	const result: ImportResult = { imported: [], skipped: [] };
	const plans = new Set((await listPlans(db, { includeArchived: true })).map((p) => p.id));
	const fallback = await fallbackPaidPlan(db);
	for await (const p of stripe.prices.list({ active: true, limit: 100, expand: ["data.product"] })) {
		if (!p.lookup_key) {
			result.skipped.push({ lookupKey: null, reason: `${p.id} has no lookup key` });
			continue;
		}
		const known = await getPrice(db, { lookupKey: p.lookup_key });
		if (known?.stripePriceId === p.id) continue;
		const product = typeof p.product === "object" && !("deleted" in p.product && p.product.deleted) ? (p.product as Stripe.Product) : null;
		const wanted = product?.metadata?.plan_id || opts.planFor?.(p) || fallback;
		const planId = plans.has(wanted) ? wanted : fallback;
		if (p.unit_amount == null) {
			result.skipped.push({ lookupKey: p.lookup_key, reason: "not a fixed-amount price" });
			continue;
		}
		const saved = await savePriceRecord(
			db,
			{
				planId,
				lookupKey: p.lookup_key,
				stripePriceId: p.id,
				kind: p.type === "recurring" ? "recurring" : "one_time",
				amount: p.unit_amount,
				currency: p.currency,
				interval: p.recurring?.interval === "year" ? "year" : p.recurring?.interval === "month" ? "month" : null,
				intervalCount: p.recurring?.interval_count ?? 1,
				trialDays: known?.trialDays ?? p.recurring?.trial_period_days ?? 0,
				grantsEarlyAccess: p.metadata?.grants_early_access === "true" || !!opts.earlyAccessLookupKeys?.includes(p.lookup_key) || !!known?.grantsEarlyAccess,
			},
			deps.now,
		);
		if (!saved.ok) {
			result.skipped.push({ lookupKey: p.lookup_key, reason: saved.reason });
			continue;
		}
		if (product && !(await getPlan(db, planId))?.stripeProductId) await setPlanProduct(db, planId, product.id, deps.now);
		result.imported.push({ lookupKey: p.lookup_key, planId });
	}
	return result;
}

// ─────────────────────────────── coupons ───────────────────────────────

export interface Coupon {
	id: string;
	/** What customers type at checkout */
	code: string;
	percentOff: number | null;
	amountOff: number | null;
	currency: string | null;
	duration: "once" | "repeating" | "forever";
	durationMonths: number | null;
	maxRedemptions: number | null;
	expiresAt: number | null;
	firstTimeOnly: boolean;
	timesRedeemed: number;
	active: boolean;
	stripeCouponId: string | null;
	stripePromotionCodeId: string | null;
	createdAt: number;
}

export interface CouponInput {
	code: string;
	percentOff?: number;
	/** In the smallest currency unit */
	amountOff?: number;
	currency?: string;
	duration: "once" | "repeating" | "forever";
	durationMonths?: number;
	maxRedemptions?: number;
	expiresAt?: number;
	firstTimeOnly?: boolean;
}

interface CouponRow {
	id: string;
	code: string;
	stripe_coupon_id: string | null;
	stripe_promotion_code_id: string | null;
	percent_off: number | null;
	amount_off: number | null;
	currency: string | null;
	duration: string;
	duration_months: number | null;
	max_redemptions: number | null;
	expires_at: number | null;
	first_time_only: number;
	times_redeemed: number;
	active: number;
	created_at: number;
}

const toCoupon = (r: CouponRow): Coupon => ({
	id: r.id,
	code: r.code,
	percentOff: r.percent_off,
	amountOff: r.amount_off,
	currency: r.currency,
	duration: r.duration === "repeating" ? "repeating" : r.duration === "forever" ? "forever" : "once",
	durationMonths: r.duration_months,
	maxRedemptions: r.max_redemptions,
	expiresAt: r.expires_at,
	firstTimeOnly: !!r.first_time_only,
	timesRedeemed: r.times_redeemed,
	active: !!r.active,
	stripeCouponId: r.stripe_coupon_id,
	stripePromotionCodeId: r.stripe_promotion_code_id,
	createdAt: r.created_at,
});

export async function listCoupons(db: Db): Promise<Coupon[]> {
	await ensureSchema(db);
	const { results } = await db.prepare(`SELECT * FROM mbr_coupons ORDER BY active DESC, created_at DESC`).all<CouponRow>();
	return results.map(toCoupon);
}

export type CreateCouponResult =
	| { ok: true; coupon: Coupon }
	| { ok: false; reason: "invalid_code" | "code_taken" | "invalid_discount" | "invalid_duration" | "stripe_error"; error?: string };

/** Creates a Stripe Coupon and a promotion code customers can enter at checkout. */
export async function createCoupon(deps: CatalogDeps, input: CouponInput): Promise<CreateCouponResult> {
	const { db, stripe } = deps;
	await ensureSchema(db);
	const now = deps.now ?? Date.now();
	const code = input.code.trim().toUpperCase();
	if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return { ok: false, reason: "invalid_code" };
	const pct = input.percentOff;
	const amt = input.amountOff;
	const byPct = pct !== undefined && Number.isFinite(pct) && pct > 0 && pct <= 100;
	const byAmt = amt !== undefined && Number.isInteger(amt) && amt > 0 && /^[a-z]{3}$/i.test(input.currency ?? "");
	if (byPct === byAmt) return { ok: false, reason: "invalid_discount" };
	const months = Math.floor(input.durationMonths ?? 0);
	if (input.duration === "repeating" && !(months >= 1 && months <= 36)) return { ok: false, reason: "invalid_duration" };
	if (await db.prepare(`SELECT 1 FROM mbr_coupons WHERE code = ?`).bind(code).first()) return { ok: false, reason: "code_taken" };

	let promo: Stripe.PromotionCode;
	let coupon: Stripe.Coupon;
	try {
		coupon = await stripe.coupons.create(
			{
				name: code,
				...(byPct ? { percent_off: pct } : { amount_off: amt, currency: input.currency!.toLowerCase() }),
				duration: input.duration,
				...(input.duration === "repeating" && { duration_in_months: months }),
			},
			{ idempotencyKey: `mbr-coupon-${code}` },
		);
		promo = await stripe.promotionCodes.create(
			{
				promotion: { type: "coupon", coupon: coupon.id },
				code,
				...(input.maxRedemptions && input.maxRedemptions > 0 && { max_redemptions: Math.floor(input.maxRedemptions) }),
				...(input.expiresAt && { expires_at: Math.floor(input.expiresAt / 1000) }),
				...(input.firstTimeOnly && { restrictions: { first_time_transaction: true } }),
			},
			{ idempotencyKey: `mbr-promo-${code}` },
		);
	} catch (err) {
		return { ok: false, reason: "stripe_error", error: errText(err) };
	}
	await db
		.prepare(
			`INSERT INTO mbr_coupons (id, code, stripe_coupon_id, stripe_promotion_code_id, percent_off, amount_off, currency, duration,
				duration_months, max_redemptions, expires_at, first_time_only, active, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
		)
		.bind(
			`cpn_${crypto.randomUUID()}`,
			code,
			coupon.id,
			promo.id,
			byPct ? pct : null,
			byAmt ? amt : null,
			byAmt ? input.currency!.toLowerCase() : null,
			input.duration,
			input.duration === "repeating" ? months : null,
			input.maxRedemptions && input.maxRedemptions > 0 ? Math.floor(input.maxRedemptions) : null,
			input.expiresAt ?? null,
			input.firstTimeOnly ? 1 : 0,
			now,
		)
		.run();
	const row = await db.prepare(`SELECT * FROM mbr_coupons WHERE code = ?`).bind(code).first<CouponRow>();
	return { ok: true, coupon: toCoupon(row!) };
}

/** Stops a code from being redeemed. Discounts already applied continue. */
export async function deactivateCoupon(deps: CatalogDeps, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const row = await deps.db.prepare(`SELECT * FROM mbr_coupons WHERE id = ?`).bind(id).first<CouponRow>();
	if (!row) return { ok: false, error: "Unknown coupon" };
	try {
		if (row.stripe_promotion_code_id) await deps.stripe.promotionCodes.update(row.stripe_promotion_code_id, { active: false });
	} catch (err) {
		return { ok: false, error: errText(err) };
	}
	await deps.db.prepare(`UPDATE mbr_coupons SET active = 0 WHERE id = ?`).bind(id).run();
	return { ok: true };
}

/** Pulls redemption counts and active state from Stripe for the admin. */
export async function refreshCoupons(deps: CatalogDeps): Promise<number> {
	const coupons = (await listCoupons(deps.db)).filter((c) => c.stripePromotionCodeId);
	let n = 0;
	for (const c of coupons) {
		try {
			const p = await deps.stripe.promotionCodes.retrieve(c.stripePromotionCodeId!);
			await deps.db.prepare(`UPDATE mbr_coupons SET times_redeemed = ?, active = ? WHERE id = ?`).bind(p.times_redeemed, p.active ? 1 : 0, c.id).run();
			n++;
		} catch {
			/* leave it as it was */
		}
	}
	return n;
}

/** True when any active promotion code exists, so checkout should show the code field. */
export async function hasActiveCoupons(db: Db, now = Date.now()): Promise<boolean> {
	await ensureSchema(db);
	return !!(await db.prepare(`SELECT 1 FROM mbr_coupons WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`).bind(now).first());
}
