import assert from "node:assert/strict";
import { test } from "node:test";
import {
	archivePrice,
	createCoupon,
	createPrice,
	deactivateCoupon,
	hasActiveCoupons,
	importStripePrices,
	listCoupons,
	refreshCoupons,
	syncPlanProduct,
	updatePriceSettings,
} from "../src/catalog.ts";
import { ensureSchema } from "../src/db.ts";
import { getPlan, getPrice, listPrices, resolveAccess, savePlan } from "../src/plans.ts";
import { fakeStripe } from "./fake-stripe.ts";
import { sqliteDb } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 9, 12);

async function setup() {
	const db = sqliteDb();
	await ensureSchema(db);
	const f = fakeStripe();
	return { db, f, deps: { db, stripe: f.client, now: T0 } };
}

test("a plan becomes a Stripe product, created once and then updated", async () => {
	const { db, f, deps } = await setup();
	assert.deepEqual(await syncPlanProduct(deps, "free"), { ok: false, error: "The free plan isn't sold, so it has no Stripe product" });
	const first = await syncPlanProduct(deps, "pro");
	assert.ok(first.ok);
	assert.equal((await getPlan(db, "pro"))?.stripeProductId, first.productId);
	await savePlan(db, { id: "pro", name: "Pro+", description: "Everything" });
	const second = await syncPlanProduct(deps, "pro");
	assert.ok(second.ok);
	assert.equal(second.productId, first.productId);
	assert.equal(f.products.get(first.productId)?.name, "Pro+");
	assert.equal(f.products.get(first.productId)?.metadata.plan_id, "pro");
});

test("createPrice creates a Stripe price with a lookup key; new terms replace it and keep the old one on record", async () => {
	const { db, f, deps } = await setup();
	const r = await createPrice(deps, { planId: "pro", lookupKey: "pro_monthly", kind: "recurring", amount: 900, currency: "usd", interval: "month", trialDays: 7 });
	assert.ok(r.ok);
	const sp = f.prices.get(r.price.stripePriceId!);
	assert.equal(sp?.unit_amount, 900);
	assert.equal(sp?.lookup_key, "pro_monthly");
	assert.deepEqual(sp?.recurring, { interval: "month", interval_count: 1, trial_period_days: null });

	// Same terms: local settings only, no new Stripe price
	const before = f.prices.size;
	const same = await createPrice(deps, { planId: "pro", lookupKey: "pro_monthly", kind: "recurring", amount: 900, currency: "USD", interval: "month", trialDays: 14 });
	assert.ok(same.ok);
	assert.equal(f.prices.size, before);
	assert.equal(same.price.trialDays, 14);

	// New amount: new Stripe price takes the key, old one archived and retired locally
	const raised = await createPrice(deps, { planId: "pro", lookupKey: "pro_monthly", kind: "recurring", amount: 1200, currency: "usd", interval: "month" });
	assert.ok(raised.ok);
	assert.notEqual(raised.price.stripePriceId, r.price.stripePriceId);
	assert.equal(f.prices.get(r.price.stripePriceId!)?.active, false);
	assert.equal(f.prices.get(r.price.stripePriceId!)?.lookup_key, null);
	const all = await listPrices(db);
	assert.equal(all.length, 2);
	const retired = all.find((p) => p.stripePriceId === r.price.stripePriceId)!;
	assert.match(retired.lookupKey, /^pro_monthly~/);
	assert.equal(retired.active, false);

	// A member still on the old price keeps the plan
	await savePlan(db, { id: "team", name: "Team", entitlements: ["seats"] });
	const t = await createPrice(deps, { planId: "team", lookupKey: "team_monthly", kind: "recurring", amount: 2900, currency: "usd", interval: "month" });
	assert.ok(t.ok);
	await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('m', 'm@example.com', 'free', ?)`).bind(T0).run();
	await db
		.prepare(`INSERT INTO mbr_subscriptions (id, member_id, status, price_id, lookup_key, updated_at) VALUES ('s', 'm', 'active', ?, NULL, ?)`)
		.bind(r.price.stripePriceId, T0)
		.run();
	assert.deepEqual((await resolveAccess(db, "m", { now: T0 })).plans, ["pro"]);

	// Errors: wrong plan for a key, free plan, Stripe failure
	assert.deepEqual(await createPrice(deps, { planId: "team", lookupKey: "pro_monthly", kind: "recurring", amount: 1, currency: "usd", interval: "month" }), {
		ok: false,
		reason: "lookup_key_taken",
	});
	assert.deepEqual(await createPrice(deps, { planId: "free", lookupKey: "x", kind: "one_time", amount: 1, currency: "usd" }), { ok: false, reason: "free_plan" });
	f.failNext = "prices.create";
	const failed = await createPrice(deps, { planId: "pro", lookupKey: "pro_annual", kind: "recurring", amount: 9000, currency: "usd", interval: "year" });
	assert.equal(failed.ok, false);
	assert.equal(!failed.ok && failed.reason, "stripe_error");
	assert.equal(await getPrice(db, { lookupKey: "pro_annual" }), null, "nothing recorded when Stripe fails");
});

test("archivePrice and updatePriceSettings", async () => {
	const { db, f, deps } = await setup();
	const r = await createPrice(deps, { planId: "pro", lookupKey: "early", kind: "one_time", amount: 100, currency: "usd" });
	assert.ok(r.ok);
	assert.equal(await updatePriceSettings(db, "early", { grantsEarlyAccess: true, trialDays: 30 }), true);
	const p = await getPrice(db, { lookupKey: "early" });
	assert.equal(p?.grantsEarlyAccess, true);
	assert.equal(p?.trialDays, 0, "no trials on one-time prices");
	assert.deepEqual(await archivePrice(deps, "early"), { ok: true });
	assert.equal(f.prices.get(r.price.stripePriceId!)?.active, false);
	assert.equal((await getPrice(db, { lookupKey: "early" }))?.active, false);
	assert.equal(await updatePriceSettings(db, "nope", {}), false);
});

test("importStripePrices records existing lookup-key prices once, mapping plans from product metadata", async () => {
	const { db, f, deps } = await setup();
	await savePlan(db, { id: "team", name: "Team" });
	const proProduct = await f.client.products.create({ name: "Pro" });
	const teamProduct = await f.client.products.create({ name: "Team", metadata: { plan_id: "team" } });
	await f.client.prices.create({ product: proProduct.id, currency: "usd", unit_amount: 900, recurring: { interval: "month" }, lookup_key: "pro_monthly" });
	await f.client.prices.create({ product: proProduct.id, currency: "usd", unit_amount: 100, lookup_key: "early_access" });
	await f.client.prices.create({ product: teamProduct.id, currency: "usd", unit_amount: 2900, recurring: { interval: "month" }, lookup_key: "team_monthly" });
	await f.client.prices.create({ product: proProduct.id, currency: "usd", unit_amount: 500 });

	const r = await importStripePrices(deps, { earlyAccessLookupKeys: ["early_access"] });
	assert.deepEqual(
		r.imported.map((i) => `${i.lookupKey}:${i.planId}`).sort(),
		["early_access:pro", "pro_monthly:pro", "team_monthly:team"],
	);
	assert.equal(r.skipped.length, 1);
	assert.equal((await getPrice(db, { lookupKey: "early_access" }))?.grantsEarlyAccess, true);
	assert.equal((await getPrice(db, { lookupKey: "pro_monthly" }))?.interval, "month");
	assert.equal((await getPlan(db, "pro"))?.stripeProductId, proProduct.id);

	const again = await importStripePrices(deps);
	assert.equal(again.imported.length, 0, "already-known prices are skipped");
});

test("coupons become Stripe promotion codes", async () => {
	const { db, f, deps } = await setup();
	assert.equal(await hasActiveCoupons(db, T0), false);
	assert.deepEqual(await createCoupon(deps, { code: "x", percentOff: 10, duration: "once" }), { ok: false, reason: "invalid_code" });
	assert.deepEqual(await createCoupon(deps, { code: "BOTH", percentOff: 10, amountOff: 100, currency: "usd", duration: "once" }), { ok: false, reason: "invalid_discount" });
	assert.deepEqual(await createCoupon(deps, { code: "NONE", duration: "once" }), { ok: false, reason: "invalid_discount" });
	assert.deepEqual(await createCoupon(deps, { code: "REP", percentOff: 10, duration: "repeating" }), { ok: false, reason: "invalid_duration" });

	const r = await createCoupon(deps, { code: "launch25", percentOff: 25, duration: "repeating", durationMonths: 3, maxRedemptions: 100, firstTimeOnly: true, expiresAt: T0 + 86_400_000 });
	assert.ok(r.ok);
	assert.equal(r.coupon.code, "LAUNCH25");
	const promo = f.promos.get(r.coupon.stripePromotionCodeId!);
	assert.deepEqual(promo?.promotion, { type: "coupon", coupon: r.coupon.stripeCouponId });
	assert.equal(promo?.max_redemptions, 100);
	assert.deepEqual(promo?.restrictions, { first_time_transaction: true });
	assert.equal(f.coupons.get(r.coupon.stripeCouponId!)?.duration_in_months, 3);
	assert.equal(await hasActiveCoupons(db, T0), true);
	assert.deepEqual(await createCoupon(deps, { code: "LAUNCH25", percentOff: 5, duration: "once" }), { ok: false, reason: "code_taken" });

	const flat = await createCoupon(deps, { code: "FIVEOFF", amountOff: 500, currency: "USD", duration: "once" });
	assert.ok(flat.ok);
	assert.equal(f.coupons.get(flat.coupon.stripeCouponId!)?.currency, "usd");

	promo!.times_redeemed = 7;
	assert.equal(await refreshCoupons(deps), 2);
	assert.equal((await listCoupons(db)).find((c) => c.code === "LAUNCH25")?.timesRedeemed, 7);

	assert.deepEqual(await deactivateCoupon(deps, r.coupon.id), { ok: true });
	assert.equal(f.promos.get(r.coupon.stripePromotionCodeId!)?.active, false);
	assert.equal((await listCoupons(db)).find((c) => c.code === "LAUNCH25")?.active, false);
});
